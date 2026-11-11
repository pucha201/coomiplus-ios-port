// 见 iroh_tunnel.rs：有 feature 时转发到真实现，无 feature 时使用本地 stub。
#[cfg(feature = "iroh-tunnel")]
#[path = "iroh_tunnel_impl.rs"]
mod enabled;
#[cfg(feature = "iroh-tunnel")]
pub(crate) use enabled::*;

#[cfg(not(feature = "iroh-tunnel"))]
mod disabled {

    // iroh tunnel disabled at compile time (`--no-default-features`).
    //
    // iSH / 受限环境下不构建 ring 与 TLS 栈：这三个入口保留签名，行为退化为
    // 「隧道不可用」，局域网直连与中转链路不受影响。
    use anyhow::Result;
    use serde_json::Value;
    use std::sync::Arc;
    use crate::web::AppState;

    /// 编译期关闭时的占位类型（原类型持有 iroh Endpoint）。
    pub(crate) struct IrohNode;

    impl IrohNode {
        /// 编译期关闭时没有 endpoint：返回 null，前端据此隐藏 iroh 入口。
        pub fn local_endpoint_json(&self) -> Value {
            Value::Null
        }
    }

    /// 编译期关闭：没有活跃 endpoint。
    pub(crate) fn local_endpoint_json() -> Value {
        Value::Null
    }

    pub(crate) async fn ensure_started(_state: AppState) -> Result<Arc<IrohNode>> {
        anyhow::bail!("iroh tunnel is disabled at compile time (build without --no-default-features to enable)")
    }

    pub(crate) async fn iroh_info(
        axum::extract::State(_state): axum::extract::State<AppState>,
    ) -> axum::Json<Value> {
        axum::Json(serde_json::json!({
            "enabled": false,
            "reason": "compiled without the iroh-tunnel feature",
        }))
    }

    pub(crate) async fn iroh_connect(
        axum::extract::State(_state): axum::extract::State<AppState>,
        axum::Json(_body): axum::Json<Value>,
    ) -> Result<axum::Json<Value>, crate::web::ApiError> {
        Err(crate::web::ApiError::bad_request(
            "iroh tunnel is disabled at compile time",
        ))
    }
}

#[cfg(not(feature = "iroh-tunnel"))]
pub(crate) use disabled::*;
