//! 局域网发现：让手机绕开「配对码里那串会过期的 host:port」。
//!
//! 背景：配对码把当时的 `局域网IP:端口` 焊死在手机里。电脑重启换端口、DHCP 换 IP、
//! 甚至只是插拔一次网线，手机保存的地址就变成死地址 —— 界面只剩「电脑不在线」，
//! 而电脑其实好好开着。扫码重配对当然能救，但用户不该为此反复扫码。
//!
//! 做法：电脑引擎常驻一个固定 UDP 端口的应答器；手机的本地引擎广播一次发现请求，
//! 收到的应答里带 `deviceId`（与配对码里同一个）和当前监听端口。
//!
//! 关键点：**回包不写 host**。手机取 UDP 数据报的源地址当作电脑地址 ——
//! 多网卡（VPN / 虚拟机 / 有线+无线）时，它就是「这条请求真正能到达的那张网卡」，
//! 不会像 `local_ip()` 那样猜错网卡。
//!
//! 协议是纯 JSON、不携带令牌；发现只回答「我是谁、我在哪个端口」，读权限仍由
//! 配对令牌控制。

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use axum::Json;
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};

use crate::web::BRIDGE_VERSION;

/// 发现端口：两端写死，不随引擎端口变化。
pub(in crate::web) const DISCOVERY_PORT: u16 = 45871;
const PROBE: &[u8] = br#"{"coomi":"discover","v":1}"#;
const MAX_PACKET: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(in crate::web) struct DiscoveredPeer {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub version: String,
}

#[derive(Debug, Deserialize)]
pub(in crate::web) struct DiscoverRequest {
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// `POST /api/device/discover`：在局域网里广播一次，收集应答。
///
/// 调用方是**手机本地引擎**（云端模式也一样：页面始终由本地引擎伺服）。
pub(in crate::web) async fn discover_peers(Json(request): Json<DiscoverRequest>) -> Json<Value> {
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(1200).clamp(200, 3000));
    let peers = tokio::task::spawn_blocking(move || discover(timeout))
        .await
        .unwrap_or_default();
    Json(json!({ "peers": peers }))
}

/// 向局域网广播发现请求并收集应答（阻塞；调用方放进 blocking 线程）。
pub(in crate::web) fn discover(timeout: Duration) -> Vec<DiscoveredPeer> {
    let Ok(socket) = UdpSocket::bind(("0.0.0.0", 0)) else {
        return Vec::new();
    };
    let _ = socket.set_broadcast(true);
    for target in probe_targets() {
        let _ = socket.send_to(PROBE, target);
    }
    collect_announces(&socket, Instant::now() + timeout)
}

fn collect_announces(socket: &UdpSocket, deadline: Instant) -> Vec<DiscoveredPeer> {
    // 读超时必须由这里保证：调用方（含测试）忘了设，循环就会永远堵在 recv_from 上。
    let _ = socket.set_read_timeout(Some(Duration::from_millis(120)));
    let mut found: Vec<DiscoveredPeer> = Vec::new();
    let mut buffer = [0u8; MAX_PACKET];
    while Instant::now() < deadline {
        let Ok((size, from)) = socket.recv_from(&mut buffer) else {
            continue;
        };
        let Some(peer) = parse_announce(&buffer[..size], from) else {
            continue;
        };
        // 同一台电脑可能有线/无线各回一次：按 deviceId 去重，保留最先到的地址。
        if found.iter().any(|item| item.device_id == peer.device_id) {
            continue;
        }
        found.push(peer);
    }
    found
}

fn parse_announce(bytes: &[u8], from: SocketAddr) -> Option<DiscoveredPeer> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    if value.get("coomi")?.as_str()? != "announce" {
        return None;
    }
    let device_id = value.get("deviceId")?.as_str()?.trim().to_string();
    let port = value
        .get("port")?
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())?;
    if device_id.is_empty() || port == 0 {
        return None;
    }
    Some(DiscoveredPeer {
        device_id,
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // 只信数据报源地址：包里自称的地址可能来自另一张网卡。
        host: from.ip().to_string(),
        port,
        version: value
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

fn is_probe(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| {
            value
                .get("coomi")
                .and_then(Value::as_str)
                .map(|kind| kind == "discover")
        })
        .unwrap_or(false)
}

fn announce_payload(device_id: &str, name: &str, port: u16) -> String {
    json!({
        "coomi": "announce",
        "v": 1,
        "deviceId": device_id,
        "name": name,
        "port": port,
        "version": BRIDGE_VERSION,
    })
    .to_string()
}

/// 广播目标：受限广播 + **每张网卡**所在 /24 的定向广播。
///
/// 只发 255.255.255.255 会跟着默认路由走 —— 手机连着「无外网 Wi-Fi」时默认路由
/// 常常还在蜂窝上，广播就发去了移动网络，局域网里永远收不到。按网卡列出来逐个发，
/// 才能保证 Wi-Fi 那段一定被问到。有些路由器还会丢弃受限广播，定向广播同时补上。
fn probe_targets() -> Vec<SocketAddr> {
    let interfaces = local_ip_address::list_afinet_netifas().unwrap_or_default();
    probe_targets_for(interfaces.into_iter().filter_map(|(_, ip)| match ip {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }))
}

fn probe_targets_for(ips: impl IntoIterator<Item = Ipv4Addr>) -> Vec<SocketAddr> {
    let mut targets = vec![SocketAddr::from((Ipv4Addr::BROADCAST, DISCOVERY_PORT))];
    for ip in ips {
        let [a, b, c, _] = ip.octets();
        let subnet = Ipv4Addr::new(a, b, c, 255);
        if subnet == Ipv4Addr::BROADCAST {
            continue;
        }
        let target = SocketAddr::from((subnet, DISCOVERY_PORT));
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    targets
}

/// 常驻应答器：绑定固定 UDP 端口，谁问就回自己的 deviceId / 名字 / 端口。
///
/// 绑定失败（同机已经有一个引擎在应答）就安静退出：发现是尽力而为的能力，
/// 不能因为端口被占而影响引擎启动。
pub(in crate::web) fn spawn_responder(device_id: String, name: String, engine_port: u16) {
    std::thread::Builder::new()
        .name("coomi-discovery".into())
        .spawn(move || {
            let Ok(socket) = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) else {
                return;
            };
            serve_responder(socket, &announce_payload(&device_id, &name, engine_port));
        })
        .ok();
}

fn serve_responder(socket: UdpSocket, payload: &str) {
    let mut buffer = [0u8; MAX_PACKET];
    loop {
        let Ok((size, from)) = socket.recv_from(&mut buffer) else {
            continue;
        };
        if !is_probe(&buffer[..size]) {
            continue;
        }
        let _ = socket.send_to(payload.as_bytes(), from);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer_from(source: &str) -> SocketAddr {
        source.parse().expect("valid socket address")
    }

    #[test]
    fn announce_host_comes_from_datagram_source_not_payload() {
        let packet = r#"{"coomi":"announce","v":1,"deviceId":"dev_1","name":"书房电脑","host":"10.0.0.9","port":49217,"version":"1.0.0-rc68"}"#;
        let peer =
            parse_announce(packet.as_bytes(), peer_from("192.168.3.163:45871")).expect("announce parsed");
        assert_eq!(peer.host, "192.168.3.163");
        assert_eq!(peer.device_id, "dev_1");
        assert_eq!(peer.name, "书房电脑");
        assert_eq!(peer.port, 49217);
        assert_eq!(peer.version, "1.0.0-rc68");
    }

    #[test]
    fn non_announce_packets_are_ignored() {
        let from = peer_from("192.168.3.163:45871");
        assert!(parse_announce(PROBE, from).is_none());
        assert!(parse_announce(b"not json", from).is_none());
        assert!(parse_announce(br#"{"coomi":"announce","deviceId":"","port":1}"#, from).is_none());
        assert!(parse_announce(br#"{"coomi":"announce","deviceId":"dev","port":0}"#, from).is_none());
        assert!(parse_announce(br#"{"coomi":"announce","deviceId":"dev","port":70000}"#, from).is_none());
    }

    #[test]
    fn responder_answers_probe_and_ignores_other_traffic() {
        let responder = UdpSocket::bind(("127.0.0.1", 0)).expect("bind responder");
        let responder_addr = responder.local_addr().expect("responder addr");
        let payload = announce_payload("dev_1", "书房电脑", 49217);
        std::thread::spawn(move || serve_responder(responder, &payload));

        let client = UdpSocket::bind(("127.0.0.1", 0)).expect("bind client");
        client
            .set_read_timeout(Some(Duration::from_millis(250)))
            .expect("timeout");
        client.send_to(b"ping", responder_addr).expect("send noise");
        let mut buffer = [0u8; MAX_PACKET];
        assert!(
            client.recv_from(&mut buffer).is_err(),
            "非发现请求不应有任何应答"
        );

        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("timeout");
        client.send_to(PROBE, responder_addr).expect("send probe");
        let (size, from) = client.recv_from(&mut buffer).expect("announce reply");
        let peer = parse_announce(&buffer[..size], from).expect("parsed reply");
        assert_eq!(peer.device_id, "dev_1");
        assert_eq!(peer.name, "书房电脑");
        assert_eq!(peer.port, 49217);
        assert_eq!(from, responder_addr);
    }

    #[test]
    fn probe_targets_cover_every_interface_and_dedupe() {
        let targets = probe_targets_for([
            Ipv4Addr::new(192, 168, 3, 163),
            Ipv4Addr::new(192, 168, 3, 164),
            Ipv4Addr::new(10, 0, 0, 5),
        ]);
        assert!(targets.contains(&SocketAddr::from((Ipv4Addr::BROADCAST, DISCOVERY_PORT))));
        assert!(targets.contains(&SocketAddr::from((
            Ipv4Addr::new(192, 168, 3, 255),
            DISCOVERY_PORT
        ))));
        assert!(targets.contains(&SocketAddr::from((
            Ipv4Addr::new(10, 0, 0, 255),
            DISCOVERY_PORT
        ))));
        // 同网段的两个地址只产生一个广播目标。
        assert_eq!(
            targets
                .iter()
                .filter(|target| target.ip() == IpAddr::from(Ipv4Addr::new(192, 168, 3, 255)))
                .count(),
            1
        );
        assert_eq!(
            probe_targets_for([]),
            vec![SocketAddr::from((Ipv4Addr::BROADCAST, DISCOVERY_PORT))]
        );
    }

    #[test]
    fn duplicate_announces_keep_the_first_address() {
        let socket = UdpSocket::bind(("127.0.0.1", 0)).expect("bind");
        let reply = UdpSocket::bind(("127.0.0.1", 0)).expect("bind reply");
        let reply_addr = reply.local_addr().expect("reply addr");
        let client_addr = socket.local_addr().expect("client addr");

        std::thread::spawn(move || {
            reply.send_to(announce_payload("dev_1", "PC", 49001).as_bytes(), client_addr).ok();
            reply.send_to(announce_payload("dev_1", "PC", 49002).as_bytes(), client_addr).ok();
        });
        let found = collect_announces(&socket, Instant::now() + Duration::from_millis(300));
        assert_eq!(found.len(), 1, "同一台电脑只保留一个地址");
        assert_eq!(found[0].host, reply_addr.ip().to_string());
    }
}
