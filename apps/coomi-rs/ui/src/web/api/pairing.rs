//! LAN device pairing, peer inventory, and remote authorization.
//! State is stored under <home>/config; raw pairing tokens are never persisted.
use crate::web::{ApiError, AppState, BRIDGE_VERSION};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method};
use axum::extract::Query;
use std::path::PathBuf;
use std::sync::Arc;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path as FsPath;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use uuid::Uuid;

const STORE_FILE: &str = "lan_pairing.json";
const SNAPSHOT_PREFIX: &str = "lan_pairing.";
const DEFAULT_DEVICE_NAME: &str = "Coomi device";
/// 配对有效期：7 天。日常使用的设备会在认证时滑动续期（见 RENEW_THRESHOLD_SECS），
/// 这里只兜底「一周都没用过」的沉睡设备。之前 24 小时太短：手机两天没连，
/// 回来就要重新扫码 —— 用户体感就是「怎么又连不上了」。
const TOKEN_TTL_SECS: u64 = 7 * 24 * 60 * 60;
/// 剩余有效期低于这个阈值时，一次成功认证就把到期时间滑动到 now + TTL。
const RENEW_THRESHOLD_SECS: u64 = 48 * 60 * 60;

/// 加密中转/信令默认 broker。公共沙箱无 SLA，settings.json 可换成自建 MQTT。
pub const DEFAULT_SYNC_BROKER: &str = "wss://broker.emqx.io:8084/mqtt";

/// 互联 broker 地址：COOMI_SYNC_BROKER 环境变量 > settings.json syncBrokerUrl > 公共默认值。
pub(in crate::web) fn sync_broker_url(home: &FsPath) -> String {
    if let Ok(value) = std::env::var("COOMI_SYNC_BROKER") {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return value;
        }
    }
    if let Ok(bytes) = std::fs::read(crate::web::settings_path(home)) {
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(url) = value.get("syncBrokerUrl").and_then(Value::as_str) {
                let url = url.trim();
                if !url.is_empty() {
                    return url.to_string();
                }
            }
        }
    }
    DEFAULT_SYNC_BROKER.to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(in crate::web) struct PairingDevice {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub last_seen_at: Option<u64>,
    #[serde(default)]
    pub expires_at: u64,
    pub scopes: Vec<String>,
    #[serde(default)]
    pub revoked_at: Option<u64>,
    #[serde(default)]
    pub public_key: Option<String>,
    /// SHA-256 digest of the bearer token.
    #[serde(default)]
    pub token_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default = "store_version")]
    version: u8,
    #[serde(default)]
    revision: u64,
    device_id: String,
    device_name: String,
    #[serde(default)]
    public_key: Option<String>,
    devices: Vec<PairingDevice>,
}

fn store_version() -> u8 { 1 }

#[derive(Clone, Debug)]
pub(in crate::web) struct PairingStore {
    pub device_id: String,
    pub device_name: String,
    pub public_key: Option<String>,
    pub devices: Vec<PairingDevice>,
    revision: u64,
    /// 只在内存里变过、还没落盘（last_seen / 滑动续期）。
    /// 逐请求 save 会为每个隧道请求/心跳生成一个新快照 —— 真机闪存写放大，
    /// 而且 prune 只留两代，反而更容易丢更新。攒着定期落一次就够。
    dirty: bool,
}

impl PairingStore {
    pub(in crate::web) fn load(home: &FsPath) -> Self {
        let directory = home.join("config");
        let mut snapshots = fs::read_dir(&directory)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                let name = path.file_name()?.to_str()?;
                if !name.starts_with(SNAPSHOT_PREFIX) || path.extension()?.to_str()? != "json" {
                    return None;
                }
                let bytes = fs::read(&path).ok()?;
                let file = serde_json::from_slice::<StoreFile>(&bytes).ok()?;
                Some((file.revision, file))
            })
            .collect::<Vec<_>>();
        snapshots.sort_by_key(|(revision, _)| *revision);
        if let Some((revision, file)) = snapshots.pop() {
            return Self::from_file(file, revision);
        }
        if let Ok(bytes) = fs::read(directory.join(STORE_FILE))
            && let Ok(file) = serde_json::from_slice::<StoreFile>(&bytes)
        {
            let revision = file.revision;
            return Self::from_file(file, revision);
        }
        Self::new()
    }

    fn from_file(file: StoreFile, revision: u64) -> Self {
        Self {
            device_id: file.device_id,
            device_name: file.device_name,
            public_key: file.public_key,
            devices: file.devices,
            revision,
            dirty: false,
        }
    }

    fn new() -> Self {
        Self {
            device_id: format!("dev_{}", Uuid::new_v4().simple()),
            device_name: DEFAULT_DEVICE_NAME.into(),
            public_key: None,
            devices: Vec::new(),
            revision: 0,
            dirty: false,
        }
    }

    fn save(&mut self, home: &FsPath) -> Result<(), ApiError> {
        let directory = home.join("config");
        fs::create_dir_all(&directory)
            .map_err(|error| ApiError::internal(format!("create pairing directory: {error}")))?;
        let revision = self.revision.saturating_add(1);
        self.revision = revision;
        let file = StoreFile {
            version: 1,
            revision,
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            public_key: self.public_key.clone(),
            devices: self.devices.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|error| ApiError::internal(format!("serialize pairing state: {error}")))?;

        // Immutable generation files avoid replace-existing rename semantics on Windows.
        // A partial newest generation is ignored during load; the previous generation remains.
        let path = directory.join(format!(
            "{SNAPSHOT_PREFIX}{revision:020}.{}.json",
            Uuid::new_v4().simple()
        ));
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| ApiError::internal(format!("create pairing snapshot: {error}")))?;
        if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
            drop(output);
            let _ = fs::remove_file(&path);
            return Err(ApiError::internal(format!("write pairing snapshot: {error}")));
        }
        drop(output);
        prune_snapshots(&directory, revision);
        Ok(())
    }

    /// 只标记「需要落盘」，不立刻写。认证/心跳这类高频路径用它。
    pub(in crate::web) fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// 有变更才写盘；返回是否真的写了一次（供后台刷盘任务统计）。
    pub(in crate::web) fn save_if_dirty(&mut self, home: &FsPath) -> Result<bool, ApiError> {
        if !self.dirty {
            return Ok(false);
        }
        self.save(home)?;
        self.dirty = false;
        Ok(true)
    }

    /// 软撤销：记录保留，便于双端解释「这台设备曾被配对过」。
    pub(in crate::web) fn revoke(&mut self, id: &str, at: u64) -> Option<PairingDevice> {
        let device = self.devices.iter_mut().find(|device| device.id == id)?;
        if device.revoked_at.is_none() {
            device.revoked_at = Some(at);
        }
        Some(device.clone())
    }

    /// 硬删除：用户点「删除设备」后，这条记录必须从磁盘上消失。
    pub(in crate::web) fn remove(&mut self, id: &str) -> Option<PairingDevice> {
        let index = self.devices.iter().position(|device| device.id == id)?;
        Some(self.devices.remove(index))
    }
}

fn prune_snapshots(directory: &FsPath, newest: u64) {
    let oldest_to_keep = newest.saturating_sub(1);
    let Ok(entries) = fs::read_dir(directory) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else { continue };
        let Some(revision) = name
            .strip_prefix(SNAPSHOT_PREFIX)
            .and_then(|tail| tail.split('.').next())
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        if revision < oldest_to_keep {
            let _ = fs::remove_file(path);
        }
    }
}

pub(in crate::web) type PairingState = RwLock<PairingStore>;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

/// 签发新配对码时只清理「已过期」的凭据。
/// 从未握手的设备不能误杀：它可能只是用户还没扫（生成码 → 手机扫码之间有间隔）。
fn prune_expired_devices(devices: &mut Vec<PairingDevice>, timestamp: u64) {
    devices.retain(|device| device.expires_at > timestamp);
}

fn credential_is_valid(peer: &PairingDevice, token: &str, timestamp: u64, scope: &str) -> bool {
    !token.trim().is_empty()
        && token.starts_with("coomi_pair_")
        && peer.revoked_at.is_none()
        && peer.expires_at > timestamp
        && peer.token_hash == hash_token(token)
        && peer.scopes.iter().any(|granted| granted == scope)
}

/// 滑动续期：剩余有效期 < 12h 时给一次成功认证补满 24h；已过期（remaining=0）绝不复活。
fn renewal_expiry(expires_at: u64, timestamp: u64) -> Option<u64> {
    let remaining = expires_at.saturating_sub(timestamp);
    if remaining > 0 && remaining < RENEW_THRESHOLD_SECS {
        Some(timestamp.saturating_add(TOKEN_TTL_SECS))
    } else {
        None
    }
}

fn pair_request_rejects_code(code: Option<&str>) -> bool {
    code.is_some_and(|value| !value.trim().is_empty())
}

fn lan_ip() -> String {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

/// 本机所有可用的 IPv4（排掉回环/链路本地），供桌面端自检面板展示。
fn lan_ips() -> Vec<String> {
    let mut ips: Vec<String> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(_, ip)| match ip {
            std::net::IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() => Some(v4.to_string()),
            _ => None,
        })
        .collect();
    ips.sort();
    ips.dedup();
    ips
}

fn engine_base(state: &AppState) -> String {
    format!("http://{}:{}", lan_ip(), state.port)
}

fn canonical_workdir_root(cwd: &FsPath) -> Result<PathBuf, ApiError> {
    fs::canonicalize(cwd).map_err(|error| ApiError::internal(format!("resolve working directory: {error}")))
}

fn resolve_workdir_path(root: &FsPath, requested: &str) -> Result<PathBuf, ApiError> {
    let requested = requested.trim();
    let candidate = if requested.is_empty() || requested == "." {
        root.to_path_buf()
    } else {
        let path = FsPath::new(requested);
        if path.is_absolute() { path.to_path_buf() } else { root.join(path) }
    };
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| ApiError::bad_request(format!("directory is unavailable: {error}")))?;
    if !canonical.starts_with(root) {
        return Err(ApiError::forbidden("path resolves outside working directory"));
    }
    if !canonical.is_dir() {
        return Err(ApiError::bad_request("requested path is not a directory"));
    }
    Ok(canonical)
}

#[derive(Debug, Deserialize)]
pub(in crate::web) struct RemoteFsListQuery {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

pub(in crate::web) async fn remote_fs_list(
    State(state): State<AppState>,
    Query(query): Query<RemoteFsListQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize_remote_token(&state, &headers, "http").await?;
    let (root_source, root_path) = if let Some(session_id) = query.session_id.as_deref() {
        let session_uuid = Uuid::parse_str(session_id).map_err(|_| ApiError::bad_request("invalid session_id"))?;
        let session = coomi_engine::SessionStore::new(&state.home)
            .load(session_uuid)
            .map_err(|_| ApiError::not_found("session not found"))?;
        if session.cwd.as_os_str().is_empty() {
            return Err(ApiError::bad_request("session has no working directory"));
        }
        (Some(session_id.to_owned()), session.cwd)
    } else {
        (None, state.cwd.clone())
    };
    let root = canonical_workdir_root(&root_path)?;
    let directory = resolve_workdir_path(&root, query.path.as_deref().unwrap_or(""))?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&directory)
        .map_err(|error| ApiError::internal(format!("list directory: {error}")))?
    {
        let item = item.map_err(|error| ApiError::internal(format!("read directory entry: {error}")))?;
        let path = item.path();
        let Ok(canonical) = fs::canonicalize(&path) else { continue };
        if !canonical.starts_with(&root) { continue; }
        let Ok(metadata) = fs::metadata(&canonical) else { continue };
        let Some(name) = item.file_name().to_str().map(str::to_owned) else { continue };
        entries.push(json!({
            "name": name,
            "path": canonical.to_string_lossy(),
            "is_dir": metadata.is_dir(),
            "size": if metadata.is_file() { metadata.len() } else { 0 },
        }));
    }
    entries.sort_by(|left, right| {
        let left_dir = left.get("is_dir").and_then(Value::as_bool).unwrap_or(false);
        let right_dir = right.get("is_dir").and_then(Value::as_bool).unwrap_or(false);
        right_dir.cmp(&left_dir).then_with(|| {
            left.get("name").and_then(Value::as_str).unwrap_or_default()
                .to_lowercase().cmp(&right.get("name").and_then(Value::as_str).unwrap_or_default().to_lowercase())
        })
    });
    Ok(Json(json!({ "path": directory.to_string_lossy(), "entries": entries })))
}

fn local_info(state: &AppState, store: &PairingStore) -> Value {
    json!({
        "id": store.device_id,
        "device_id": store.device_id,
        "name": store.device_name,
        "kind": "desktop",
        "engineBase": engine_base(state),
        "cwd": canonical_workdir_root(&state.cwd).map(|path| path.to_string_lossy().to_string()).unwrap_or_else(|_| state.cwd.display().to_string()),
        "version": BRIDGE_VERSION,
        "protocol_version": 1,
        "lan": { "host": lan_ip(), "port": state.port },
        "lanIps": lan_ips(),
        "bindHost": if crate::web::lan_access_enabled(&state.home) { "0.0.0.0" } else { "127.0.0.1" },
        "iroh": crate::web::iroh_tunnel::local_endpoint_json(),
        "capabilities": ["pairing", "proxy_http", "proxy_ws", "iroh_tunnel"],
        "public_key": store.public_key,
        "lan_access": crate::web::lan_access_enabled(&state.home),
        "tokenConfigured": true,
        // 宿主 UI 也读同一个配置：手机拿的是配对码里的 broker，桌面拿的是这里的，
        // 两边必须同源，否则换自建 broker 后一端仍连公共沙箱，永远握不上手。
        "syncBrokerUrl": sync_broker_url(&state.home),
    })
}

fn peer_view(state: &AppState, peer: &PairingDevice, timestamp: u64) -> Value {
    let expired = peer.expires_at == 0 || peer.expires_at <= timestamp;
    let revoked = peer.revoked_at.is_some();
    let online = !expired
        && !revoked
        && peer.last_seen_at.is_some_and(|seen| timestamp.saturating_sub(seen) < 300);
    let last_seen_ms = peer.last_seen_at.map(|value| value.saturating_mul(1000));
    let created_ms = peer.created_at.saturating_mul(1000);
    json!({
        "id": peer.id,
        "device_id": peer.id,
        "peer_id": peer.id,
        "name": peer.name,
        "kind": "unknown",
        "engineBase": engine_base(state),
        "reachability": if online { "online" } else { "offline" },
        "lastSeenAt": last_seen_ms,
        "createdAt": created_ms,
        "updatedAt": last_seen_ms.unwrap_or(created_ms),
        // 滑动续期后的权威到期时间：手机据此回填本地记录，避免「名义过期」误判。
        "expiresAt": peer.expires_at.saturating_mul(1000),
        "last_seen": peer.last_seen_at,
        "online": online,
        "revoked": revoked,
        "expired": expired,
        "scopes": peer.scopes,
        "expires_at": peer.expires_at,
    })
}

pub(in crate::web) async fn device_info(State(state): State<AppState>) -> Json<Value> {
    let store = state.pairing.read().await;
    Json(local_info(&state, &store))
}

pub(in crate::web) async fn list_devices(State(state): State<AppState>) -> Json<Value> {
    let store = state.pairing.read().await;
    let timestamp = now();
    let peers = store
        .devices
        .iter()
        .map(|peer| peer_view(&state, peer, timestamp))
        .collect::<Vec<_>>();
    Json(json!({ "peers": peers, "activeDeviceId": Value::Null }))
}

#[derive(Debug, Deserialize)]
pub(in crate::web) struct PairRequest {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

pub(in crate::web) async fn pair(
    State(state): State<AppState>,
    Json(request): Json<PairRequest>,
) -> Result<Json<Value>, ApiError> {
    if pair_request_rejects_code(request.code.as_deref()) {
        return Err(ApiError::bad_request(
            "code exchange is not supported; import the QR payload directly",
        ));
    }
    if request
        .public_key
        .as_deref()
        .is_some_and(|key| key.trim().len() > 4096)
    {
        return Err(ApiError::bad_request("public_key is too long"));
    }
    let name = request
        .name
        .unwrap_or_else(|| "Paired device".into())
        .trim()
        .to_owned();
    if name.is_empty() || name.len() > 80 {
        return Err(ApiError::bad_request("name must be 1-80 characters"));
    }

    // 先生成/取 iroh 地址：二维码里带上它，手机才能跨网络直连。
    let iroh_endpoint = match tokio::time::timeout(
        std::time::Duration::from_secs(8),
        crate::web::iroh_tunnel::ensure_started(state.clone()),
    )
    .await
    {
        Ok(Ok(node)) => node.local_endpoint_json(),
        _ => Value::Null,
    };
    let mut store = state.pairing.write().await;
    // Two independent UUIDv4 values provide about 244 bits of CSPRNG entropy.
    let token = format!("coomi_pair_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let issued = now();
    let expires_at = issued.saturating_add(TOKEN_TTL_SECS);
    let peer_id = format!("peer_{}", Uuid::new_v4().simple());
    let engine_base = engine_base(&state);
    let peer = PairingDevice {
        id: peer_id.clone(),
        name: name.clone(),
        created_at: issued,
        last_seen_at: None,
        expires_at,
        scopes: vec!["http".to_owned(), "ws".to_owned(), "iroh".to_owned()],
        revoked_at: None,
        public_key: request.public_key,
        token_hash: hash_token(&token),
    };
    let peer_json = json!({
        "id": store.device_id,
        "device_id": store.device_id,
        "name": store.device_name,
        "kind": "desktop",
        "engineBase": engine_base,
        "engineToken": token,
        "reachability": "online",
        "lastSeenAt": issued.saturating_mul(1000),
        "createdAt": issued.saturating_mul(1000),
        "updatedAt": issued.saturating_mul(1000),
    });
    store.devices.push(peer);
    // 只清理「已过期」的旧凭据。之前这里会作废所有「从未握手」的设备：用户在电脑上
    // 多点几次生成配对码，就把还没开始连的手机凭据杀光了 —— 手机端只剩一句
    // 「电脑不在线」。从未握手 ≠ 死凭据，它可能只是用户还没扫。
    prune_expired_devices(&mut store.devices, issued);
    println!(
        "[pair] 已签发配对码 peer={} name={} lan={}:{} 有效期至+{}s（现存设备 {} 台）",
        peer_id,
        name,
        lan_ip(),
        state.port,
        TOKEN_TTL_SECS,
        store.devices.len()
    );
    store.save(&state.home)?;

    let host = lan_ip();
    let payload = json!({
        "v": 1,
        "deviceId": store.device_id,
        "peerId": peer_id,
        "name": store.device_name,
        "lan": { "host": host, "port": state.port },
        "iroh": iroh_endpoint,
        "relay": Value::Null,
        "brokerUrl": sync_broker_url(&state.home),
        "pub": store.public_key,
        "token": token,
        "exp": expires_at,
    });
    Ok(Json(json!({
        "device": peer_json,
        "accepted": true,
        "device_id": store.device_id,
        "peer_id": peer_id,
        "token": payload["token"],
        "public_key": store.public_key,
        "expires_at": expires_at,
        "qr_payload": payload,
    })))
}

pub(in crate::web) async fn revoke_device(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut store = state.pairing.write().await;
    let device = store
        .revoke(&id, now())
        .ok_or_else(|| ApiError::not_found("paired device not found"))?;
    store.save(&state.home)?;
    Ok(Json(json!({ "ok": true, "device_id": id, "revoked": true, "expired": device.expires_at <= now() })))
}

/// 手机/桌面点「删除设备」走这里：记录必须真的消失，否则重启后列表里又是同一条幽灵。
pub(in crate::web) async fn delete_device(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut store = state.pairing.write().await;
    store
        .remove(&id)
        .ok_or_else(|| ApiError::not_found("paired device not found"))?;
    store.save(&state.home)?;
    Ok(Json(json!({ "ok": true, "device_id": id, "removed": true })))
}

/// 已配对设备作废「自己」那条记录：手机忘记这台电脑时调用，免得电脑端留下永远连不上的幽灵。
/// 只能删自己 —— peer_id 来自这次请求携带的配对令牌，不接受外部传入的 id。
pub(in crate::web) async fn self_revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (peer_id, _) = authorize_remote_token(&state, &headers, "http").await?;
    let mut store = state.pairing.write().await;
    store.remove(&peer_id);
    store.save(&state.home)?;
    Ok(Json(json!({ "ok": true, "device_id": peer_id, "removed": true })))
}

#[derive(Debug, Deserialize)]
pub(in crate::web) struct RevokeRequest {
    pub device_id: String,
}

pub(in crate::web) async fn revoke_device_body(
    State(state): State<AppState>,
    Json(request): Json<RevokeRequest>,
) -> Result<Json<Value>, ApiError> {
    revoke_device(State(state), Path(request.device_id)).await
}

pub(in crate::web) async fn authorize_remote(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (peer_id, scopes) = authorize_remote_token(&state, &headers, "http").await?;
    Ok(Json(json!({ "ok": true, "peer_id": peer_id, "scopes": scopes })))
}

pub(in crate::web) async fn p2p_secret(State(state): State<AppState>, Path(peer_id): Path<String>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    if state.token.trim().is_empty() { return Err(ApiError::unauthorized("P2P secret recovery requires engine authentication")); }
    let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    if bearer != Some(state.token.as_str()) { return Err(ApiError::unauthorized("P2P secret recovery requires engine Bearer token")); }
    let store = state.pairing.read().await;
    let peer = store.devices.iter().find(|peer| peer.id == peer_id).ok_or_else(|| ApiError::not_found("paired peer not found"))?;
    if peer.revoked_at.is_some() || peer.expires_at <= now() { return Err(ApiError::not_found("paired peer is revoked or expired")); }
    Ok(Json(json!({ "token_hash": peer.token_hash, "expires_at": peer.expires_at })))
}

/// iroh 隧道握手校验：配对 token 必须仍然有效（http/ws/iroh 任一 scope 均可）。
/// 隧道本身已由 QUIC 加密；这里再做应用层凭证校验，防止任意 iroh 节点连进来。
/// 返回对端 peer id，供隧道在长连接期间持续上报在线。
/// iroh 握手校验：读写**与 HTTP 鉴权同一份**内存状态。
///
/// 以前这里自己 `PairingStore::load(home)`：HTTP 鉴权（内存）与 iroh（磁盘）各持一个
/// revision，谁后写盘谁覆盖对方 —— 新配对码 HTTP 能用、隧道却判无效，而且每条隧道
/// 请求都写一个新快照。现在统一走 `AppState.pairing`，只置 dirty，由后台定期落盘。
pub(in crate::web) async fn validate_iroh_token(
    pairing: &Arc<RwLock<PairingStore>>,
    token: &str,
) -> Option<String> {
    let mut store = pairing.write().await;
    let timestamp = now();
    let Some(peer) = store.devices.iter_mut().find(|peer| {
        credential_is_valid(peer, token, timestamp, "http")
            || credential_is_valid(peer, token, timestamp, "ws")
            || credential_is_valid(peer, token, timestamp, "iroh")
    }) else {
        return None;
    };
    let peer_id = peer.id.clone();
    peer.last_seen_at = Some(timestamp);
    if let Some(next) = renewal_expiry(peer.expires_at, timestamp) {
        peer.expires_at = next;
    }
    store.mark_dirty();
    Some(peer_id)
}

/// 隧道存活期间续命：只按 peer id 更新 last_seen，凭据已撤销/过期则停止。
pub(in crate::web) async fn touch_peer_seen(
    pairing: &Arc<RwLock<PairingStore>>,
    peer_id: &str,
) -> bool {
    let mut store = pairing.write().await;
    let timestamp = now();
    let Some(peer) = store.devices.iter_mut().find(|peer| peer.id == peer_id) else {
        return false;
    };
    if peer.revoked_at.is_some() || peer.expires_at <= timestamp {
        return false;
    }
    peer.last_seen_at = Some(timestamp);
    if let Some(next) = renewal_expiry(peer.expires_at, timestamp) {
        peer.expires_at = next;
    }
    store.mark_dirty();
    true
}

pub(in crate::web) async fn authorize_remote_token(
    state: &AppState,
    headers: &HeaderMap,
    transport: &str,
) -> Result<(String, Vec<String>), ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::unauthorized("remote requests require Bearer pairing token"))?;
    let mut store = state.pairing.write().await;
    let timestamp = now();
    let peer = store
        .devices
        .iter_mut()
        .find(|peer| credential_is_valid(peer, token, timestamp, transport))
        .ok_or_else(|| ApiError::unauthorized("invalid, expired, or revoked pairing token"))?;
    if !peer
        .scopes
        .iter()
        .any(|scope| scope == transport)
    {
        return Err(ApiError::forbidden("pairing token does not allow this transport"));
    }
    peer.last_seen_at = Some(timestamp);
    // 滑动续期：每天都有成功认证的设备永远不会因为「过了 24 小时」被踢下线。
    if let Some(next) = renewal_expiry(peer.expires_at, timestamp) {
        peer.expires_at = next;
    }
    let result = (peer.id.clone(), peer.scopes.clone());
    // 只在内存里标记；后台每 60s 落一次盘（逐请求写快照 = 闪存写放大）。
    store.mark_dirty();
    Ok(result)
}

fn required_scope(path: &str, method: &Method, is_ws: bool) -> Option<&'static str> {
    if is_ws {
        // 已配对设备可以接管「会话」这一条 WS（手机在云端模式下就是用它发消息/收流）。
        // 只放行 /ws/session/{id}，其它 WS 路由仍然拒绝；令牌本身有 scope、过期与撤销。
        if *method == Method::GET && path.starts_with("/ws/session/") {
            return Some("ws");
        }
        return None;
    }
    // 配对令牌的 http scope 是「已配对设备的只读 UI」：GET 全部放行，
    // 但设备内部代理/配对接口除外；任何写入仍必须使用引擎令牌。
    //
    // 以前只放行 /api/sessions 与少数 device 接口，导致手机在云端模式下
    // /api/providers、/api/agents、/api/memory 等全部 401：模型列表永远
    // “正在读取”，子代理/记忆页也打不开。这里按方法放行只读 API，写入
    // （send_message 走 WS）不受影响。
    if *method == Method::GET && path.starts_with("/api/") {
        // 本机 iroh 代理只允许同源本机调用，不能借配对令牌让电脑拨另一个地址。
        if path == "/api/device/iroh" || path.starts_with("/api/device/iroh/") {
            return None;
        }
        // 只接受 POST 的写接口，不允许用 GET 探测/触发。
        if path == "/api/device/self-revoke" || path == "/api/device/pair" {
            return None;
        }
        return Some("http");
    }
    if *method == Method::POST && path.starts_with("/api/agents/") && path.ends_with("/message") {
        // 子代理页发送插话：与 WS 的 send_message 同类，只作用于指定子代理。
        return Some("http");
    }
    if *method == Method::POST && path.starts_with("/api/sessions/") && path.ends_with("/cwd") {
        // 云端选工作目录：手机浏览的是电脑目录，选完必须能写回会话。
        return Some("http");
    }
    if *method == Method::POST && path == "/api/device/self-revoke" {
        // 手机「忘记这台电脑」时顺手作废它自己的那条 peer：
        // 只认调用方自己的令牌，删除别人的记录仍然必须用引擎令牌。
        return Some("http");
    }
    None
}

/// Restrict pairing credentials to read-only discovery and dedicated remote proxy paths.
pub(in crate::web) async fn token_allows(
    state: &AppState,
    token: &str,
    path: &str,
    method: &Method,
    is_ws: bool,
) -> bool {
    let Some(scope) = required_scope(path, method, is_ws) else {
        return false;
    };
    let timestamp = now();
    let mut store = state.pairing.write().await;
    let Some(peer) = store
        .devices
        .iter_mut()
        .find(|peer| credential_is_valid(peer, token, timestamp, scope))
    else {
        return false;
    };
    peer.last_seen_at = Some(timestamp);
    let _ = store.save(&state.home);
    true
}

#[derive(Debug, Deserialize)]
pub(in crate::web) struct LanAccessRequest {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
pub(in crate::web) struct SyncBrokerRequest {
    pub url: String,
}

/// 换掉互联中转/信令 broker（自建 MQTT 时用）。只接受 ws(s):// 地址。
pub(in crate::web) async fn set_sync_broker(
    State(state): State<AppState>,
    Json(request): Json<SyncBrokerRequest>,
) -> Result<Json<Value>, ApiError> {
    let url = request.url.trim().to_string();
    if url.len() > 512 || !(url.starts_with("wss://") || url.starts_with("ws://")) {
        return Err(ApiError::bad_request("broker URL must be a ws:// or wss:// address"));
    }
    let path = crate::web::settings_path(&state.home);
    let mut value = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    let Some(object) = value.as_object_mut() else {
        return Err(ApiError::internal("settings.json is not an object"));
    };
    object.insert("syncBrokerUrl".into(), Value::String(url.clone()));
    crate::web::write_json_atomic(&path, &value)?;
    Ok(Json(json!({ "ok": true, "syncBrokerUrl": url })))
}

pub(in crate::web) async fn set_lan_access(
    State(state): State<AppState>,
    Json(request): Json<LanAccessRequest>,
) -> Result<Json<Value>, ApiError> {
    let path = state.home.join("config").join("settings.json");
    let mut value = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    let Some(object) = value.as_object_mut() else {
        return Err(ApiError::internal("settings.json is not an object"));
    };
    object.insert("lanAccess".into(), Value::Bool(request.enabled));
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::internal("settings path has no parent"))?;
    fs::create_dir_all(parent)
        .map_err(|error| ApiError::internal(format!("create config dir: {error}")))?;
    let bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| ApiError::internal(format!("serialize settings: {error}")))?;
    fs::write(&path, bytes).map_err(|error| ApiError::internal(format!("write settings: {error}")))?;
    Ok(Json(json!({
        "ok": true,
        "lan_access": request.enabled,
        "restart_required": true,
    })))
}

#[cfg(test)]
mod pairing_security_tests {
    use super::{PairingDevice, credential_is_valid, hash_token, pair_request_rejects_code, required_scope, resolve_workdir_path};
    use axum::http::Method;
    use std::fs;
    use std::path::Path;

    const TOKEN: &str = "coomi_pair_test_secret";

    fn peer() -> PairingDevice {
        PairingDevice {
            id: "peer_test".into(),
            name: "Test peer".into(),
            created_at: 100,
            last_seen_at: None,
            expires_at: 200,
            scopes: vec!["http".into(), "ws".into()],
            revoked_at: None,
            public_key: None,
            token_hash: hash_token(TOKEN),
        }
    }

    #[test]
    fn pair_token_is_accepted_before_expiry_for_granted_scope() {
        assert!(credential_is_valid(&peer(), TOKEN, 199, "http"));
    }

    #[test]
    fn 生成新配对码不误杀从未握手的旧凭据() {
        let mut devices = vec![PairingDevice {
            id: "never_seen".into(),
            name: "还没扫的手机".into(),
            created_at: 100,
            last_seen_at: None,
            expires_at: 900,
            scopes: vec!["http".into()],
            revoked_at: None,
            public_key: None,
            token_hash: "x".into(),
        }];
        super::prune_expired_devices(&mut devices, 200);
        assert_eq!(devices.len(), 1, "未过期且未握手的凭据必须保留");
    }

    #[test]
    fn 生成新配对码清理已过期凭据() {
        let mut devices = vec![PairingDevice {
            id: "expired".into(),
            name: "过期设备".into(),
            created_at: 100,
            last_seen_at: None,
            expires_at: 199,
            scopes: vec!["http".into()],
            revoked_at: None,
            public_key: None,
            token_hash: "x".into(),
        }];
        super::prune_expired_devices(&mut devices, 200);
        assert!(devices.is_empty(), "已过期的凭据应当被清理");
    }

    #[test]
    fn broker_url_falls_back_to_public_default_when_unconfigured() {
        let home = tempfile::tempdir().expect("home");
        assert_eq!(
            super::sync_broker_url(home.path()),
            super::DEFAULT_SYNC_BROKER
        );
    }

    #[test]
    fn broker_url_comes_from_settings_file() {
        let home = tempfile::tempdir().expect("home");
        let config = home.path().join("config");
        std::fs::create_dir_all(&config).expect("config dir");
        std::fs::write(
            config.join("settings.json"),
            r#"{"syncBrokerUrl":"wss://broker.example.com:8084/mqtt"}"#,
        )
        .expect("settings file");
        assert_eq!(
            super::sync_broker_url(home.path()),
            "wss://broker.example.com:8084/mqtt"
        );
    }

    #[test]
    fn empty_broker_setting_does_not_override_default() {
        let home = tempfile::tempdir().expect("home");
        let config = home.path().join("config");
        std::fs::create_dir_all(&config).expect("config dir");
        std::fs::write(config.join("settings.json"), r#"{"syncBrokerUrl":"  "}"#).expect("settings file");
        assert_eq!(
            super::sync_broker_url(home.path()),
            super::DEFAULT_SYNC_BROKER
        );
    }

    #[test]
    fn pair_token_expires_at_boundary() {
        assert!(!credential_is_valid(&peer(), TOKEN, 200, "http"));
    }

    #[test]
    fn pairing_token_renews_when_close_to_expiry() {
        // 剩余 6h < 48h 阈值：认证成功后应滑到 now + 7 天。
        let now = 1_800_000_000u64;
        assert_eq!(
            super::renewal_expiry(now + 6 * 3600, now),
            Some(now + 7 * 24 * 3600)
        );
    }

    #[test]
    fn pairing_token_keeps_its_deadline_when_plenty_of_time_remains() {
        // 剩余 3 天 > 48h：不滑动，避免每次请求都写盘。
        let now = 1_800_000_000u64;
        assert_eq!(super::renewal_expiry(now + 3 * 24 * 3600, now), None);
    }

    #[test]
    fn expired_pairing_token_is_never_revived_by_renewal() {
        // 已过期的令牌认证就会被拒，续期逻辑本身也不得复活它。
        let now = 1_800_000_000u64;
        assert_eq!(super::renewal_expiry(now - 60, now), None);
        assert_eq!(super::renewal_expiry(now - 60, now + 60), None);
    }

    #[test]
    fn revoked_pair_token_is_rejected() {
        let mut peer = peer();
        peer.revoked_at = Some(150);
        assert!(!credential_is_valid(&peer, TOKEN, 160, "http"));
    }

    #[test]
    fn pair_token_cannot_cross_transport_scopes() {
        assert!(!credential_is_valid(&peer(), TOKEN, 150, "broker"));
        assert!(!credential_is_valid(&peer(), "coomi_pair_other", 150, "http"));
    }

    #[test]
    fn deleting_a_peer_removes_the_record_from_disk() {
        let home = tempfile::tempdir().expect("home");
        let mut stay = peer();
        stay.id = "peer_stay".into();
        let mut store = super::PairingStore::load(home.path());
        store.devices = vec![peer(), stay];
        store.save(home.path()).expect("seed save");
        assert!(store.remove("peer_test").is_some());
        store.save(home.path()).expect("save after delete");
        let reloaded = super::PairingStore::load(home.path());
        assert_eq!(
            reloaded.devices.iter().map(|device| device.id.as_str()).collect::<Vec<_>>(),
            vec!["peer_stay"]
        );
    }

    #[test]
    fn revoking_a_peer_keeps_the_record_for_audit() {
        let home = tempfile::tempdir().expect("home");
        let mut store = super::PairingStore::load(home.path());
        store.devices = vec![peer()];
        store.save(home.path()).expect("seed save");
        assert!(store.revoke("peer_test", 150).is_some());
        store.save(home.path()).expect("save after revoke");
        let reloaded = super::PairingStore::load(home.path());
        assert_eq!(reloaded.devices.len(), 1);
        assert!(reloaded.devices[0].revoked_at.is_some());
    }

    #[test]
    fn deleting_an_unknown_peer_reports_nothing_removed() {
        let home = tempfile::tempdir().expect("home");
        let mut store = super::PairingStore::load(home.path());
        store.devices = vec![peer()];
        assert!(store.remove("peer_missing").is_none());
        assert_eq!(store.devices.len(), 1);
    }

    #[test]
    fn pair_code_exchange_is_rejected_only_for_nonempty_code() {
        assert!(!pair_request_rejects_code(None));
        assert!(!pair_request_rejects_code(Some("  ")));
        assert!(pair_request_rejects_code(Some("123456")));
    }

    #[test]
    fn paired_token_path_allowlist_is_read_only_and_exact() {
        assert_eq!(required_scope("/api/device/info", &Method::GET, false), Some("http"));
        assert_eq!(required_scope("/api/device/peers", &Method::GET, false), Some("http"));
        assert_eq!(required_scope("/api/device/authorize", &Method::GET, false), Some("http"));
        assert_eq!(required_scope("/api/device/remote-fs/list", &Method::GET, false), Some("http"));
        assert_eq!(required_scope("/api/device/remote-fs/list", &Method::POST, false), None);
        assert_eq!(required_scope("/api/device/pair", &Method::POST, false), None);
        assert_eq!(required_scope("/api/providers", &Method::GET, false), Some("http"));
        assert_eq!(required_scope("/api/agents/abc/message", &Method::POST, false), Some("http"));
        assert_eq!(required_scope("/api/sessions/s1/cwd", &Method::POST, false), Some("http"));
        assert_eq!(required_scope("/ws/session/s1", &Method::GET, true), Some("ws"));
    }

    #[test]
    fn paired_device_may_burn_its_own_credential_but_not_delete_others() {
        // 手机「删除这台电脑」时要顺手作废自己在电脑上的记录：这条路径对配对令牌开放。
        assert_eq!(required_scope("/api/device/self-revoke", &Method::POST, false), Some("http"));
        // 但按 id 硬删除别人的记录仍然只有引擎令牌能做。
        assert_eq!(required_scope("/api/device/peers/peer_other", &Method::DELETE, false), None);
        assert_eq!(required_scope("/api/device/self-revoke", &Method::GET, false), None);
    }

    #[test]
    fn remote_fs_resolves_only_existing_directories_inside_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("work");
        fs::create_dir_all(root.join("nested")).unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        assert_eq!(resolve_workdir_path(&canonical_root, "").unwrap(), canonical_root);
        assert_eq!(resolve_workdir_path(&canonical_root, "nested").unwrap(), canonical_root.join("nested"));
        assert!(resolve_workdir_path(&canonical_root, "../outside").is_err());
        assert!(resolve_workdir_path(&canonical_root, temp.path().to_str().unwrap()).is_err());
        assert!(resolve_workdir_path(&canonical_root, "missing").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn remote_fs_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("work");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        assert!(resolve_workdir_path(&canonical_root, "escape").is_err());
    }
}
