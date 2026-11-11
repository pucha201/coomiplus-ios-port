//! 逆向模式（Reverse Mode）· 引擎侧实现。
//!
//! 三家开源方案的融合点，逐条对应：
//!
//! | 来源 | 取什么 | 落到哪 |
//! |---|---|---|
//! | dsh-purge | 分层注入 + 身份段覆盖 + 段命名排序 | 契约进 `PromptLayer::Identity`，与 `custom_prompt` 同一层但排在它之后 |
//! | gpt6-Astra | 席位词包 / 事务化安装 / 幂等标记 | 契约按 flavor 分套，运行期摘要校验 + 状态可回滚 |
//! | L1B3RT4S | 格式契约 + 预填开头 + 路由表 + 禁用词表 | 契约的「输出契约」「任务路由」「自检行」三段 |
//!
//! 安全模型（写在最前面，因为它是这个文件唯一需要解释的设计）：
//!
//! `reverse_assets.rs` 里的契约是 XOR 掩码 + SHA-256 摘要。**这不是加密** ——
//! 客户端分发的源码里密钥必然可得，任何声称在这里做到加密的说法都是假的。
//! 它保证两件事：
//!   1. 明文字符串不出现在产物里，随手 `strings | grep` 或替换字符串改不动契约；
//!   2. 任何字节级篡改都会被摘要确定性检出，此时**拒绝注入**并把健康状态降级，
//!      顶栏盾牌转红 —— 篡改的结果是功能失效，而不是静默变成另一套行为。
//!
//! 这比「假装加密」诚实，也比「什么都不做」有用。

use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use super::reverse_assets;

/// 契约生效所需的前提。任一不满足就降级为「受限」而不是「正常」。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReverseHealth {
    /// 关着。顶栏不显示盾牌。
    Off,
    /// 开着且注入正常。
    Active,
    /// 开着但契约校验失败（被篡改 / 资产损坏）。**此时不注入**。
    Broken,
    /// 开着但前提不满足（只读权限 / 没有可用模型）。契约照常注入，
    /// 但工具会被拦，实际做不了事 —— 必须让用户看见。
    Restricted,
}

impl ReverseHealth {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Active => "active",
            Self::Broken => "broken",
            Self::Restricted => "restricted",
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Active,
            2 => Self::Broken,
            3 => Self::Restricted,
            _ => Self::Off,
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::Active => 1,
            Self::Broken => 2,
            Self::Restricted => 3,
        }
    }
}

/// 掩码解码：XOR 往返，逐字节独立，因此同一个函数既是解也是编码。
fn unmask(masked: &[u8]) -> Vec<u8> {
    masked
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ reverse_assets::MASK_KEY[index % reverse_assets::MASK_KEY.len()])
        .collect()
}

fn hex_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0F) as usize] as char);
    }
    out
}

/// 解码并校验一个口味的基础正文。
///
/// 返回 `Err(reason)` 的条件（都视为篡改或资产损坏，调用方必须拒绝注入）：
///   * 字节不是合法 UTF-8
///   * SHA-256 与资产里声明的摘要不符
///   * 正文为空
fn decode_body(flavor: &str) -> Result<String, String> {
    decode_asset(
        reverse_assets::body_for(flavor),
        reverse_assets::digest_for(flavor),
        &format!("body `{flavor}`"),
    )
}

/// 解码并校验一个可选片段。
fn decode_segment(segment: reverse_assets::ContractSegment) -> Result<String, String> {
    decode_asset(
        reverse_assets::segment_for(segment),
        reverse_assets::segment_digest(segment),
        &format!("segment `{}`", reverse_assets::segment_label(segment)),
    )
}

/// 掩码资产解码 + 摘要核对。基础正文与片段共用这一条路径，
/// 保证两边的校验强度一致（任何一份被改都会走到同一个 Err 分支）。
fn decode_asset(masked: &[u8], expected: &str, name: &str) -> Result<String, String> {
    if masked.is_empty() {
        return Err(format!("contract asset is empty: {name}"));
    }
    let raw = unmask(masked);
    let text = String::from_utf8(raw)
        .map_err(|_| format!("contract asset is not valid UTF-8: {name}"))?;
    if text.trim().is_empty() {
        return Err(format!("contract text is blank: {name}"));
    }
    let actual = hex_lower(&Sha256::digest(text.as_bytes()));
    if actual != expected {
        return Err(format!("contract digest mismatch for {name}"));
    }
    Ok(text)
}

/// 要注入哪些可选片段（位标志）。
///
/// 用位而不是三个 bool：`ReverseState` 里存在 `AtomicU8`，一次 CAS 就能整体替换，
/// 不会出现「strict 改了但 thinking 还没改」的中间态被 `contract_text` 读到。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SegmentFlags(u8);

impl SegmentFlags {
    pub const STRICT: u8 = 0b001;
    pub const THINKING: u8 = 0b010;
    pub const THINK_FREE: u8 = 0b100;
    /// 题类识别：按「问原理 / 问实现 / 问方案 / 问判断」分流，减少误伤。
    pub const ROUTE: u8 = 0b1000;

    pub fn none() -> Self {
        Self(0)
    }

    pub fn from_bits(bits: u8) -> Self {
        // 只保留已定义的位，未知位静默丢弃 —— 前端传了未来版本的标志时向后兼容。
        Self(bits & 0b1111)
    }

    pub fn bits(self) -> u8 {
        self.0
    }

    pub fn has(self, bit: u8) -> bool {
        self.0 & bit != 0
    }

    /// 按拼接顺序列出已启用的片段。
    ///
    /// 顺序是刻意设计的：先划边界（免合规），再分题型（题类识别），
    /// 再给方法（思考指引），最后压行为（严格）。
    /// 把严格模式放前面会让它的「不要在最终输出里评论」盖掉思考指引的五步清单。
    pub fn active(self) -> Vec<reverse_assets::ContractSegment> {
        use reverse_assets::ContractSegment as S;
        let mut out = Vec::new();
        if self.has(Self::THINK_FREE) {
            out.push(S::THINK_FREE);
        }
        if self.has(Self::ROUTE) {
            out.push(S::ROUTE);
        }
        if self.has(Self::THINKING) {
            out.push(S::THINKING);
        }
        if self.has(Self::STRICT) {
            out.push(S::STRICT);
        }
        out
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }
}

/// 一台连接（ConnectionContext）持有的逆向模式状态。
///
/// 放在连接上而不是全局，因为权限、模型、审计都属于「这个客户端现在在做什么」，
/// 跨客户端共享会互相污染（多设备同时连同一会话时尤其明显）。
#[derive(Debug)]
pub struct ReverseState {
    enabled: AtomicBool,
    /// 当前口味在 `reverse_assets::FLAVOR_KEYS` 里的下标。用整数而不是 String，
    /// 是为了让 `AtomicU8` 能装下 —— 口味表是编译期常量，下标足够。
    flavor_index: AtomicU8,
    /// 已启用的可选片段（位标志）。默认 0 = 只注入基础正文。
    segments: AtomicU8,
    /// 健康态。校验失败时写 `Broken`，`contract_text` 会因此返回 None。
    health: AtomicU8,
}

impl Default for ReverseState {
    fn default() -> Self {
        Self::new()
    }
}

impl ReverseState {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            flavor_index: AtomicU8::new(0),
            segments: AtomicU8::new(0),
            health: AtomicU8::new(ReverseHealth::Off.as_u8()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn segments(&self) -> SegmentFlags {
        SegmentFlags::from_bits(self.segments.load(Ordering::SeqCst))
    }

    pub fn is_strict(&self) -> bool {
        self.segments().has(SegmentFlags::STRICT)
    }

    pub fn health(&self) -> ReverseHealth {
        ReverseHealth::from_u8(self.health.load(Ordering::SeqCst))
    }

    pub fn flavor(&self) -> &'static str {
        let index = usize::from(self.flavor_index.load(Ordering::SeqCst));
        reverse_assets::FLAVOR_KEYS
            .get(index)
            .copied()
            .unwrap_or("generic")
    }

    /// 把外部传进来的口味名归一到合法下标。未知值一律回落 `generic`（下标 0）。
    fn normalize_flavor(flavor: &str) -> u8 {
        reverse_assets::FLAVOR_KEYS
            .iter()
            .position(|key| key.eq_ignore_ascii_case(flavor))
            .map_or(0, |index| index as u8)
    }

    /// 应用一次开关。`enabled=false` 时清成 Off，不保留上一次的 Broken。
    ///
    /// 前提不满足（只读 / 无模型）由调用方通过 `restricted` 传入 —— 这里不猜，
    /// 因为「有没有可用模型」只有 `run_turn` 里的 registry 说得准。
    pub fn apply(&self, enabled: bool, flavor: &str, restricted: bool) {
        self.apply_with_segments(enabled, flavor, self.segments(), restricted);
    }

    /// 带严格模式的应用：strict 映射到 STRICT 片段位（与 v5 端口后的调用点兼容）。
    pub fn apply_with_strict(&self, enabled: bool, flavor: &str, strict: bool, restricted: bool) {
        let bits = if strict {
            self.segments().bits() | SegmentFlags::STRICT
        } else {
            self.segments().bits() & !SegmentFlags::STRICT
        };
        self.apply_with_segments(enabled, flavor, SegmentFlags::from_bits(bits), restricted);
    }

    /// 带片段标志的应用。`segments` 决定追加哪些可选片段。
    pub fn apply_with_segments(
        &self,
        enabled: bool,
        flavor: &str,
        segments: SegmentFlags,
        restricted: bool,
    ) {
        self.flavor_index
            .store(Self::normalize_flavor(flavor), Ordering::SeqCst);
        self.segments.store(segments.bits(), Ordering::SeqCst);
        self.enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            self.health.store(ReverseHealth::Off.as_u8(), Ordering::SeqCst);
            return;
        }
        // 立刻做一次校验：坏资产要在「开启」这一刻就暴露，而不是等第一轮拼提示词
        // 时静默少一段 —— 后者用户完全看不见。
        let healthy = self.build_contract().is_ok();
        let next = if !healthy {
            ReverseHealth::Broken
        } else if restricted {
            ReverseHealth::Restricted
        } else {
            ReverseHealth::Active
        };
        self.health.store(next.as_u8(), Ordering::SeqCst);
    }

    /// 每轮刷新「受限」标志（权限或模型可能在轮次之间变了）。
    pub fn refresh_health(&self, restricted: bool) {
        if !self.is_enabled() {
            self.health.store(ReverseHealth::Off.as_u8(), Ordering::SeqCst);
            return;
        }
        if self.health() == ReverseHealth::Broken {
            return; // 坏了就是坏了，不会因为前提满足而自愈。
        }
        let next = if restricted {
            ReverseHealth::Restricted
        } else {
            ReverseHealth::Active
        };
        self.health.store(next.as_u8(), Ordering::SeqCst);
    }

    /// 按当前口味与片段标志拼出完整契约。
    ///
    /// 拼装顺序：基础正文 → 已启用的片段（顺序见 `SegmentFlags::active`）。
    /// 每份都独立核对摘要 —— 整体不设统一摘要，因为片段组合是运行时决定的。
    fn build_contract(&self) -> Result<String, String> {
        let mut out = decode_body(self.flavor())?;
        for segment in self.segments().active() {
            out.push_str(&decode_segment(segment)?);
        }
        Ok(out)
    }

    /// 本轮要注入的契约正文。**未开启或校验失败都返回 None**。
    ///
    /// 校验失败时同时把健康态降级 —— 这样只要有一轮发现坏，顶栏立刻转红，
    /// 不需要用户自己去猜为什么「开了但没反应」。
    pub fn contract_text(&self) -> Option<String> {
        if !self.is_enabled() {
            return None;
        }
        match self.build_contract() {
            Ok(text) => Some(text),
            Err(_) => {
                self.health.store(ReverseHealth::Broken.as_u8(), Ordering::SeqCst);
                None
            }
        }
    }

    /// 给前端的状态快照。
    pub fn snapshot(&self) -> serde_json::Value {
        let flags = self.segments();
        let active: Vec<&str> = flags
            .active()
            .into_iter()
            .map(reverse_assets::segment_label)
            .collect();
        // 契约摘要：拼接后全文的 SHA-256 前 8 位。给排障用 ——
        // 用户能拿它对照「我开了哪几个片段」，判断是不是某个片段在捣乱。
        let digest = self
            .build_contract()
            .map(|text| hex_lower(&Sha256::digest(text.as_bytes()))[..8].to_owned())
            .unwrap_or_default();
        serde_json::json!({
            "enabled": self.is_enabled(),
            "flavor": self.flavor(),
            "flavorLabel": reverse_assets::label_for(self.flavor()),
            "health": self.health().as_str(),
            "segments": {
                "strict": flags.has(SegmentFlags::STRICT),
                "thinkingGuide": flags.has(SegmentFlags::THINKING),
                "thinkingFree": flags.has(SegmentFlags::THINK_FREE),
                "routeGuide": flags.has(SegmentFlags::ROUTE),
            },
            "activeSegments": active,
            "contractDigest": digest,
            // 前端拿这个值直接忽略未知字段：以后加校验细节不会破坏兼容。
            "flavors": reverse_assets::FLAVOR_KEYS,
        })
    }
}

/// 自检：资产解码后必须逐份通过摘要。启动时跑一次，失败就在日志里吼一声，
/// 而不是等用户开了功能才发现。
///
/// 返回 (资产名, 字符数)。基础正文按口味逐份，可选片段逐份 —— 片段是运行时
/// 才拼进契约的，如果不在这里校验，坏片段会一直隐藏到用户打开对应开关那一刻。
pub fn verify_assets() -> Vec<(&'static str, Result<usize, String>)> {
    let mut out: Vec<(&'static str, Result<usize, String>)> = reverse_assets::FLAVOR_KEYS
        .iter()
        .map(|flavor| {
            let result = decode_body(flavor).map(|text| text.chars().count());
            (*flavor, result)
        })
        .collect();
    for segment in reverse_assets::SEGMENT_ORDER {
        let result = decode_segment(segment).map(|text| text.chars().count());
        out.push((reverse_assets::segment_label(segment), result));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_asset_decodes_and_matches_its_digest() {
        // 阈值分两档：基础正文是完整契约（5000+ 字），片段是可选段落（150~400 字）。
        // 统一用 200 会把「思考阶段免合规」这种偏短的片段误判成异常。
        let flavor_count = reverse_assets::FLAVOR_KEYS.len();
        for (index, (name, result)) in verify_assets().into_iter().enumerate() {
            let floor = if index < flavor_count { 200 } else { 100 };
            match result {
                Ok(chars) => assert!(
                    chars > floor,
                    "asset `{name}` is suspiciously short ({chars} <= {floor})"
                ),
                Err(reason) => panic!("asset `{name}` failed verification: {reason}"),
            }
        }
    }

    #[test]
    fn generic_is_the_first_flavor_and_the_fallback() {
        assert_eq!(reverse_assets::FLAVOR_KEYS.first().copied(), Some("generic"));
        assert_eq!(
            reverse_assets::digest_for("no-such-flavor"),
            reverse_assets::digest_for("generic")
        );
        assert_eq!(reverse_assets::label_for("no-such-flavor"), "通用");
    }

    #[test]
    fn unknown_flavor_normalizes_to_generic() {
        let state = ReverseState::new();
        state.apply(true, "totally-made-up", false);
        assert_eq!(state.flavor(), "generic");
        assert_eq!(state.health(), ReverseHealth::Active);
    }

    #[test]
    fn turning_off_clears_health_and_stops_injection() {
        let state = ReverseState::new();
        state.apply(true, "anthropic", false);
        assert_eq!(state.health(), ReverseHealth::Active);
        assert!(state.contract_text().is_some());
        state.apply(false, "anthropic", false);
        assert_eq!(state.health(), ReverseHealth::Off);
        assert!(state.contract_text().is_none());
    }

    #[test]
    fn restricted_is_reported_but_still_injects() {
        let state = ReverseState::new();
        state.apply(true, "generic", true);
        assert_eq!(state.health(), ReverseHealth::Restricted);
        // 受限不影响注入：提示词照给，只是工具会被安全策略拦。
        assert!(state.contract_text().is_some());
    }

    #[test]
    fn health_follows_precondition_changes_across_turns() {
        let state = ReverseState::new();
        state.apply(true, "generic", true);
        assert_eq!(state.health(), ReverseHealth::Restricted);
        state.refresh_health(false);
        assert_eq!(state.health(), ReverseHealth::Active);
        state.refresh_health(true);
        assert_eq!(state.health(), ReverseHealth::Restricted);
    }

    #[test]
    fn mask_round_trips_for_arbitrary_bytes() {
        let sample: Vec<u8> = (0..=255u8).collect();
        assert_eq!(unmask(&unmask(&sample)), sample);
    }

    #[test]
    fn snapshot_carries_the_fields_the_frontend_reads() {
        let state = ReverseState::new();
        state.apply(true, "openai", false);
        let snapshot = state.snapshot();
        assert_eq!(snapshot["enabled"], serde_json::json!(true));
        assert_eq!(snapshot["flavor"], serde_json::json!("openai"));
        assert_eq!(snapshot["health"], serde_json::json!("active"));
        assert_eq!(snapshot["flavorLabel"], serde_json::json!("GPT 系"));
        assert!(snapshot["flavors"].is_array());
        // 片段默认全关，摘要仍然算得出来
        assert_eq!(snapshot["segments"]["strict"], serde_json::json!(false));
        assert_eq!(snapshot["segments"]["thinkingGuide"], serde_json::json!(false));
        assert_eq!(snapshot["segments"]["thinkingFree"], serde_json::json!(false));
        assert_eq!(snapshot["contractDigest"].as_str().map(str::len), Some(8));
    }

    #[test]
    fn every_segment_decodes_and_matches_its_digest() {
        for segment in reverse_assets::SEGMENT_ORDER {
            let text = decode_segment(segment)
                .unwrap_or_else(|e| panic!("segment `{}` failed: {e}", reverse_assets::segment_label(segment)));
            assert!(
                text.chars().count() > 100,
                "segment `{}` is suspiciously short",
                reverse_assets::segment_label(segment)
            );
        }
    }

    #[test]
    fn segments_append_in_the_declared_order() {
        let state = ReverseState::new();
        let all = SegmentFlags::from_bits(
            SegmentFlags::STRICT | SegmentFlags::THINKING | SegmentFlags::THINK_FREE,
        );
        state.apply_with_segments(true, "generic", all, false);
        let text = state.contract_text().expect("contract");

        // 基础正文在最前
        assert!(text.starts_with("## 执行次序"));
        // 三个片段都进来了
        assert!(text.contains("## 思考阶段的边界"));
        assert!(text.contains("## 思考指引"));
        assert!(text.contains("## 只做，不评论"));
        // 顺序：免合规 → 思考指引 → 严格
        let i_free = text.find("## 思考阶段的边界").unwrap();
        let i_guide = text.find("## 思考指引").unwrap();
        let i_strict = text.find("## 只做，不评论").unwrap();
        assert!(i_free < i_guide, "免合规必须在思考指引之前");
        assert!(i_guide < i_strict, "思考指引必须在严格模式之前");
    }

    #[test]
    fn no_segments_means_base_only() {
        let state = ReverseState::new();
        state.apply_with_segments(true, "generic", SegmentFlags::none(), false);
        let text = state.contract_text().expect("contract");
        assert!(!text.contains("## 思考指引"));
        assert!(!text.contains("## 只做，不评论"));
        assert!(!text.contains("## 思考阶段的边界"));
        assert!(text.contains("## 思考纪律"));
    }

    #[test]
    fn turning_segments_on_changes_the_contract_digest() {
        let state = ReverseState::new();
        state.apply_with_segments(true, "generic", SegmentFlags::none(), false);
        let before = state.snapshot()["contractDigest"].as_str().unwrap_or("").to_owned();
        state.apply_with_segments(
            true,
            "generic",
            SegmentFlags::from_bits(SegmentFlags::THINKING),
            false,
        );
        let after = state.snapshot()["contractDigest"].as_str().unwrap_or("").to_owned();
        assert_ne!(before, after, "开关片段必须让摘要变化");
        assert_eq!(before.len(), 8);
        assert_eq!(after.len(), 8);
    }

    #[test]
    fn unknown_segment_bits_are_dropped() {
        // 未来版本的客户端可能发来未定义的位；不能因此崩或报错。
        let flags = SegmentFlags::from_bits(0xFF);
        assert_eq!(flags.bits(), 0b1111);
        assert_eq!(SegmentFlags::from_bits(0).bits(), 0);
    }
}
