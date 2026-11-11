//! 厂商账户余额：能读到就显示，读不到就**整块不显示**。
//!
//! 三条硬规则（与前端「不拿假数据充数」的口径一致）：
//! 1. 没有公开余额接口的厂商（OpenAI / Anthropic / Gemini / 智谱 / MiniMax …）
//!    根本不发请求，直接 `supported: false`；
//! 2. 401/403/404、返回 HTML（one-api 系网关把未匹配路由回落到首页）、
//!    或 JSON 里没有已知金额字段，一律算「不支持」，不显示 0；
//! 3. 密钥只留在引擎里：请求由 Rust 发起，手机/桌面只拿结果。
//!
//! 读取结果缓存 60 秒，避免每次打开用量面板都打一次上游。

use anyhow::Context;
use anyhow::Result;
use serde_json::Value;
use serde_json::json;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

use coomi_services::ProviderSettings;

const BALANCE_TIMEOUT: Duration = Duration::from_secs(6);
const CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Adapter {
    DeepSeek,
    Moonshot,
    SiliconFlow,
    OpenRouter,
    /// one-api / new-api 这类网关：`/dashboard/billing/*`。
    Gateway,
    /// 自定义渠道：按 DeepSeek 兼容的 `/user/balance` 再探一次。
    Probe,
    None,
}

/// 按 base_url 的域名识别厂商。自定义域名不瞎猜，交给 Probe 只试标准路径。
fn adapter_for(base_url: &str) -> Adapter {
    let lower = base_url.to_ascii_lowercase();
    if lower.contains("deepseek") {
        return Adapter::DeepSeek;
    }
    if lower.contains("moonshot") || lower.contains("kimi") {
        return Adapter::Moonshot;
    }
    if lower.contains("siliconflow") {
        return Adapter::SiliconFlow;
    }
    if lower.contains("openrouter") {
        return Adapter::OpenRouter;
    }
    // 官方域名明确没有公开余额接口：不发请求，避免拿 404 当「余额 0」。
    if lower.contains("openai.com")
        || lower.contains("anthropic.com")
        || lower.contains("generativelanguage.googleapis.com")
        || lower.contains("bigmodel.cn")
        || lower.contains("minimax")
        || lower.contains("opencode.ai")
    {
        return Adapter::None;
    }
    if lower.is_empty() {
        return Adapter::None;
    }
    // 常见网关自带 billing 路由；先按网关探，失败再按 DeepSeek 兼容探。
    Adapter::Gateway
}

fn unsupported(reason: &str) -> Value {
    json!({ "supported": false, "reason": reason })
}

fn ok(currency: &str, total: Value, granted: Option<Value>, topped_up: Option<Value>, source: &str) -> Value {
    json!({
        "supported": true,
        "currency": currency,
        "total": total,
        "granted": granted,
        "toppedUp": topped_up,
        "source": source,
        "checkedAt": now_ms(),
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(BALANCE_TIMEOUT)
        .build()
        .context("构建余额查询客户端失败")
}

/// 上游返回 HTML（网关把 404 回落成首页）时不要把整页当 JSON 解析。
async fn get_json(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
) -> Result<Option<Value>> {
    let response = client
        .get(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .send()
        .await
        .context("请求上游失败")?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let text = response.text().await.context("读取上游响应失败")?;
    let trimmed = text.trim_start();
    if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
        return Ok(None);
    }
    Ok(serde_json::from_str::<Value>(&text).ok())
}

fn join_base(base: &str, path: &str) -> String {
    let root = base.trim().trim_end_matches('/');
    format!("{root}{path}")
}

/// 金额统一成字符串（保留上游给的小数位，避免 f64 把 0.37 变成 0.37000000001）。
fn money(value: &Value) -> Option<Value> {
    match value {
        Value::String(_) => Some(value.clone()),
        Value::Number(number) => Some(Value::String(number.to_string())),
        _ => None,
    }
}

pub async fn provider_balance(provider: &ProviderSettings, provider_id: &str) -> Value {
    let key = provider.api_key.trim();
    if key.is_empty() {
        return unsupported("provider has no api key");
    }
    let base = if provider.base_url.trim().is_empty() {
        String::new()
    } else {
        provider.base_url.trim().to_owned()
    };
    if base.is_empty() {
        return unsupported("provider has no base url");
    }
    if let Some(hit) = cached(provider_id) {
        return hit;
    }

    let client = match client() {
        Ok(client) => client,
        Err(_) => return unsupported("http client unavailable"),
    };

    let report = match adapter_for(&base) {
        Adapter::DeepSeek => query_deepseek(&client, &base, key).await,
        Adapter::Moonshot => query_moonshot(&client, &base, key).await,
        Adapter::SiliconFlow => query_siliconflow(&client, &base, key).await,
        Adapter::OpenRouter => query_openrouter(&client, &base, key).await,
        Adapter::Gateway => match query_gateway(&client, &base, key).await {
            Some(report) => Some(report),
            None => query_deepseek(&client, &base, key).await,
        },
        Adapter::Probe => query_deepseek(&client, &base, key).await,
        Adapter::None => None,
    };

    let value = report.unwrap_or_else(|| unsupported("upstream does not expose a balance endpoint"));
    remember(provider_id, &value);
    value
}

async fn query_deepseek(client: &reqwest::Client, base: &str, key: &str) -> Option<Value> {
    let body = get_json(client, &join_base(base, "/user/balance"), key).await.ok()??;
    let info = body.get("balance_infos")?.as_array()?.first()?.clone();
    let total = money(info.get("total_balance")?)?;
    let currency = info
        .get("currency")
        .and_then(Value::as_str)
        .unwrap_or("CNY");
    Some(ok(
        currency,
        total,
        info.get("granted_balance").and_then(money),
        info.get("topped_up_balance").and_then(money),
        "deepseek",
    ))
}

async fn query_moonshot(client: &reqwest::Client, base: &str, key: &str) -> Option<Value> {
    let body = get_json(client, &join_base(base, "/v1/users/me/balance"), key)
        .await
        .ok()??;
    let data = body.get("data")?;
    let total = money(data.get("available_balance")?)?;
    // api.moonshot.cn 是人民币，api.moonshot.ai 是美元。
    let currency = if base.to_ascii_lowercase().contains(".ai") { "USD" } else { "CNY" };
    Some(ok(
        currency,
        total,
        data.get("voucher_balance").and_then(money),
        data.get("cash_balance").and_then(money),
        "moonshot",
    ))
}

async fn query_siliconflow(client: &reqwest::Client, base: &str, key: &str) -> Option<Value> {
    let body = get_json(client, &join_base(base, "/v1/user/info"), key).await.ok()??;
    let data = body.get("data").unwrap_or(&body);
    let total = data
        .get("totalBalance")
        .and_then(money)
        .or_else(|| data.get("balance").and_then(money))?;
    Some(ok(
        "CNY",
        total,
        None,
        data.get("chargeBalance").and_then(money),
        "siliconflow",
    ))
}

async fn query_openrouter(client: &reqwest::Client, base: &str, key: &str) -> Option<Value> {
    // /api/v1/key 给出的是「这把 key 还剩多少」；没有 limit 时退回账户 credits。
    if let Ok(Some(body)) = get_json(client, &join_base(base, "/api/v1/key"), key).await
        && let Some(remaining) = body.get("data").and_then(|data| data.get("limit_remaining")).and_then(money)
    {
        return Some(ok("USD", remaining, None, None, "openrouter-key"));
    }
    let body = get_json(client, &join_base(base, "/api/v1/credits"), key).await.ok()??;
    let data = body.get("data")?;
    let total = data.get("total_credits")?.as_f64()?;
    let used = data.get("total_usage").and_then(Value::as_f64).unwrap_or(0.0);
    let remaining = (total - used).max(0.0);
    Some(ok(
        "USD",
        Value::String(format!("{remaining:.2}")),
        None,
        None,
        "openrouter-credits",
    ))
}

/// one-api / new-api：订阅额度 − 已用（usage 单位是美分）。
async fn query_gateway(client: &reqwest::Client, base: &str, key: &str) -> Option<Value> {
    let subscription = get_json(client, &join_base(base, "/dashboard/billing/subscription"), key)
        .await
        .ok()??;
    let limit = subscription
        .get("hard_limit_usd")
        .and_then(Value::as_f64)
        .or_else(|| subscription.get("soft_limit_usd").and_then(Value::as_f64))?;
    let usage = get_json(client, &join_base(base, "/dashboard/billing/usage"), key)
        .await
        .ok()
        .flatten()
        .and_then(|body| body.get("total_usage").and_then(Value::as_f64))
        .unwrap_or(0.0);
    let remaining = (limit - usage / 100.0).max(0.0);
    Some(ok(
        "USD",
        Value::String(format!("{remaining:.2}")),
        None,
        None,
        "gateway-billing",
    ))
}

/* ── 60 秒缓存 ───────────────────────────────────────────────────────── */

static CACHE: OnceLock<Mutex<std::collections::HashMap<String, (Instant, Value)>>> = OnceLock::new();

fn cached(provider_id: &str) -> Option<Value> {
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let guard = cache.lock().ok()?;
    let (at, value) = guard.get(provider_id)?;
    (at.elapsed() < CACHE_TTL).then(|| value.clone())
}

fn remember(provider_id: &str, value: &Value) {
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    if let Ok(mut guard) = cache.lock() {
        guard.insert(provider_id.to_owned(), (Instant::now(), value.clone()));
    }
}

/// `refresh=1` 时清掉这条缓存（面板上的手动刷新）。
pub fn invalidate(provider_id: &str) {
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    if let Ok(mut guard) = cache.lock() {
        guard.remove(provider_id);
    }
}
