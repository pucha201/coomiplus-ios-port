use crate::AutoCompactScope;
use crate::ChatMessage;
use crate::CompactionReason;
use crate::ContextStatus;
use crate::ContextWindowSource;
use crate::ModelCapabilities;
use crate::Role;
use crate::TokenUsage;
use crate::ToolSpec;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashSet;
use uuid::Uuid;

const BASELINE_TOKENS: u64 = 12_000;
const COMPACT_USER_MESSAGE_MAX_TOKENS: u64 = 20_000;
/// 压缩后强制逐字保留的「最近一对 user/assistant 原文」预算（token）。
/// 从 COMPACT_USER_MESSAGE_MAX_TOKENS 里切分，保证几条保留通道加起来不超总预算。
const COMPACT_LAST_EXCHANGE_MAX_TOKENS: u64 = COMPACT_USER_MESSAGE_MAX_TOKENS / 2;
/// pinned 消息的默认保留预算：约为保留总预算的 20%（调用方可用
/// compacted_history_with_budget 按「有效窗口的 20%」传更精确的预算）。
pub const COMPACT_PINNED_MAX_TOKENS: u64 = COMPACT_USER_MESSAGE_MAX_TOKENS / 5;
/// pinned 消息的条数上限（除 token 预算外的第二条保险）：
/// 只保留最新的这些条，防止「一堆很短的 pin」把条数撑爆。
pub const COMPACT_PINNED_MAX_MESSAGES: usize = 12;
/// 当前轮（最后一条真实 user 消息及其后）逐字保留的正文预算。
/// 压缩发生在工具轮之间时，这一轮的工具链就是模型「刚刚拿到的结果」；
/// 旧实现只强制保留「最后一对 user/assistant」，工具结果一多就整段消失 ——
/// 模型于是重复调用工具，或者把上一轮的问题当成当前问题来回答。
const CURRENT_TURN_TEXT_MAX_TOKENS: u64 = COMPACT_USER_MESSAGE_MAX_TOKENS;
/// 当前轮里单条正文字母的上限（与「最后一轮原文」同一口径）。
const CURRENT_TURN_MESSAGE_MAX_TOKENS: u64 = COMPACT_LAST_EXCHANGE_MAX_TOKENS;
/// 当前轮工具输出的总预算：超出时从最旧的开始换成截断占位，
/// 保留消息结构（调用 ↔ 结果配对不能断），优先保住最近的结果。
const CURRENT_TURN_TOOL_MAX_TOKENS: u64 = 48_000;
/// 单条工具输出在当前轮里的保留上限。
const CURRENT_TURN_TOOL_MESSAGE_MAX_TOKENS: u64 = 8_000;
/// 压缩时被截断的工具输出占位：明确告诉模型「内容还在会话文件里，可再取」，
/// 避免它把占位当成真实的空结果。
const COMPACTED_TOOL_PLACEHOLDER: &str =
    "[earlier tool output omitted during context compaction; read the file again if it is still needed]";
/// 压缩历史上限：只保留最近 50 条，超出的丢最旧（避免会话文件无界增长）。
pub const COMPACTION_HISTORY_LIMIT: usize = 50;
const CONTEXT_WINDOW_TRUNCATED_OUTPUT: &str =
    "Output exceeded the available model context and was truncated";

/// 结构化交接摘要模板：固定小节顺序、缺项写「无」。
/// 第 ⑥ 节要求逐字保留最近一轮原文，与 compacted_history 的「强制保留最后一对
/// user/assistant」互为兜底（提示词可能不听话，代码兜底一定生效）。
pub const SUMMARIZATION_PROMPT: &str = r#"你正在执行一次「上下文检查点压缩」。请为即将接手的另一个 LLM 生成结构化交接摘要，让它在不重读历史消息的前提下继续完成任务。

严格按下面 6 个小节的编号、标题与顺序输出（Markdown 二级标题），任何小节都不得省略；该小节没有内容时写「无」。不要新增其它小节，不要输出与这 6 节无关的内容。

## ① 用户偏好与硬性要求
列出用户明确的偏好与硬性要求（语言、技术栈、格式、验收标准、禁止事项）。逐条列出，并注明来自哪条用户消息。

## ② 已完成事项（含验证方式与结论）
逐条写：做了什么 → 用什么方式验证（命令/测试/人工检查）→ 结论或证据。没有验证过的不要写成已完成。

## ③ 未完成待办（有序、可执行）
按执行顺序编号。每条给出下一步的具体动作、涉及的文件或命令，以及「怎样算完成」的判据。

## ④ 关键文件与路径（绝对路径 + 变更摘要）
用绝对路径列出所有相关文件，并写清每个文件改了什么、当前状态（已改/未改/待确认）。不要只写文件名。

## ⑤ 约束与禁忌（权限、禁改目录、外部依赖）
写清沙箱与权限限制、禁止改动的目录或文件、必须依赖的外部服务或凭据、不可执行的操作。

## ⑥ 最近一轮原始消息
逐字保留：最后一条用户消息原文，以及最后一条助手结论原文。不要改写、不要概括、不要翻译、不要删减；消息过长可以截断，但必须保留原文措辞。

写作要求：精确优先于冗长；不要重复叙述；不要编造未发生的事实；路径必须可直接使用。"#;
/// 压缩摘要的固定抬头。
///
/// 关键约束（踩过的坑）：这段文字**不能**写成「另一个模型开始解决这个问题……下面是摘要」
/// 这种“交接模板”。它会被放进模型上下文；如果它排在请求末尾、或内容为空，模型会把
/// 它当成当前指令照抄，表现为只输出英文交接语、不调用工具。
/// 因此这里改成明确声明「这是背景、不是新请求」，并且摘要永远放在历史最前面。
pub const SUMMARY_PREFIX: &str = "[上下文检查点 / CONTEXT CHECKPOINT]\n以下是本会话更早工作的压缩摘要，由上下文压缩步骤生成。它是**背景资料**，不是用户的新请求，也不是要求切换任务；请继续处理会话中最后一条用户消息，只在需要避免重复已完成的工作时参考本摘要。\n\n--- 摘要开始 ---";

/// 判断摘要模型的输出是否可用。
///
/// 拒绝四类结果：空内容、复述交接模板（模型把“给下一个模型的说明”照抄回来）、
/// 复述新的中文抬头、以及降级占位文案。不可用时调用方必须走 trim 兜底，
/// 不能把这段文本当摘要塞进历史。
pub fn compaction_summary_is_usable(summary: &str) -> bool {
    let trimmed = summary.trim();
    if trimmed.is_empty() {
        return false;
    }
    // 模型把“摘要抬头”当成要续写的内容原样返回：开头就是抬头本身。
    if trimmed.starts_with(SUMMARY_PREFIX) || trimmed.starts_with("[上下文检查点") {
        return false;
    }
    const ECHO_MARKERS: [&str; 3] = [
        "Another language model started to solve this problem",
        "Here is the summary produced by the other language model",
        "[automatic compaction summary unavailable",
    ];
    !ECHO_MARKERS.iter().any(|marker| trimmed.contains(marker))
}

/// 一次上下文压缩的记账记录：随 Session 持久化，可从
/// GET /api/sessions/{id}/context 读到，用来解释「历史上为什么压缩、压缩掉多少」。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompactionRecord {
    /// 压缩完成的 Unix 毫秒时间戳。
    pub at_ms: u64,
    /// true = 自动触发，false = 用户手动触发。
    pub automatic: bool,
    /// 触发原因：percent / floor / messages / cache / provider_error / manual。
    pub reason: CompactionReason,
    /// 压缩前的用量占窗口比例（0~100）。
    #[serde(default)]
    pub used_percent: u8,
    /// 本次判定使用的上下文窗口（token）。
    #[serde(default)]
    pub window: u64,
    /// 压缩前的活跃上下文 token（估算）。
    pub before_tokens: u64,
    /// 压缩后的活跃上下文 token（估算）。
    pub after_tokens: u64,
    /// 压缩前的消息条数。
    pub messages_before: usize,
    /// 压缩后的消息条数。
    pub messages_after: usize,
}

impl CompactionRecord {
    /// 压缩开始时构造：after_* 先留 0，压缩完成后由 reset_after_compaction 补齐。
    pub fn started(
        automatic: bool,
        reason: CompactionReason,
        before_tokens: u64,
        messages_before: usize,
    ) -> Self {
        Self {
            at_ms: unix_time_ms(),
            automatic,
            reason,
            used_percent: 0,
            window: 0,
            before_tokens,
            after_tokens: 0,
            messages_before,
            messages_after: 0,
        }
    }

    /// 补上「压缩前的用量占比与窗口」：调用方在开始压缩时用能力算出占比。
    pub fn with_usage(mut self, used_percent: u8, window: u64) -> Self {
        self.used_percent = used_percent;
        self.window = window;
        self
    }

    fn finished(mut self, after_tokens: u64, messages_after: usize) -> Self {
        self.after_tokens = after_tokens;
        self.messages_after = messages_after;
        self
    }
}

fn unix_time_ms() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0)
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContextState {
    #[serde(default)]
    pub last_usage: TokenUsage,
    #[serde(default)]
    pub estimated_active_tokens: u64,
    #[serde(default)]
    pub compaction_count: u64,
    /// 压缩历史（最近 COMPACTION_HISTORY_LIMIT 条，超出的丢最旧）。
    /// 随会话持久化：GET /api/sessions/{id} 的 context 字段与
    /// /api/sessions/{id}/context 都能读到。
    #[serde(default)]
    pub compaction_history: Vec<CompactionRecord>,
    #[serde(default)]
    pub server_observed_local_tokens: u64,
    #[serde(default)]
    pub prefill_input_tokens: Option<u64>,
    #[serde(default)]
    pub comp_hash: Option<String>,
    #[serde(default)]
    pub first_window_id: Option<Uuid>,
    #[serde(default)]
    pub previous_window_id: Option<Uuid>,
    #[serde(default)]
    pub window_id: Option<Uuid>,
}

impl ContextState {
    pub fn observe_usage(
        &mut self,
        usage: &TokenUsage,
        system_prompt: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        capabilities: &ModelCapabilities,
    ) {
        self.last_usage = usage.clone();
        self.estimated_active_tokens = usage.total_tokens();
        self.server_observed_local_tokens = estimate_request_tokens(system_prompt, messages, tools);
        if capabilities.auto_compact_scope == AutoCompactScope::BodyAfterPrefix
            && self.prefill_input_tokens.is_none()
        {
            self.prefill_input_tokens = Some(usage.input_tokens);
        }
        self.comp_hash = capabilities.comp_hash.clone();
    }

    pub fn recompute(&mut self, system_prompt: &str, messages: &[ChatMessage], tools: &[ToolSpec]) {
        let local_tokens = estimate_request_tokens(system_prompt, messages, tools);
        self.estimated_active_tokens =
            if self.last_usage.total_tokens() > 0 && self.server_observed_local_tokens > 0 {
                self.last_usage
                    .total_tokens()
                    .saturating_add(local_tokens.saturating_sub(self.server_observed_local_tokens))
            } else {
                local_tokens
            };
    }

    /// 压缩完成后重置窗口状态，并把这次压缩写入 compaction_history。
    /// record 由调用方用 CompactionRecord::started(...) 构造（带 before/原因），
    /// after_tokens / messages_after 在这里按压缩后的实际状态补齐。
    pub fn reset_after_compaction(
        &mut self,
        system_prompt: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        capabilities: &ModelCapabilities,
        record: CompactionRecord,
    ) {
        let previous = self.window_id.unwrap_or_else(Uuid::new_v4);
        self.first_window_id.get_or_insert(previous);
        self.previous_window_id = Some(previous);
        self.window_id = Some(Uuid::new_v4());
        self.compaction_count = self.compaction_count.saturating_add(1);
        self.last_usage = TokenUsage::default();
        self.server_observed_local_tokens = 0;
        self.estimated_active_tokens = estimate_request_tokens(system_prompt, messages, tools);
        self.prefill_input_tokens = (capabilities.auto_compact_scope
            == AutoCompactScope::BodyAfterPrefix)
            .then_some(self.estimated_active_tokens);
        self.comp_hash = capabilities.comp_hash.clone();
        self.push_compaction_record(record.finished(self.estimated_active_tokens, messages.len()));
    }

    /// 记录一次压缩：只保留最近 COMPACTION_HISTORY_LIMIT 条，超出的丢最旧。
    pub fn push_compaction_record(&mut self, record: CompactionRecord) {
        self.compaction_history.push(record);
        if self.compaction_history.len() > COMPACTION_HISTORY_LIMIT {
            let excess = self.compaction_history.len() - COMPACTION_HISTORY_LIMIT;
            self.compaction_history.drain(..excess);
        }
    }

    pub fn auto_compact_scope_tokens(&self, capabilities: &ModelCapabilities) -> u64 {
        match capabilities.auto_compact_scope {
            AutoCompactScope::Total => self.estimated_active_tokens,
            AutoCompactScope::BodyAfterPrefix => self.estimated_active_tokens.saturating_sub(
                self.prefill_input_tokens
                    .unwrap_or(self.estimated_active_tokens),
            ),
        }
    }

    /// 自动压缩判定。返回 None 表示不需要压缩，Some(reason) 表示需要，
    /// 且带上是哪条条件触发的（写入压缩历史与 CompactionCompleted 事件）。
    ///
    /// 触发条件（按判定顺序）：
    /// 1. 用量达到窗口维度阈值 min(窗口 × auto_compact_percent, 有效窗口 − 保留区)
    ///    **且**达到绝对下限 auto_compact_floor_tokens（0 = 不启用下限）：
    ///    下限高于窗口阈值时报告 floor，否则报告 percent；
    /// 2. 用量直接超过窗口本身：窗口整体超限的兜底（下限只用来「不要过早压缩」）；
    /// 3. 系统提示 / 工具定义指纹变化（cache）；
    /// 4. 消息条数达到 message_limit（0 = 不启用），但**只有用量超过窗口 50% 时**
    ///    才检查条数条件：条数再多、上下文还很空的会话不该被压缩。
    pub fn should_compact(
        &self,
        capabilities: &ModelCapabilities,
        message_count: usize,
        message_limit: usize,
    ) -> Option<CompactionReason> {
        let used = self.estimated_active_tokens;
        let window_limit = capabilities.auto_compact_window_limit();
        let floor = capabilities.auto_compact_floor_tokens;
        if used >= capabilities.context_window {
            return Some(CompactionReason::Percent);
        }
        if self.auto_compact_scope_tokens(capabilities) >= window_limit
            && (floor == 0 || used >= floor)
        {
            return Some(if floor > window_limit {
                CompactionReason::Floor
            } else {
                CompactionReason::Percent
            });
        }
        if self
            .comp_hash
            .as_ref()
            .zip(capabilities.comp_hash.as_ref())
            .is_some_and(|(previous, current)| previous != current)
        {
            return Some(CompactionReason::Cache);
        }
        if message_limit > 0
            && message_count >= message_limit
            && used.saturating_mul(2) > capabilities.context_window
        {
            return Some(CompactionReason::Messages);
        }
        None
    }

    pub fn status(&self, capabilities: &ModelCapabilities) -> ContextStatus {
        let effective = capabilities.effective_context_window();
        let used = self.estimated_active_tokens;
        let remaining_percent = if effective <= BASELINE_TOKENS {
            0
        } else {
            let adjustable = effective - BASELINE_TOKENS;
            let adjustable_used = used.saturating_sub(BASELINE_TOKENS);
            u8::try_from(
                adjustable
                    .saturating_sub(adjustable_used)
                    .saturating_mul(100)
                    .saturating_div(adjustable)
                    .min(100),
            )
            .unwrap_or(0)
        };
        ContextStatus {
            used_tokens: used,
            context_window: capabilities.context_window,
            context_window_source: capabilities.context_window_source,
            effective_context_window: effective,
            // 展示「到多少 token 才会自动压缩」：窗口阈值与绝对下限取较大者。
            auto_compact_token_limit: capabilities.auto_compact_trigger_limit(),
            remaining_tokens: effective.saturating_sub(used),
            used_percent: 100u8.saturating_sub(remaining_percent),
            remaining_percent,
            auto_compact_scope_tokens: self.auto_compact_scope_tokens(capabilities),
            compaction_count: self.compaction_count,
        }
    }
}

pub fn normalize_history(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut known_calls = HashSet::new();
    for message in messages {
        if message.role == Role::Assistant {
            known_calls.extend(message.tool_calls.iter().map(|call| call.id.clone()));
        }
    }

    let output_ids = messages
        .iter()
        .filter(|message| message.role == Role::Tool)
        .filter_map(|message| message.tool_call_id.clone())
        .collect::<HashSet<_>>();
    let mut output = Vec::with_capacity(messages.len());
    for message in messages {
        if message.role == Role::Tool
            && message
                .tool_call_id
                .as_ref()
                .is_none_or(|id| !known_calls.contains(id))
        {
            continue;
        }
        // 丢弃「正文为空且没有任何工具调用」的 assistant 消息：OpenAI 兼容契约要求
        // content 与 tool_calls 至少设置其一，否则必 400（invalid_request_error:
        // content or tool_calls must be set），这类消息对 provider 也没有任何信息量。
        // 典型来源：轮次中断 / stream_reset 留下的空草稿、模型只思考没输出的轮次。
        // 注意：provider_items 非空的 assistant 是远端压缩的 compaction 载荷
        // （provider 层会特判展开进请求），不属于「空消息」，绝不能丢。
        if message.role == Role::Assistant
            && message.content.trim().is_empty()
            && message.tool_calls.is_empty()
            && message.provider_items.is_empty()
        {
            continue;
        }
        output.push(message.clone());
        if message.role == Role::Assistant {
            for call in &message.tool_calls {
                if !output_ids.contains(&call.id) {
                    output.push(ChatMessage::tool(&call.id, "error: aborted"));
                }
            }
        }
    }
    output
}

pub fn estimate_request_tokens(
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
) -> u64 {
    let mut bytes = estimate_text_tokens(system_prompt) as u64;
    for message in messages {
        bytes = bytes
            .saturating_add(estimate_text_tokens(&message.content) as u64)
            .saturating_add(32);
        for call in &message.tool_calls {
            bytes = bytes
                .saturating_add(estimate_text_tokens(&call.name) as u64)
                .saturating_add(estimate_text_tokens(&call.arguments.to_string()) as u64)
                .saturating_add(24);
        }
        for item in &message.provider_items {
            bytes = bytes.saturating_add(estimate_text_tokens(&item.to_string()) as u64);
        }
        for image in &message.images {
            bytes = bytes
                .saturating_add(estimate_text_tokens(&image.media_type) as u64)
                // 图片 base64 数据不计入 token 预算：全量数据会撑爆估算，
                // 导致「读一张图就触发上下文压缩」。每张图按固定 ~85 token 估算。
                .saturating_add(85 * 4);
        }
    }
    for tool in tools {
        bytes = bytes
            .saturating_add(estimate_text_tokens(&tool.name) as u64)
            .saturating_add(estimate_text_tokens(&tool.description) as u64)
            .saturating_add(estimate_text_tokens(&tool.parameters.to_string()) as u64);
    }
    bytes
}

/// 分层滚动摘要：
/// - 长期层：历史压缩时生成的旧 summary（若有）先保留，让模型能回溯“更早的共识”；
/// - 中期层：本轮新总结（SUMMARY_PREFIX + 当前 summary）；
/// - 近期层：最近的原文尾段（retained_user_history）。
/// 多次压缩后形成「久远共识 + 近况总结 + 最近原文」的三层上下文。
pub fn compacted_history(messages: &[ChatMessage], summary: &str) -> Vec<ChatMessage> {
    compacted_history_with_budget(
        messages,
        summary,
        COMPACT_PINNED_MAX_TOKENS,
        usize::MAX,
    )
}

/// 同 compacted_history，但由调用方给出 pinned 保留预算与「近期原文最多保留多少条」。
/// 生产调用点（agent.rs）传「有效窗口的 20%」和 auto_compact_message_limit 的一半：
/// 压缩必须把消息条数压到阈值以下，否则下一轮立刻再次触发压缩（每轮多一次模型调用）。
pub fn compacted_history_with_budget(
    messages: &[ChatMessage],
    summary: &str,
    pinned_budget_tokens: u64,
    max_retained_messages: usize,
) -> Vec<ChatMessage> {
    // 0) 当前轮整体逐字保留：从最后一条真实用户消息到末尾（含本轮全部工具调用与结果）。
    //
    //    旧实现只强制保留「最后一对 user/assistant」，于是「用户提问 → 工具A → 工具B →
    //    …」这种轮次在压缩后只剩下提问和一句旧回复：模型看不到刚刚拿到的工具结果，
    //    会重复执行已经完成的工具；如果这一轮还没有助手正文，请求的最后一条就变成了
    //    上一轮的旧提问 —— 表现为「AI 读取之前的上下文，当现在的问题来回答」。
    //
    //    工具输出按预算截断而不是整条丢弃：assistant.tool_calls / tool 结果的配对必须
    //    保持完整（打断配对会被 normalize_history 补成合成失败）。
    let current_turn_start = messages.iter().rposition(|message| {
        message.role == Role::User && !message.internal && !message.compaction_summary
    });
    let (history, mut current_turn) = match current_turn_start {
        Some(index) => (&messages[..index], messages[index..].to_vec()),
        None => (messages, Vec::new()),
    };
    let has_current_turn = !current_turn.is_empty();
    if has_current_turn {
        cap_current_turn(&mut current_turn);
    }
    // 没有「当前轮」的极端情况（只有系统/工具消息）沿用旧的尾段兜底。
    let current_turn_tokens: u64 = current_turn
        .iter()
        .map(|message| estimate_text_tokens(&message.content))
        .fold(0, u64::saturating_add);
    let (tail, tail_indices, tail_tokens) = if has_current_turn {
        (Vec::new(), HashSet::new(), 0)
    } else {
        let (tail, indices, tokens) =
            last_exchange_verbatim(messages, COMPACT_LAST_EXCHANGE_MAX_TOKENS);
        (tail, indices, tokens)
    };
    // 摘要本身也占预算：从近期原文预算里扣掉当前轮与强制尾段，
    // 否则「摘要 + 当前轮」就能把有效窗口重新吃满，下一轮立刻二次压缩。
    let mut retained = retained_user_history_inner(
        history,
        COMPACT_USER_MESSAGE_MAX_TOKENS
            .saturating_sub(tail_tokens)
            .saturating_sub(current_turn_tokens),
        pinned_budget_tokens,
        max_retained_messages,
        &tail_indices,
    );
    retained.extend(tail);
    if has_current_turn {
        retained.extend(current_turn);
    }
    // 长期层：上一次压缩留下的 summary（只保留最旧的一条作为“长期共识”）。
    let prior_summary = history
        .iter()
        .find(|message| message.compaction_summary && !message.internal);
    // 压缩是逐条挑选的：先配平「调用 ↔ 结果」，再挂摘要 —— 否则模型会看到悬空调用，
    // 下一轮被 normalize_history 补成合成的 `error: aborted`，等于告诉它"这一步失败了"。
    enforce_tool_call_pairing(&mut retained);
    // 摘要在**最前面**，真实对话在后；最后一条永远是最近一轮真实消息（通常就是用户提问）。
    // 旧实现把新摘要 push 到末尾，于是请求的最后一条 user 消息是一段英文交接语：
    // 模型会把“给下一个模型的说明”当成当前任务去续写，表现为只复述、不调工具。
    //
    // 多条摘要合并成**一条** System 消息：如果旧摘要、新摘要各占一条系统消息，
    // 请求里会出现 3+ 条 system（主提示 + 旧摘要 + 新摘要）；OpenAI 兼容网关大多
    // 能接受，但严格网关会直接 400。合并后最多 2 条 system，兼容性最好。
    let mut summary_block = String::new();
    if let Some(prior) = prior_summary {
        // 旧摘要只作为“长期共识”保留一小段：多轮压缩后它可能很长，原样带进
        // 新上下文会挤占预算、甚至让压缩后的历史仍超窗口。
        let prior_text = truncate_text_to_tokens(prior.content.trim(), 8_000);
        if !prior_text.trim().is_empty() {
            summary_block.push_str(prior_text.trim());
            summary_block.push_str("\n\n");
        }
    }
    summary_block.push_str(SUMMARY_PREFIX);
    summary_block.push('\n');
    summary_block.push_str(summary.trim());
    let mut compacted = Vec::with_capacity(retained.len() + 1);
    compacted.push(ChatMessage::summary(summary_block));
    compacted.append(&mut retained);
    compacted
}

/// 当前轮预算收缩：正文保留开头（用户请求 / 结论通常在最前面），
/// 工具输出按「从新到旧」分配预算，超出的旧结果换成占位符但保留消息本身，
/// 这样调用 ↔ 结果的配对永远不会被打断。
fn cap_current_turn(messages: &mut [ChatMessage]) {
    let mut text_remaining = CURRENT_TURN_TEXT_MAX_TOKENS;
    for message in messages.iter_mut().rev() {
        if message.internal || message.compaction_summary {
            continue;
        }
        let is_text = message.role == Role::User
            || (message.role == Role::Assistant && !message.content.trim().is_empty());
        if !is_text {
            continue;
        }
        let tokens = estimate_text_tokens(&message.content);
        // 预算耗尽后仍保留一小段开头：整条丢掉等于把这一轮的提问删掉，
        // 模型会拿上一轮的问题当当前问题回答。
        let budget = CURRENT_TURN_MESSAGE_MAX_TOKENS.min(text_remaining.max(512));
        if tokens > budget {
            message.content = truncate_text_head_to_tokens(&message.content, budget);
        }
        text_remaining = text_remaining.saturating_sub(estimate_text_tokens(&message.content));
    }
    let mut tool_remaining = CURRENT_TURN_TOOL_MAX_TOKENS;
    for message in messages.iter_mut().rev() {
        if message.role != Role::Tool {
            continue;
        }
        let tokens = estimate_text_tokens(&message.content);
        if tool_remaining == 0 {
            if message.content != COMPACTED_TOOL_PLACEHOLDER {
                message.content = COMPACTED_TOOL_PLACEHOLDER.into();
            }
            continue;
        }
        let budget = CURRENT_TURN_TOOL_MESSAGE_MAX_TOKENS.min(tool_remaining);
        if tokens > budget {
            message.content = truncate_text_head_to_tokens(&message.content, budget);
        }
        tool_remaining = tool_remaining.saturating_sub(estimate_text_tokens(&message.content));
    }
}

/// 远端（厂商侧）压缩返回的列表可能只保留「摘要 + 若干旧消息」，把当前轮
/// （最后一条用户提问及其后的工具链）整段丢掉。这里以本地历史为准，把返回结果里
/// 缺失的当前轮消息按原顺序补回末尾 —— 保证请求的最后一条永远是用户此刻的问题。
pub fn ensure_current_turn_preserved(
    original: &[ChatMessage],
    mut compacted: Vec<ChatMessage>,
) -> Vec<ChatMessage> {
    let Some(start) = original
        .iter()
        .rposition(|message| message.role == Role::User && !message.internal && !message.compaction_summary)
    else {
        return compacted;
    };
    let present: HashSet<String> = compacted
        .iter()
        .filter(|message| !message.id.is_empty())
        .map(|message| message.id.clone())
        .collect();
    for message in &original[start..] {
        // 空 id 无法去重：只补「最后一条用户消息」这一条，避免重复整段工具链。
        let missing = if message.id.is_empty() {
            message.role == Role::User
                && compacted.last().is_none_or(|last| last.content != message.content)
        } else {
            !present.contains(&message.id)
        };
        if missing {
            compacted.push(message.clone());
        }
    }
    compacted
}

/// 压缩后的一致性收口：保证保留下来的历史里，「带 tool_calls 的 assistant」与
/// 「对应的 tool 结果」要么都在、要么都不在。
///
/// 为什么需要：挑选逻辑（retained_user_history_inner / last_exchange_verbatim）按预算与
/// 条数上限逐条决定去留，一条带 tool_calls 的 assistant 可能活下来，而它的 tool 结果因为
/// 超过 4000 token 或预算耗尽被丢掉。这样的历史发给厂商会被判非法；引擎侧的
/// normalize_history 也只会补一条合成的 `error: aborted`，于是模型看到的是一个**假失败**，
/// 会重复已经完成的操作，或者干脆放弃。
fn enforce_tool_call_pairing(messages: &mut Vec<ChatMessage>) {
    // ① 先算出"活下来的 assistant 到底声明了哪些调用"。
    let declared: HashSet<String> = messages
        .iter()
        .filter(|message| message.role == Role::Assistant)
        .flat_map(|message| message.tool_calls.iter().map(|call| call.id.clone()))
        .collect();
    // ② 结果丢了调用的 tool 消息留着没用（normalize_history 也会丢掉它），先清掉，省预算。
    messages.retain(|message| {
        message.role != Role::Tool
            || message
                .tool_call_id
                .as_ref()
                .is_some_and(|id| declared.contains(id))
    });
    // ③ 反向：调用没等到结果的，从 assistant 上摘掉；摘空且没有正文的整条丢弃。
    let survived: HashSet<String> = messages
        .iter()
        .filter(|message| message.role == Role::Tool)
        .filter_map(|message| message.tool_call_id.clone())
        .collect();
    messages.retain_mut(|message| {
        if message.role != Role::Assistant || message.tool_calls.is_empty() {
            return true;
        }
        message.tool_calls.retain(|call| survived.contains(&call.id));
        !(message.tool_calls.is_empty() && message.content.trim().is_empty())
    });
}

/// 最后一轮原文：最后一条真实用户消息 + 最后一条有正文的助手结论，
/// 按原顺序返回。逐字保留（只在超过 budget 时做尾部截断），
/// 同时返回它们的下标（供其它保留通道去重）。
fn last_exchange_verbatim(
    messages: &[ChatMessage],
    budget: u64,
) -> (Vec<ChatMessage>, HashSet<usize>, u64) {
    let user_index = messages
        .iter()
        .rposition(|message| message.role == Role::User && !message.internal && !message.compaction_summary);
    let assistant_index = messages.iter().rposition(|message| {
        message.role == Role::Assistant
            && !message.content.trim().is_empty()
            && !message.compaction_summary
    });
    let mut indices: Vec<usize> = [user_index, assistant_index].into_iter().flatten().collect();
    indices.sort_unstable();
    indices.dedup();
    let mut used = 0_u64;
    let mut retained = Vec::with_capacity(indices.len());
    for index in &indices {
        let mut message = messages[*index].clone();
        if estimate_text_tokens(&message.content) > budget {
            // 保留开头：用户原话与结论的关键信息都在最前面。
            message.content = truncate_text_head_to_tokens(&message.content, budget);
        }
        used = used.saturating_add(estimate_text_tokens(&message.content));
        retained.push(message);
    }
    (retained, indices.into_iter().collect(), used)
}

/// 同 retained_user_history，但额外限制「近期原文」保留条数：
/// 兜底裁剪（摘要不可用）时用它把消息条数压到阈值以下，避免下一轮立刻再次触发压缩。
pub fn retained_user_history_with_count(
    messages: &[ChatMessage],
    pinned_budget_tokens: u64,
    max_retained_messages: usize,
) -> Vec<ChatMessage> {
    retained_user_history_inner(
        messages,
        COMPACT_USER_MESSAGE_MAX_TOKENS,
        pinned_budget_tokens,
        max_retained_messages,
        &HashSet::new(),
    )
}

/// 保留最近一段真实对话尾段（用户消息 + 关键 assistant 文本 + 小型 tool 结果），
/// 让压缩后的模型既有 summary 全局视角，又能看到“最近到底发生了什么”。
pub fn retained_user_history(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    retained_user_history_inner(
        messages,
        COMPACT_USER_MESSAGE_MAX_TOKENS,
        COMPACT_PINNED_MAX_TOKENS,
        usize::MAX,
        &HashSet::new(),
    )
}

/// 保留逻辑（压缩输出与远端压缩请求共用）：
/// 1) pinned 消息优先：从最新往旧累加到 pinned_budget，超预算的按时间倒序丢弃
///    （保留较新的置顶消息），避免置顶内容无限膨胀、把整段历史都钉死在上下文里；
/// 2) 再用剩余预算保留最近的原文尾段（原有行为）；
/// 3) skip 里的下标（例如已由「最后一轮原文」通道保留）不重复保留；
/// 4) max_retained_messages 限制「近期原文」保留的条数（pinned 另有
///    COMPACT_PINNED_MAX_MESSAGES 条数上限），保证压缩后条数确实下降。
/// 这条工具结果看着像"失败"吗？压缩时用它决定要不要优先保留 ——
/// 判据刻意保守（只看开头一小段），避免把正常输出误判成失败而挤占预算。
fn looks_like_failure(content: &str) -> bool {
    let head: String = content.trim_start().chars().take(200).collect();
    head.starts_with("error")
        || head.starts_with("Error")
        || head.starts_with("失败")
        || head.starts_with("拒绝")
        || head.contains("was not approved")
        || head.contains("\"ok\": false")
        || head.contains("\"ok\":false")
}

fn retained_user_history_inner(
    messages: &[ChatMessage],
    budget: u64,
    pinned_budget_tokens: u64,
    max_retained_messages: usize,
    skip: &HashSet<usize>,
) -> Vec<ChatMessage> {
    let mut chosen: Vec<(usize, ChatMessage)> = Vec::new();
    let mut remaining = budget;
    let mut pinned_remaining = pinned_budget_tokens;
    let mut pinned_kept = 0_usize;
    let mut recent_kept = 0_usize;
    // 所有参与 pinned 通道的下标：超预算被丢弃的 pinned 消息不再走下面的
    // 「近期原文」通道补回来，否则 pinned 上限形同虚设。
    let mut pinned_considered: HashSet<usize> = HashSet::new();
    for index in (0..messages.len()).rev() {
        if skip.contains(&index) {
            continue;
        }
        let message = &messages[index];
        if message.compaction_summary || message.internal || !message.pinned {
            continue;
        }
        pinned_considered.insert(index);
        let tokens = estimate_text_tokens(&message.content);
        if tokens > pinned_remaining || tokens > remaining {
            continue;
        }
        if pinned_kept >= COMPACT_PINNED_MAX_MESSAGES {
            continue;
        }
        pinned_remaining = pinned_remaining.saturating_sub(tokens);
        remaining = remaining.saturating_sub(tokens);
        pinned_kept += 1;
        chosen.push((index, message.clone()));
    }
    // 失败优先：含失败的「assistant 调用 + tool 结果」对要尽量留下 —— 模型靠这些错误痕迹
    // 更新信念、避免重复犯错（"leave the wrong turns in the context"）。给它们一小块
    // 专用预算，不挤占正常的近期原文，也绝不留成孤儿的 tool 消息。
    let mut error_budget: u64 = 2_000;
    for index in (0..messages.len()).rev() {
        if error_budget == 0 {
            break;
        }
        if skip.contains(&index) || pinned_considered.contains(&index) {
            continue;
        }
        let message = &messages[index];
        if message.role != Role::Tool || !looks_like_failure(&message.content) {
            continue;
        }
        if chosen.iter().any(|(kept, _)| *kept == index) {
            continue;
        }
        // 孤儿 tool 结果会被配对收口丢掉，所以连它的调用方一起带上。
        let owner = message.tool_call_id.as_ref().and_then(|call_id| {
            messages[..index].iter().rposition(|candidate| {
                candidate.role == Role::Assistant
                    && candidate
                        .tool_calls
                        .iter()
                        .any(|call| &call.id == call_id)
            })
        });
        let tokens = estimate_text_tokens(&message.content).min(error_budget);
        error_budget = error_budget.saturating_sub(tokens);
        chosen.push((index, message.clone()));
        if let Some(owner) = owner
            && !skip.contains(&owner)
            && !chosen.iter().any(|(kept, _)| *kept == owner)
        {
            chosen.push((owner, messages[owner].clone()));
        }
    }
    for index in (0..messages.len()).rev() {
        if remaining == 0 || recent_kept >= max_retained_messages {
            break;
        }
        if skip.contains(&index) || pinned_considered.contains(&index) {
            continue;
        }
        let message = &messages[index];
        if message.compaction_summary || message.internal {
            continue;
        }
        let tokens = estimate_text_tokens(&message.content);
        if message.role == Role::User
            || (message.role == Role::Assistant && !message.content.is_empty())
        {
            if tokens <= remaining {
                remaining = remaining.saturating_sub(tokens);
                recent_kept += 1;
                chosen.push((index, message.clone()));
            } else {
                let mut truncated = message.clone();
                truncated.content = if message.role == Role::User {
                    // 用户提问保留开头：截尾会把「他在问什么」整段截掉。
                    truncate_text_head_to_tokens(&message.content, remaining)
                } else {
                    truncate_text_to_tokens(&message.content, remaining)
                };
                recent_kept += 1;
                chosen.push((index, truncated));
                break;
            }
            continue;
        }
        if message.role == Role::Tool && tokens <= 4_000 && tokens <= remaining {
            remaining = remaining.saturating_sub(tokens);
            recent_kept += 1;
            chosen.push((index, message.clone()));
        }
    }
    chosen.sort_by_key(|(index, _)| *index);
    chosen.into_iter().map(|(_, message)| message).collect()
}

pub fn trim_history_to_fit(
    system_prompt: &str,
    messages: &mut Vec<ChatMessage>,
    tools: &[ToolSpec],
    token_limit: u64,
) -> usize {
    let mut rewritten = 0;
    for index in 0..messages.len() {
        if estimate_request_tokens(system_prompt, messages, tools) <= token_limit {
            break;
        }
        let message = &mut messages[index];
        // pinned 消息是用户/引擎明确要求保留的原文，不参与工具输出裁剪。
        if message.role != Role::Tool || message.pinned {
            continue;
        }
        if message.content != CONTEXT_WINDOW_TRUNCATED_OUTPUT {
            message.content = CONTEXT_WINDOW_TRUNCATED_OUTPUT.into();
            rewritten += 1;
        }
    }
    // 裁剪必须能收敛。normalize_history 会为「有 tool_calls 却缺结果」的 assistant
    // 补回一条合成的 tool 消息，因此存在「删掉 → 又补回 → 状态与上一轮完全相同」的
    // 情况；旧实现没有迭代上限，会一直占着这个 worker 不返回（界面表现为一直转圈）。
    // 这里用「非 pinned 条数是否严格下降」当进度判据，再加一道硬上限兜底。
    let max_rounds = messages.len().saturating_add(4);
    let mut rounds = 0usize;
    while messages.len() > 1
        && estimate_request_tokens(system_prompt, messages, tools) > token_limit
    {
        rounds += 1;
        if rounds > max_rounds {
            break;
        }
        // 优先丢最旧的「非 pinned」消息；只剩 pinned 时停止裁剪，
        // 让置顶内容优先活下来（超限由模型侧窗口兜底，而不是静默丢掉置顶）。
        let Some(index) = messages.iter().position(|message| !message.pinned) else {
            break;
        };
        let before = messages.iter().filter(|message| !message.pinned).count();
        messages.remove(index);
        *messages = normalize_history(messages);
        if messages.iter().filter(|message| !message.pinned).count() >= before {
            // 这一轮没有取得任何进展：再删下去只会原地打转，停下交由模型侧窗口兜底。
            break;
        }
    }
    if estimate_request_tokens(system_prompt, messages, tools) > token_limit
        && let Some(message) = messages.first_mut()
        && !message.pinned
    {
        let fixed = estimate_request_tokens(system_prompt, &[], tools);
        message.content =
            truncate_text_to_tokens(&message.content, token_limit.saturating_sub(fixed));
    }
    rewritten
}

/// 文本 token 估算。
///
/// 关键修正：以前一律按「字节数 / 4」估。这对英文合理，对**中文差约 4 倍** ——
/// 一个汉字 3 字节，`3/4` 只算 1 token 的零头，于是中文会话会在窗口早已超限时
/// 才触发压缩（表现为「上下文超限报错 / 压缩来得太晚」）。
/// 现在：CJK 与全角字符按 ~1 token/字，其余按 ~4 字节/token。
fn estimate_text_tokens(value: &str) -> u64 {
    let mut wide_tokens: u64 = 0;
    let mut narrow_bytes: u64 = 0;
    for ch in value.chars() {
        if is_wide_char(ch) {
            wide_tokens = wide_tokens.saturating_add(1);
        } else {
            narrow_bytes = narrow_bytes.saturating_add(u64::try_from(ch.len_utf8()).unwrap_or(1));
        }
    }
    wide_tokens.saturating_add(narrow_bytes.saturating_add(3) / 4)
}

/// 宽字符（CJK 汉字 / 假名 / 谚文 / 全角标点 / 扩展区）：信息密度高，约 1 token 一个字。
fn is_wide_char(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x20000..=0x3FFFD)
}

/// 保留开头、截掉尾部。用于「提问 / 结论」这类开头就是关键信息的文本：
/// 保留尾部会把用户的原话整段换成一串相同字符，模型反而看不出他在问什么。
fn truncate_text_head_to_tokens(value: &str, max_tokens: u64) -> String {
    let max_bytes = usize::try_from(max_tokens.saturating_mul(4)).unwrap_or(usize::MAX);
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let marker = "\n[later content truncated]";
    let keep = max_bytes.saturating_sub(marker.len());
    let mut end = keep.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{marker}", &value[..end])
}

fn truncate_text_to_tokens(value: &str, max_tokens: u64) -> String {
    let max_bytes = usize::try_from(max_tokens.saturating_mul(4)).unwrap_or(usize::MAX);
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let marker = "[earlier content truncated]\n";
    let keep = max_bytes.saturating_sub(marker.len());
    let mut start = value.len().saturating_sub(keep);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    format!("{marker}{}", &value[start..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolCall;
    use serde_json::json;

    #[test]
    fn normalization_pairs_calls_and_drops_orphans() {
        let messages = vec![
            ChatMessage::assistant(
                "",
                vec![ToolCall {
                    id: "one".into(),
                    name: "read_file".into(),
                    arguments: json!({}),
                }],
            ),
            ChatMessage::tool("orphan", "ignored"),
        ];
        let normalized = normalize_history(&messages);
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[1].tool_call_id.as_deref(), Some("one"));
        assert!(normalized[1].content.contains("aborted"));
    }

    #[test]
    fn normalization_drops_empty_assistant_messages() {
        // 空正文且无工具调用的 assistant 消息（中断/stream_reset 残留、只思考没输出的
        // 轮次）：对 provider 必 400，必须整体丢弃。
        let messages = vec![
            ChatMessage::user("question"),
            ChatMessage::assistant("", Vec::new()),
            ChatMessage::assistant("   ", Vec::new()),
            ChatMessage::assistant("real answer", Vec::new()),
        ];
        let normalized = normalize_history(&messages);
        // 输入 4 条：user + 两条空 assistant + 一条有正文的 assistant，空的两条被丢。
        assert_eq!(normalized.len(), 2);
        assert!(normalized.iter().all(|m| m.role != Role::Assistant
            || !m.content.trim().is_empty()
            || !m.tool_calls.is_empty()));
        // 有正文或有工具调用的 assistant 消息不受影响（配对逻辑原样保留）。
        let with_calls = vec![
            ChatMessage::assistant(
                "",
                vec![ToolCall {
                    id: "call".into(),
                    name: "read_file".into(),
                    arguments: json!({}),
                }],
            ),
            ChatMessage::tool("call", "ok"),
        ];
        let normalized_calls = normalize_history(&with_calls);
        assert_eq!(normalized_calls.len(), 2);
        assert!(normalized_calls[0].tool_calls.iter().any(|c| c.id == "call"));
    }

    #[test]
    fn normalization_keeps_provider_item_messages() {
        // provider_item（assistant 角色、空正文）承载远端压缩的 compaction 载荷，
        // provider 层会特判展开，不是「空消息」，绝不能丢。
        let messages = vec![
            ChatMessage::provider_item(json!({"type": "compaction", "id": "c1"})),
            ChatMessage::user("after"),
        ];
        let normalized = normalize_history(&messages);
        assert_eq!(normalized.len(), 2);
        assert!(!normalized[0].provider_items.is_empty());
    }

    #[test]
    fn compacted_history_keeps_real_user_messages_and_one_summary() {
        let messages = vec![
            ChatMessage::user("first"),
            ChatMessage::summary(format!("{SUMMARY_PREFIX}\nold")),
            ChatMessage::assistant("answer", Vec::new()),
            ChatMessage::user("second"),
        ];
        let compacted = compacted_history(&messages, "new");
        // 摘要必须在最前面（系统上下文区），不能是最后一条消息：
        // 否则模型会把交接说明当成当前请求来续写。
        assert!(compacted.first().expect("summary").compaction_summary);
        assert!(!compacted.last().expect("last message").compaction_summary);
        // 两条真实用户消息都保留：一条来自近期保留，一条来自「最后一轮原文」强制保留。
        assert!(compacted.iter().any(|m| m.content == "first"));
        assert!(compacted.iter().any(|m| m.content == "second"));
        // 长期层旧摘要 + 新摘要合并成**一条** System 消息（避免请求里出现
        // 3+ 条 system，严格网关会 400）；内容里两者都要在。
        let summaries: Vec<_> = compacted
            .iter()
            .filter(|m| m.compaction_summary)
            .collect();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].role, Role::System);
        assert!(summaries[0].content.contains("old"));
        assert!(summaries[0].content.contains("new"));
        // 最后一条是真实消息（这里是最新提问），保证模型有可执行的当前指令。
        assert_eq!(compacted.last().expect("last").content, "second");
    }

    #[test]
    fn compacted_history_always_keeps_the_last_exchange_verbatim() {
        // 最后一条用户消息很长，远超保留预算：仍必须逐字（可截断）出现在压缩结果里，
        // 且不能只依赖提示词。
        let long = format!("VERBATIM-USER-{}", "y".repeat(200_000));
        let messages = vec![
            ChatMessage::user("old question"),
            ChatMessage::assistant("old answer", Vec::new()),
            ChatMessage::user(long.clone()),
            ChatMessage::assistant("final conclusion", Vec::new()),
        ];
        let compacted = compacted_history(&messages, "summary");
        let kept_user = compacted
            .iter()
            .find(|m| m.role == Role::User && m.content.contains("VERBATIM-USER-"))
            .expect("last user message is retained verbatim");
        assert!(estimate_text_tokens(&kept_user.content) <= COMPACT_LAST_EXCHANGE_MAX_TOKENS);
        let kept_assistant = compacted
            .iter()
            .find(|m| m.content == "final conclusion")
            .expect("last assistant conclusion is retained verbatim");
        assert_eq!(kept_assistant.role, Role::Assistant);
        // 顺序保持原始时间序：user 在前，assistant 结论在后。
        let user_index = compacted
            .iter()
            .position(|m| m.content.contains("VERBATIM-USER-"))
            .expect("user index");
        let assistant_index = compacted
            .iter()
            .position(|m| m.content == "final conclusion")
            .expect("assistant index");
        assert!(user_index < assistant_index);
    }

    #[test]
    fn compaction_keeps_the_current_turn_tool_chain_in_order() {
        // 关键回归：压缩发生在工具轮之间时，当前轮的「提问 → 工具调用 → 结果 →
        // 工具调用 → 结果」必须原样保留，且请求的最后一条仍是本轮最新消息。
        // 旧实现只保留最后一对 user/assistant，整条工具链被吞掉，模型于是
        // 重复执行工具 / 把上一轮的提问当成当前问题来回答。
        let mut call_a = ChatMessage::assistant(
            "",
            vec![ToolCall {
                id: "call-a".into(),
                name: "read_file".into(),
                arguments: json!({"path": "a.txt"}),
            }],
        );
        call_a.id = "a1".into();
        let mut tool_a = ChatMessage::tool("call-a", "content of a.txt");
        tool_a.id = "t1".into();
        let mut call_b = ChatMessage::assistant(
            "",
            vec![ToolCall {
                id: "call-b".into(),
                name: "grep_files".into(),
                arguments: json!({"query": "needle"}),
            }],
        );
        call_b.id = "a2".into();
        let mut tool_b = ChatMessage::tool("call-b", "3 matches found");
        tool_b.id = "t2".into();
        let messages = vec![
            ChatMessage::user("older question"),
            ChatMessage::assistant("older answer", Vec::new()),
            ChatMessage::user("CURRENT QUESTION"),
            call_a,
            tool_a,
            call_b,
            tool_b,
        ];
        let compacted = compacted_history(&messages, "summary");
        assert!(compacted.first().is_some_and(|m| m.compaction_summary));
        // 当前轮完整、按原顺序出现在末尾。
        let tail: Vec<String> = compacted
            .iter()
            .filter(|m| m.role != Role::System)
            .map(|m| m.content.clone())
            .collect();
        let current_from = tail
            .iter()
            .position(|content| content == "CURRENT QUESTION")
            .expect("current user message retained");
        assert_eq!(
            &tail[current_from..],
            [
                "CURRENT QUESTION",
                "",
                "content of a.txt",
                "",
                "3 matches found",
            ]
        );
        // 最后一条是本轮最新工具结果，不是任何旧提问。
        assert_eq!(compacted.last().map(|m| m.content.as_str()), Some("3 matches found"));
        // 配对没有被压缩打断。
        assert_eq!(
            compacted.iter().filter(|m| m.role == Role::Tool).count(),
            2
        );
        assert_eq!(
            compacted
                .iter()
                .flat_map(|m| m.tool_calls.iter().map(|c| c.id.clone()))
                .collect::<Vec<_>>(),
            vec!["call-a".to_owned(), "call-b".to_owned()]
        );
    }

    #[test]
    fn compaction_caps_oversized_current_turn_but_keeps_the_question_head() {
        // 当前轮很长时按预算截断，但必须保留提问开头（否则模型不知道在问什么），
        // 且体积确实降下来。
        let long = format!("CURRENT-QUESTION-{}", "z".repeat(400_000));
        let mut call = ChatMessage::assistant(
            "",
            vec![ToolCall {
                id: "huge-call".into(),
                name: "shell".into(),
                arguments: json!({}),
            }],
        );
        call.id = "huge-assistant".into();
        let mut result = ChatMessage::tool("huge-call", "x".repeat(400_000));
        result.id = "huge-tool".into();
        let messages = vec![
            ChatMessage::user("old"),
            ChatMessage::user(long),
            call,
            result,
        ];
        let compacted = compacted_history(&messages, "summary");
        let question = compacted
            .iter()
            .rev()
            .find(|m| m.role == Role::User)
            .expect("question");
        assert!(question.content.starts_with("CURRENT-QUESTION-"));
        assert!(estimate_text_tokens(&question.content) <= COMPACT_LAST_EXCHANGE_MAX_TOKENS);
        let total: u64 = compacted
            .iter()
            .map(|m| estimate_text_tokens(&m.content))
            .fold(0, u64::saturating_add);
        assert!(total < 100_000, "compacted history must shrink, got {total} tokens");
    }

    #[test]
    fn remote_compaction_cannot_drop_the_current_turn() {
        // 厂商侧压缩返回「摘要 + 旧消息」时，当前轮（提问与工具结果）必须补回来，
        // 否则请求最后一条会变成旧提问，模型就照着旧问题回答。
        let original = vec![
            ChatMessage::user("old question"),
            ChatMessage::assistant("old answer", Vec::new()),
            ChatMessage::user("CURRENT QUESTION"),
            ChatMessage::tool("call-1", "tool result"),
        ];
        let remote = vec![
            ChatMessage::summary("remote summary"),
            original[0].clone(),
            original[1].clone(),
        ];
        let merged = ensure_current_turn_preserved(&original, remote);
        assert!(merged.iter().any(|message| message.content == "CURRENT QUESTION"));
        assert_eq!(merged.last().map(|message| message.content.as_str()), Some("tool result"));
        // 已经完全包含当前轮时不重复追加。
        let full = original.clone();
        let again = ensure_current_turn_preserved(&original, full);
        assert_eq!(again.len(), original.len());
    }

    #[test]
    fn compaction_summary_validation_rejects_empty_and_echoed_templates() {
        // 空摘要：旧实现会把「抬头 + 空」塞进历史，模型只看到交接模板。
        assert!(!compaction_summary_is_usable(""));
        assert!(!compaction_summary_is_usable("   \n\t "));
        // 模型把交接模板原样复述回来：同样不可用。
        assert!(!compaction_summary_is_usable(
            "Another language model started to solve this problem and produced a summary of its thinking process."
        ));
        assert!(!compaction_summary_is_usable(
            "Here is the summary produced by the other language model"
        ));
        // 降级占位文案也不能当摘要用。
        assert!(!compaction_summary_is_usable(
            "[automatic compaction summary unavailable: timeout]"
        ));
        // 模型把新的中文摘要抬头原样复述回来：同样不可用。
        assert!(!compaction_summary_is_usable(SUMMARY_PREFIX));
        assert!(!compaction_summary_is_usable(&format!(
            "{SUMMARY_PREFIX}\n昨天做了什么"
        )));
        // 正常的结构化摘要必须放行。
        assert!(compaction_summary_is_usable(
            "## ① 用户偏好与硬性要求\n- 使用中文\n## ② 已完成事项\n- 读取了下载目录"
        ));
        // 短摘要（测试桩）也不因为长度被误杀。
        assert!(compaction_summary_is_usable("summary"));
    }

    #[test]
    fn compaction_caps_retained_user_history() {
        let messages = vec![ChatMessage::user("x".repeat(100_000))];
        let compacted = compacted_history(&messages, "summary");
        assert_eq!(compacted.len(), 2);
        // [摘要, 最近一轮原文]：摘要永远在最前，正文在后。
        assert!(compacted[0].compaction_summary);
        assert!(!compacted[1].compaction_summary);
        assert!(estimate_text_tokens(&compacted[1].content) <= COMPACT_USER_MESSAGE_MAX_TOKENS);
    }

    #[test]
    fn pinned_messages_survive_compaction_within_their_budget() {
        let messages = vec![
            ChatMessage::user("pinned decision").pin(),
            ChatMessage::assistant("pinned answer", Vec::new()).pin(),
            ChatMessage::assistant("filler", Vec::new()),
            ChatMessage::user("latest"),
        ];
        let compacted = compacted_history(&messages, "summary");
        assert!(compacted.iter().any(|m| m.content == "pinned decision"));
        assert!(compacted.iter().any(|m| m.content == "pinned answer"));
    }

    #[test]
    fn pinned_retention_is_capped_so_it_cannot_grow_without_bound() {
        // 每条 pinned 约 3.7k token，pinned 预算只有 4k：只能保留最新的一条。
        // 用非 base64 字符填充：base64 长串会被 sanitize_long_encoded_data 折叠掉。
        let filler = "—".repeat(5_000);
        let mut messages: Vec<ChatMessage> = (0..5)
            .map(|index| ChatMessage::user(format!("pinned-{index}-{filler}")).pin())
            .collect();
        messages.push(ChatMessage::user("latest question"));
        let retained = retained_user_history(&messages);
        let pinned_kept = retained.iter().filter(|m| m.pinned).count();
        assert_eq!(pinned_kept, 1, "超出 pinned 预算的消息按时间倒序丢弃");
        assert!(retained.iter().any(|m| m.content.starts_with("pinned-4-")));
    }

    #[test]
    fn trim_history_to_fit_prefers_dropping_unpinned_messages() {
        let messages = vec![
            ChatMessage::user("keep me").pin(),
            ChatMessage::user("drop me"),
            ChatMessage::user("latest"),
        ];
        let mut history = messages;
        trim_history_to_fit("system", &mut history, &[], 8);
        assert!(history.iter().any(|m| m.content == "keep me"));
        assert!(!history.iter().any(|m| m.content == "drop me"));
    }

    #[test]
    fn compaction_advances_persistent_window_ids() {
        let mut state = ContextState::default();
        state.reset_after_compaction(
            "system",
            &[],
            &[],
            &ModelCapabilities::default(),
            CompactionRecord::started(false, CompactionReason::Manual, 42, 7),
        );
        assert_eq!(state.compaction_count, 1);
        assert_eq!(state.first_window_id, state.previous_window_id);
        assert_ne!(state.previous_window_id, state.window_id);
        assert_eq!(state.compaction_history.len(), 1);
        let record = &state.compaction_history[0];
        assert_eq!(record.reason, CompactionReason::Manual);
        assert!(!record.automatic);
        assert_eq!(record.before_tokens, 42);
        assert_eq!(record.messages_before, 7);
        assert_eq!(record.messages_after, 0);
        assert_eq!(record.after_tokens, state.estimated_active_tokens);
    }

    #[test]
    fn compaction_history_is_capped_at_the_limit() {
        let mut state = ContextState::default();
        for index in 0..(COMPACTION_HISTORY_LIMIT + 5) {
            state.push_compaction_record(CompactionRecord::started(
                true,
                CompactionReason::Percent,
                index as u64,
                1,
            ));
        }
        assert_eq!(state.compaction_history.len(), COMPACTION_HISTORY_LIMIT);
        // 丢最旧：现存最早的一条是第 5 次。
        assert_eq!(state.compaction_history[0].before_tokens, 5);
    }

    /// 窗口 1_000、比例 85% 的基准能力：关掉保留区与绝对下限，
    /// 先把「窗口比例」「下限」「条数」三条条件分别测清楚。
    fn tiny_capabilities() -> ModelCapabilities {
        ModelCapabilities {
            context_window: 1_000,
            effective_context_window_percent: 100,
            auto_compact_percent: 85,
            auto_compact_floor_tokens: 0,
            auto_compact_retain_tokens: 0,
            ..ModelCapabilities::default()
        }
    }

    #[test]
    fn should_compact_reports_each_trigger_reason() {
        let capabilities = tiny_capabilities();
        // 条数条件：用量超过窗口 50%（>500）但还没到 85% 阈值，只有条数能触发。
        let mut state = ContextState::default();
        state.estimated_active_tokens = 600;
        assert_eq!(state.should_compact(&capabilities, 11, 10), Some(CompactionReason::Messages));
        assert_eq!(state.should_compact(&capabilities, 9, 10), None);
        assert_eq!(state.should_compact(&capabilities, 9, 0), None);
        // 用量没到窗口 50% 时，条数再多也不压（避免「几十条短消息就压缩」）。
        state.estimated_active_tokens = 400;
        assert_eq!(state.should_compact(&capabilities, 9_999, 10), None);
        // 窗口比例条件优先于条数条件。
        state.estimated_active_tokens = 900;
        assert_eq!(state.should_compact(&capabilities, 99, 10), Some(CompactionReason::Percent));
        // 保留区：阈值被「有效窗口 − 保留区」（700）压低。
        let retained = ModelCapabilities {
            auto_compact_retain_tokens: 300,
            ..capabilities.clone()
        };
        let mut state = ContextState::default();
        state.estimated_active_tokens = 699;
        assert_eq!(state.should_compact(&retained, 0, 0), None);
        state.estimated_active_tokens = 700;
        assert_eq!(state.should_compact(&retained, 0, 0), Some(CompactionReason::Percent));
        // 绝对下限高于窗口阈值：用量先到下限才压，原因是 floor。
        let floored = ModelCapabilities {
            auto_compact_floor_tokens: 900,
            ..capabilities.clone()
        };
        let mut state = ContextState::default();
        state.estimated_active_tokens = 850;
        assert_eq!(state.should_compact(&floored, 0, 0), None);
        state.estimated_active_tokens = 900;
        assert_eq!(state.should_compact(&floored, 0, 0), Some(CompactionReason::Floor));
        // 窗口整体超限：不再受下限约束。
        let mut body_after_prefix = capabilities.clone();
        body_after_prefix.auto_compact_scope = AutoCompactScope::BodyAfterPrefix;
        let prefix_state = ContextState {
            estimated_active_tokens: 1_200,
            prefill_input_tokens: Some(1_000),
            ..ContextState::default()
        };
        assert_eq!(
            prefix_state.should_compact(&body_after_prefix, 0, 0),
            Some(CompactionReason::Percent)
        );
        // 指纹变化。
        let mut state = ContextState::default();
        state.comp_hash = Some("old".into());
        let changed = ModelCapabilities {
            comp_hash: Some("new".into()),
            ..capabilities.clone()
        };
        assert_eq!(state.should_compact(&changed, 0, 0), Some(CompactionReason::Cache));
        assert_eq!(state.should_compact(&capabilities, 0, 0), None);
    }

    /// 验收口径：256k 窗口 + 默认配置（85% / 下限 10 万 / 保留区 3.2 万）下，
    /// 4 万 token 的会话不自动压缩，超过阈值（约 21.1 万）才压一次。
    #[test]
    fn default_thresholds_skip_small_sessions() {
        let capabilities = ModelCapabilities {
            context_window: 256_000,
            ..ModelCapabilities::default()
        };
        // min(256_000 × 85% = 217_600, 有效窗口 243_200 − 保留区 32_000 = 211_200)
        // = 211_200；下限 10 万低于它，不构成更高门槛。
        assert_eq!(capabilities.auto_compact_percent_limit(), 217_600);
        assert_eq!(capabilities.auto_compact_retain_limit(), 211_200);
        assert_eq!(capabilities.auto_compact_window_limit(), 211_200);
        assert_eq!(capabilities.auto_compact_trigger_limit(), 211_200);

        let mut state = ContextState::default();
        state.estimated_active_tokens = 41_090;
        assert_eq!(state.should_compact(&capabilities, 200, 200), None);
        // 4 万 token 即使消息条数早就超过阈值也不压（用量未过窗口 50%）。
        assert_eq!(state.should_compact(&capabilities, 5_000, 200), None);

        // 过窗口 50% 但未到阈值：条数条件生效（messages）。
        state.estimated_active_tokens = 130_000;
        assert_eq!(state.should_compact(&capabilities, 200, 200), Some(CompactionReason::Messages));
        assert_eq!(state.should_compact(&capabilities, 199, 200), None);

        // 超过阈值：percent。
        state.estimated_active_tokens = 220_000;
        assert_eq!(state.should_compact(&capabilities, 3, 200), Some(CompactionReason::Percent));
    }

    /// GET /api/sessions/{id}/context 直接序列化 ContextStatus：
    /// 窗口来源（probe / config / default）与「到多少才压」都要能被前端读到。
    #[test]
    fn context_status_reports_window_source() {
        let capabilities = ModelCapabilities {
            context_window: 256_000,
            context_window_source: ContextWindowSource::Probe,
            ..ModelCapabilities::default()
        };
        let status = ContextState::default().status(&capabilities);
        assert_eq!(status.context_window_source, ContextWindowSource::Probe);
        assert_eq!(status.auto_compact_token_limit, 211_200);
        let value = serde_json::to_value(&status).expect("status json");
        assert_eq!(value["context_window_source"], "probe");

        let unconfigured = ModelCapabilities::default();
        assert_eq!(
            unconfigured.context_window_source,
            ContextWindowSource::Default
        );
        assert_eq!(
            serde_json::to_value(ContextState::default().status(&unconfigured)).expect("json")
                ["context_window_source"],
            "default"
        );
    }

    /// 小窗口 + 默认下限：下限高于窗口阈值时，用量先到下限才压（reason = floor）。
    #[test]
    fn absolute_floor_becomes_the_binding_threshold() {
        let capabilities = ModelCapabilities {
            context_window: 128_000,
            ..ModelCapabilities::default()
        };
        // min(108_800, 121_600 − 32_000 = 89_600) = 89_600 < 下限 100_000。
        assert_eq!(capabilities.auto_compact_window_limit(), 89_600);
        assert_eq!(capabilities.auto_compact_trigger_limit(), 100_000);
        let mut state = ContextState::default();
        state.estimated_active_tokens = 89_600;
        assert_eq!(state.should_compact(&capabilities, 0, 0), None);
        state.estimated_active_tokens = 100_000;
        assert_eq!(state.should_compact(&capabilities, 0, 0), Some(CompactionReason::Floor));
    }
}
