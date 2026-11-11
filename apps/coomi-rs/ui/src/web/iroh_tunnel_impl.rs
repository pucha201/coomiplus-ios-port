//! iroh 传输层：把现有 HTTP/WS 引擎通过 QUIC 隧道暴露给已配对设备。
//!
//! 设计目标：
//! - 不重写现有 HTTP/WS 协议：隧道只做 TCP-over-QUIC 字节转发；
//! - 宿主端按 EndpointAddr 接受连接，先用配对 token 做一次握手校验，
//!   再把请求转发到本地引擎，并把 Authorization 换成宿主引擎 token；
//! - 客户端在本地起一个 `127.0.0.1:<随机端口>` 代理，WebView 把 engineBase
//!   指向它即可；WebRTC/MQTT 不再参与主链路。
//!
//! 这样手机/桌面各自的 Rust 引擎负责 NAT 穿透、relay 和重连，WebView 仍然
//! 只看到普通 HTTP/WS。

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use iroh::Endpoint;
use iroh::endpoint::presets;
use iroh::EndpointAddr;
use iroh::SecretKey;
use iroh::endpoint::Connection;
use iroh::endpoint::RecvStream;
use iroh::endpoint::SendStream;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;

use crate::web::AppState;

const ALPN: &[u8] = b"coomi/iroh-tunnel/1";
const MAX_HANDSHAKE_BYTES: usize = 512;
const MAX_HTTP_HEAD_BYTES: usize = 64 * 1024;
/// 隧道存活期间给对端续命（桌面在线判据窗口是 300s）。
const PEER_HEARTBEAT: Duration = Duration::from_secs(60);

struct ClientProxy {
    addr: EndpointAddr,
    token: String,
    base: String,
    task: tokio::task::JoinHandle<()>,
}

/// 一轮连接尝试的地址与超时。
/// 第一段用配对码里的快照（局域网/当时的中继，3 秒）；失败后按 EndpointId
/// 重新发现（pkarr DNS 会给出对端**当前**的中继与直连地址，8 秒）。
const SNAPSHOT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REDISCOVER_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// 每个 peer 最后一次连通的地址。桌面重启后先试它，不用每条新流都白等一次
/// 快照超时（快照是配对那一刻的地址，可能早就过期了）。
fn peer_addrs_path(home: &Path) -> PathBuf {
    home.join("config").join("iroh-peers.json")
}

fn load_peer_addrs(home: &Path) -> serde_json::Map<String, Value> {
    std::fs::read(peer_addrs_path(home))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn load_peer_addr(home: &Path, id: &iroh::EndpointId) -> Option<EndpointAddr> {
    let map = load_peer_addrs(home);
    let value = map.get(&id.to_string())?.clone();
    serde_json::from_value(value).ok()
}

/// 落盘最后一个可用地址；同一地址不重复写（每条流成功都写会变成写放大）。
fn save_peer_addr(home: &Path, addr: &EndpointAddr) {
    let Ok(value) = serde_json::to_value(addr) else {
        return;
    };
    let mut map = load_peer_addrs(home);
    let key = addr.id.to_string();
    if map.get(&key) == Some(&value) {
        return;
    }
    map.insert(key, value);
    let path = peer_addrs_path(home);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&Value::Object(map)) {
        let _ = std::fs::write(path, bytes);
    }
}

pub(crate) struct IrohNode {
    endpoint: Endpoint,
    home: PathBuf,
    engine_token: String,
    engine_port: u16,
    proxy: AsyncMutex<Option<ClientProxy>>,
    /// 与 HTTP 鉴权共用的配对状态（同一份内存 + 同一个 revision）。
    pairing: Arc<crate::web::api::pairing::PairingState>,
    /// 中继是否真的连上了（endpoint.online 成功）。
    /// 二维码里的 mode 只表示「地址里有中继字段」，不代表可达；
    /// 这里才是手机能不能跨网的判据。
    relay_ready: std::sync::atomic::AtomicBool,
}

static NODE: OnceLock<Arc<IrohNode>> = OnceLock::new();
static START_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

fn iroh_disabled() -> bool {
    std::env::var("COOMI_DISABLE_IROH")
        .map(|value| !value.trim().is_empty() && value != "0")
        .unwrap_or(false)
}

fn load_or_create_secret(home: &Path) -> Result<SecretKey> {
    let path = home.join("config").join("iroh.key");
    if let Ok(bytes) = std::fs::read(&path)
        && bytes.len() == 32
    {
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Ok(SecretKey::from_bytes(&key));
    }
    let secret = SecretKey::generate();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, secret.to_bytes())
        .with_context(|| format!("写入 iroh 身份失败：{}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(secret)
}

/// iroh 中继配置：默认 n0 公共中继；`COOMI_IROH_RELAY` 可换成自建中继
/// （逗号分隔的 HTTPS URL，例如 `https://relay.example.com`）。
fn relay_mode() -> iroh::RelayMode {
    let Some(value) = std::env::var("COOMI_IROH_RELAY").ok().filter(|v| !v.trim().is_empty()) else {
        return iroh::RelayMode::Default;
    };
    let urls = value
        .split(',')
        .filter_map(|part| part.trim().parse::<iroh::RelayUrl>().ok())
        .collect::<Vec<_>>();
    if urls.is_empty() {
        eprintln!("[iroh] COOMI_IROH_RELAY 没有可用的中继 URL，回落到 n0 公共中继");
        iroh::RelayMode::Default
    } else {
        iroh::RelayMode::custom(urls)
    }
}

/// 启动（或复用）本进程的 iroh Endpoint。启动失败不会影响原有 LAN/中转链路。
pub(crate) async fn ensure_started(state: AppState) -> Result<Arc<IrohNode>> {
    if let Some(node) = NODE.get() {
        return Ok(node.clone());
    }
    if iroh_disabled() {
        bail!("iroh 已被 COOMI_DISABLE_IROH 禁用");
    }
    if state.token.trim().is_empty() {
        bail!("引擎 token 为空，拒绝启动 iroh 隧道");
    }
    let _guard = START_LOCK.lock().await;
    if let Some(node) = NODE.get() {
        return Ok(node.clone());
    }
    let secret = load_or_create_secret(&state.home)?;
    let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
        .relay_mode(relay_mode())
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|error| anyhow::anyhow!("iroh Endpoint 绑定失败：{error}"))?;
    // 尽量等 home relay 就绪再生成配对码；离线/被墙时也继续（局域网直连仍可用），
    // 但要把「没就绪」如实告诉手机，而不是让二维码谎报 mode: relay。
    let relay_ready = tokio::time::timeout(Duration::from_secs(6), endpoint.online())
        .await
        .is_ok();
    let node = Arc::new(IrohNode {
        endpoint: endpoint.clone(),
        home: state.home.clone(),
        engine_token: state.token.clone(),
        engine_port: state.port,
        proxy: AsyncMutex::new(None),
        pairing: state.pairing.clone(),
        relay_ready: std::sync::atomic::AtomicBool::new(relay_ready),
    });
    let accept_node = node.clone();
    let accept_endpoint = endpoint.clone();
    tokio::spawn(async move {
        accept_loop(accept_node, accept_endpoint).await;
    });
    // 中继晚到：6 秒没连上不代表永远连不上（DNS/pkarr 可能慢）。
    // 后台继续等，连上后把 relay_ready 翻开，后续生成的配对码就是 relay。
    if !node.relay_ready.load(std::sync::atomic::Ordering::Relaxed) {
        let weak = Arc::downgrade(&node);
        let probe = endpoint.clone();
        tokio::spawn(async move {
            if tokio::time::timeout(Duration::from_secs(180), probe.online())
                .await
                .is_ok()
                && let Some(node) = weak.upgrade()
            {
                node.relay_ready
                    .store(true, std::sync::atomic::Ordering::Relaxed);
            }
        });
    }
    let _ = NODE.set(node.clone());
    Ok(node)
}

async fn accept_loop(node: Arc<IrohNode>, endpoint: Endpoint) {
    while let Some(incoming) = endpoint.accept().await {
        let node = node.clone();
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(conn) => conn,
                Err(error) => {
                    eprintln!("[iroh] incoming handshake failed: {error}");
                    return;
                }
            };
            serve_connection(node, conn).await;
        });
    }
}

async fn serve_connection(node: Arc<IrohNode>, conn: Connection) {
    loop {
        let (send, recv) = match conn.accept_bi().await {
            Ok(streams) => streams,
            Err(_) => break,
        };
        let node = node.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_bi_stream(node, send, recv).await {
                eprintln!("[iroh] stream proxy failed: {error:#}");
            }
        });
    }
}

async fn serve_bi_stream(
    node: Arc<IrohNode>,
    mut send: SendStream,
    mut recv: RecvStream,
) -> Result<()> {
    let handshake = read_line(&mut recv, MAX_HANDSHAKE_BYTES)
        .await
        .context("读取 iroh 握手失败")?;
    let mut parts = handshake.split_whitespace();
    if parts.next() != Some("COOMI-IROH") || parts.next() != Some("1") {
        bail!("iroh 握手格式不正确");
    }
    let token = parts.next().unwrap_or_default();
    let Some(peer_id) =
        crate::web::api::pairing::validate_iroh_token(&node.pairing, token).await
    else {
        bail!("iroh 配对 token 无效或已过期");
    };
    let (head, rest) = read_http_head(&mut recv).await?;
    let rewritten = rewrite_http_head(&head, &node.engine_token, node.engine_port)?;
    let mut tcp = TcpStream::connect(("127.0.0.1", node.engine_port))
        .await
        .context("连接本地引擎失败")?;
    tcp.write_all(&rewritten).await?;
    if !rest.is_empty() {
        tcp.write_all(&rest).await?;
    }
    // WebSocket 只会开一条流并持续几分钟到几小时：期间没有新的握手，
    // 对端的 last_seen 不刷新，桌面端就会把正在用的手机判成离线。
    let heartbeat = {
        let pairing = node.pairing.clone();
        let peer_id = peer_id.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(PEER_HEARTBEAT).await;
                if !crate::web::api::pairing::touch_peer_seen(&pairing, &peer_id).await {
                    break;
                }
            }
        })
    };
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let client_to_engine = async {
        tokio::io::copy(&mut recv, &mut tcp_write).await
    };
    let engine_to_client = async {
        tokio::io::copy(&mut tcp_read, &mut send).await
    };
    let _ = tokio::try_join!(client_to_engine, engine_to_client);
    heartbeat.abort();
    let _ = send.finish();
    Ok(())
}

async fn read_line(recv: &mut RecvStream, max: usize) -> Result<String> {
    let mut out = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let Some(read) = recv.read(&mut byte).await? else {
            bail!("连接在握手前关闭");
        };
        if read == 0 {
            bail!("连接在握手前关闭");
        }
        out.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
        if out.len() > max {
            bail!("握手行过长");
        }
    }
    Ok(String::from_utf8_lossy(&out)
        .trim_end_matches(['\r', '\n'])
        .to_owned())
}

async fn read_http_head(recv: &mut RecvStream) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut head = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let Some(read) = recv.read(&mut chunk).await? else {
            bail!("连接在 HTTP 请求头前关闭");
        };
        if read == 0 {
            bail!("连接在 HTTP 请求头前关闭");
        }
        head.extend_from_slice(&chunk[..read]);
        if let Some(position) = find_subslice(&head, b"\r\n\r\n") {
            let rest = head.split_off(position + 4);
            return Ok((head, rest));
        }
        if head.len() > MAX_HTTP_HEAD_BYTES {
            bail!("HTTP 请求头过大");
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// 宿主侧把浏览器的配对 Authorization 换成宿主引擎 token。
/// WebSocket 升级头必须保留；普通 HTTP 强制 `Connection: close`，每个请求一条隧道流。
fn rewrite_http_head(head: &[u8], engine_token: &str, engine_port: u16) -> Result<Vec<u8>> {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n").filter(|line| !line.is_empty());
    let request_line = lines.next().context("HTTP 请求缺少请求行")?;
    if !request_line.starts_with("GET ")
        && !request_line.starts_with("POST ")
        && !request_line.starts_with("PUT ")
        && !request_line.starts_with("DELETE ")
        && !request_line.starts_with("PATCH ")
        && !request_line.starts_with("OPTIONS ")
        && !request_line.starts_with("HEAD ")
    {
        bail!("不支持的 HTTP 请求行：{request_line}");
    }
    let mut out = vec![request_line.to_owned()];
    let mut websocket = false;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("connection:") && lower.contains("upgrade") {
            websocket = true;
        }
        if lower.starts_with("authorization:")
            || lower.starts_with("proxy-authorization:")
            || lower.starts_with("host:")
            || (!websocket && (lower.starts_with("connection:") || lower.starts_with("keep-alive:")))
        {
            continue;
        }
        out.push(line.to_owned());
    }
    // Upgrade 可能出现在 Connection 之后；再扫一遍保证识别。
    if !websocket {
        websocket = out
            .iter()
            .any(|line| line.to_ascii_lowercase().starts_with("upgrade:"));
    }
    out.push(format!("Host: 127.0.0.1:{engine_port}"));
    out.push(format!("Authorization: Bearer {engine_token}"));
    if !websocket {
        out.push("Connection: close".to_owned());
    }
    let mut result = out.join("\r\n").into_bytes();
    result.extend_from_slice(b"\r\n\r\n");
    Ok(result)
}

impl IrohNode {
    pub fn local_endpoint_json(&self) -> Value {
        let addr = self.endpoint.addr();
        // 把中继是否存在一起下发给手机：配对那一刻还没连上 relay 时，
        // 二维码里只有局域网直连地址，跨网必然失败 —— 让手机当场就能说清楚。
        let relay = addr
            .addrs
            .iter()
            .filter_map(|item| match item {
                iroh::TransportAddr::Relay(url) => Some(url.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let ready = self
            .relay_ready
            .load(std::sync::atomic::Ordering::Relaxed);
        json!({
            "id": addr.id.to_string(),
            "addr": addr,
            "relay": relay,
            // relayReady：中继真的连上了。false 时手机要当场提示「先别跨网」，
            // 而不是等 20 秒超时再猜原因。
            "relayReady": ready,
            "mode": if relay.is_empty() {
                "direct"
            } else if ready {
                "relay"
            } else {
                "relay_pending"
            },
        })
    }

    async fn connect(&self, addr: EndpointAddr, token: String) -> Result<String> {
        let mut guard = self.proxy.lock().await;
        if let Some(existing) = guard.as_ref()
            && existing.addr == addr
            && existing.token == token
        {
            return Ok(existing.base.clone());
        }
        if let Some(old) = guard.take() {
            old.task.abort();
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .context("绑定 iroh 本地代理失败")?;
        let port = listener
            .local_addr()
            .context("读取 iroh 代理端口失败")?
            .port();
        let endpoint = self.endpoint.clone();
        let task_addr = addr.clone();
        let task_token = token.clone();
        // 当前生效的地址：进程内记一份，同时以上次——**包括上次进程**——连通的
        // 地址起步。只靠进程内变量的话，桌面重启后每条新流都要先白等一次快照超时。
        let seeded = load_peer_addr(&self.home, &addr.id).unwrap_or_else(|| addr.clone());
        let best_addr = Arc::new(AsyncMutex::new(seeded));
        let home = self.home.clone();
        let task = tokio::spawn(async move {
            let token = task_token;
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    break;
                };
                let endpoint = endpoint.clone();
                let addr = best_addr.lock().await.clone();
                let best_addr = Arc::clone(&best_addr);
                let token = token.clone();
                let home = home.clone();
                tokio::spawn(async move {
                    if let Err(error) =
                        proxy_tcp_stream(endpoint, addr, best_addr, token, home, tcp).await
                    {
                        eprintln!("[iroh] client proxy stream failed: {error:#}");
                    }
                });
            }
        });
        let base = format!("http://127.0.0.1:{port}");
        *guard = Some(ClientProxy {
            addr,
            token,
            base: base.clone(),
            task,
        });
        Ok(base)
    }
}

/// 两段连接：先试快照地址，再按 EndpointId 重新发现。
///
/// 配对码是「生成那一刻」的地址快照：电脑那时可能还没连上中继（只剩局域网 IP），
/// 或者手机已经换了网络。旧实现只拿快照连一次，失败就回退局域网 ——
/// 跨网永远连不上。现在第二段只带 EndpointId，交给 iroh 自己的 DNS/pkarr
/// 发现对端当前的中继地址。
async fn connect_with_fallback(
    endpoint: &Endpoint,
    addr: EndpointAddr,
    best_addr: &AsyncMutex<EndpointAddr>,
    home: &Path,
) -> Result<Connection> {
    let mut candidates = Vec::new();
    // 上次连通的地址优先（就是 best_addr 的值）；和快照不同时先试它。
    let remembered = best_addr.lock().await.clone();
    if remembered != addr {
        candidates.push((remembered, SNAPSHOT_CONNECT_TIMEOUT));
    }
    candidates.push((addr.clone(), SNAPSHOT_CONNECT_TIMEOUT));
    let id_only = EndpointAddr::from(addr.id);
    if id_only != addr {
        candidates.push((id_only, REDISCOVER_CONNECT_TIMEOUT));
    }
    let mut last: Option<anyhow::Error> = None;
    for (candidate, timeout) in candidates {
        match tokio::time::timeout(timeout, endpoint.connect(candidate.clone(), ALPN)).await {
            Ok(Ok(conn)) => {
                *best_addr.lock().await = candidate.clone();
                save_peer_addr(home, &candidate);
                return Ok(conn);
            }
            Ok(Err(error)) => last = Some(anyhow::Error::new(error)),
            Err(_) => {
                last = Some(anyhow::anyhow!(
                    "连接 {} 超过 {} 秒没有完成",
                    candidate.id,
                    timeout.as_secs()
                ))
            }
        }
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("没有可用的连接地址")))
}

async fn proxy_tcp_stream(
    endpoint: Endpoint,
    addr: EndpointAddr,
    best_addr: Arc<AsyncMutex<EndpointAddr>>,
    token: String,
    home: PathBuf,
    tcp: TcpStream,
) -> Result<()> {
    let conn = connect_with_fallback(&endpoint, addr, &best_addr, &home)
        .await
        .map_err(|error| anyhow::anyhow!("iroh 连接对端失败：{error}"))?;
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|error| anyhow::anyhow!("iroh 打开流失败：{error}"))?;
    send.write_all(format!("COOMI-IROH 1 {token}\n").as_bytes())
        .await?;
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let client_to_remote = async {
        tokio::io::copy(&mut tcp_read, &mut send).await
    };
    let remote_to_client = async {
        tokio::io::copy(&mut recv, &mut tcp_write).await
    };
    let _ = tokio::try_join!(client_to_remote, remote_to_client);
    let _ = send.finish();
    Ok(())
}

/// 本引擎的 iroh 地址；未启动时返回 null。
pub(crate) fn local_endpoint_json() -> Value {
    NODE.get()
        .map(|node| node.local_endpoint_json())
        .unwrap_or(Value::Null)
}

pub(crate) async fn iroh_info(axum::extract::State(state): axum::extract::State<AppState>) -> axum::Json<Value> {
    axum::Json(match ensure_started(state).await {
        Ok(node) => json!({
            "ok": true,
            "endpoint": node.local_endpoint_json(),
        }),
        Err(error) => json!({
            "ok": false,
            "error": format!("{error:#}"),
        }),
    })
}

pub(crate) async fn iroh_connect(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::Json(body): axum::Json<Value>,
) -> Result<axum::Json<Value>, crate::web::ApiError> {
    let addr_value = body
        .get("addr")
        .cloned()
        .ok_or_else(|| crate::web::ApiError::bad_request("missing addr"))?;
    let token = body
        .get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| crate::web::ApiError::bad_request("missing token"))?
        .to_owned();
    let addr: EndpointAddr = serde_json::from_value(addr_value)
        .map_err(|error| crate::web::ApiError::bad_request(format!("invalid iroh addr: {error}")))?;
    let node = ensure_started(state)
        .await
        .map_err(|error| crate::web::ApiError::internal(format!("iroh 未启动：{error:#}")))?;
    let base = node
        .connect(addr.clone(), token)
        .await
        .map_err(|error| crate::web::ApiError::internal(format!("iroh 代理启动失败：{error:#}")))?;
    Ok(axum::Json(json!({
        "ok": true,
        "engineBase": base,
        "endpointId": addr.id.to_string(),
        "transport": "iroh",
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_replaces_pairing_auth_with_engine_token() {
        let head = b"GET /api/settings HTTP/1.1\r\nHost: 127.0.0.1:47831\r\nAuthorization: Bearer coomi_pair_test\r\nAccept: application/json\r\n\r\n";
        let rewritten = rewrite_http_head(head, "engine-token", 49217).expect("rewrite");
        let text = String::from_utf8(rewritten).expect("utf8");
        assert!(text.contains("Authorization: Bearer engine-token"));
        assert!(!text.contains("coomi_pair_test"));
        assert!(text.contains("Host: 127.0.0.1:49217"));
        assert!(text.contains("Connection: close"));
    }

    #[test]
    fn rewrite_keeps_websocket_upgrade() {
        let head = b"GET /ws/session/x?token=coomi_pair_test HTTP/1.1\r\nHost: 127.0.0.1:47831\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
        let rewritten = rewrite_http_head(head, "engine-token", 49217).expect("rewrite");
        let text = String::from_utf8(rewritten).expect("utf8");
        assert!(text.contains("Connection: Upgrade"));
        assert!(text.contains("Upgrade: websocket"));
        assert!(text.contains("Authorization: Bearer engine-token"));
        assert!(!text.contains("Connection: close"));
    }

    #[test]
    fn finds_header_terminator_split_across_chunks() {
        assert_eq!(find_subslice(b"abc\r\n\r\ndef", b"\r\n\r\n"), Some(3));
        assert_eq!(find_subslice(b"abc", b"\r\n\r\n"), None);
    }
}
