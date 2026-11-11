//! 插件市场 v2 辅助：多源合并、官方 MCP Registry 适配、本地回滚备份、中文展示元数据。

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const KIND_COOMI: &str = "coomi";
pub const KIND_MCP_REGISTRY: &str = "mcp-registry";

/// 一个可选下载源。`kind` 决定拉取后如何解析：
/// `coomi` = Coomi registry.json；`mcp-registry` = 官方 MCP Registry /v0/servers。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistrySource {
    pub id: String,
    pub name: String,
    pub url: String,
    pub kind: String,
    pub builtin: bool,
}

impl RegistrySource {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "url": self.url,
            "kind": self.kind,
            "builtin": self.builtin,
        })
    }
}

/// 内置源预设：Coomi 官方（含两个镜像）+ 官方 MCP Registry。
/// 官方 MCP Registry 有 2 万+ 条目，按 `search` 查询；其余为完整 registry.json。
pub fn preset_sources() -> Vec<RegistrySource> {
    vec![
        RegistrySource {
            id: "official".into(),
            name: "Coomi 官方源".into(),
            url: "https://raw.githubusercontent.com/TensorHub-ORG/coomi-registry/main/registry.json".into(),
            kind: KIND_COOMI.into(),
            builtin: true,
        },
        RegistrySource {
            id: "official-cdn".into(),
            name: "Coomi 官方 · jsDelivr".into(),
            url: "https://cdn.jsdelivr.net/gh/TensorHub-ORG/coomi-registry@main/registry.json".into(),
            kind: KIND_COOMI.into(),
            builtin: true,
        },
        RegistrySource {
            id: "mirror-gh-proxy".into(),
            name: "Coomi 官方 · gh-proxy".into(),
            url: "https://gh-proxy.com/https://raw.githubusercontent.com/TensorHub-ORG/coomi-registry/main/registry.json".into(),
            kind: KIND_COOMI.into(),
            builtin: true,
        },
        RegistrySource {
            id: "mcp-official".into(),
            name: "官方 MCP Registry".into(),
            url: "https://registry.modelcontextprotocol.io/v0/servers".into(),
            kind: KIND_MCP_REGISTRY.into(),
            builtin: true,
        },
    ]
}

/// 按 URL 猜源类型：官方 MCP Registry 走专用适配器，其余按 Coomi registry.json 处理。
pub fn detect_kind(url: &str) -> &'static str {
    if url.contains("registry.modelcontextprotocol.io")
        || url.contains("/v0/servers")
        || url.contains("/v0.1/servers")
    {
        KIND_MCP_REGISTRY
    } else {
        KIND_COOMI
    }
}

fn sanitize_source_id(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_owned();
    if trimmed.is_empty() {
        "custom".into()
    } else {
        trimmed
    }
}

fn custom_sources_path(home: &Path) -> PathBuf {
    home.join("config").join("registry_sources.json")
}

/// 用户自定义源（持久化在 config/registry_sources.json）。
pub fn custom_sources(home: &Path) -> Vec<RegistrySource> {
    let Ok(bytes) = fs::read(custom_sources_path(home)) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    value
        .get("sources")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let url = item.get("url").and_then(Value::as_str)?.trim();
                    if url.is_empty() {
                        return None;
                    }
                    let id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .map(sanitize_source_id)
                        .filter(|id| !id.is_empty())
                        .unwrap_or_else(|| sanitize_source_id(url));
                    Some(RegistrySource {
                        id,
                        name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|name| !name.is_empty())
                            .unwrap_or(url)
                            .to_owned(),
                        url: url.to_owned(),
                        kind: item
                            .get("kind")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|kind| *kind == KIND_COOMI || *kind == KIND_MCP_REGISTRY)
                            .map(str::to_owned)
                            .unwrap_or_else(|| detect_kind(url).to_owned()),
                        builtin: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn save_custom_sources(home: &Path, sources: &[RegistrySource]) -> Result<(), String> {
    let path = custom_sources_path(home);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    }
    let payload = json!({
        "sources": sources
            .iter()
            .map(|source| json!({
                "id": source.id,
                "name": source.name,
                "url": source.url,
                "kind": source.kind,
            }))
            .collect::<Vec<_>>(),
    });
    let tmp = path.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(&payload).map_err(|error| format!("序列化源失败：{error}"))?,
    )
    .map_err(|error| format!("写入源配置失败：{error}"))?;
    fs::rename(&tmp, &path).map_err(|error| format!("替换源配置失败：{error}"))?;
    Ok(())
}

/// 全部可用源：内置预设 + 用户自定义（同 id 时自定义覆盖内置之外的同名 id 会被拒绝）。
pub fn all_sources(home: &Path) -> Vec<RegistrySource> {
    let mut sources = preset_sources();
    for custom in custom_sources(home) {
        if !sources.iter().any(|source| source.id == custom.id) {
            sources.push(custom);
        }
    }
    sources
}

/// 按 id 解析源（内置或自定义）。
pub fn resolve_source(home: &Path, id: &str) -> Option<RegistrySource> {
    all_sources(home)
        .into_iter()
        .find(|source| source.id == id)
}

/// 新增 / 更新自定义源。返回最终条目。
pub fn add_custom_source(
    home: &Path,
    name: &str,
    url: &str,
    kind: &str,
) -> Result<RegistrySource, String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("源地址必须是 http(s) URL".into());
    }
    let name = name.trim();
    if name.is_empty() {
        return Err("请填写源名称".into());
    }
    let kind = if kind == KIND_COOMI || kind == KIND_MCP_REGISTRY {
        kind.to_owned()
    } else {
        detect_kind(url).to_owned()
    };
    let base_id = sanitize_source_id(name);
    let mut sources = custom_sources(home);
    // 与内置 id 冲突时加后缀，避免覆盖用户无法删除的预设。
    let preset_ids: HashSet<String> = preset_sources().into_iter().map(|source| source.id).collect();
    let mut id = base_id.clone();
    let mut suffix = 2;
    while preset_ids.contains(&id)
        || sources
            .iter()
            .any(|source| source.id == id && source.url != url)
    {
        id = format!("{base_id}-{suffix}");
        suffix += 1;
    }
    let source = RegistrySource {
        id: id.clone(),
        name: name.to_owned(),
        url: url.to_owned(),
        kind,
        builtin: false,
    };
    if let Some(existing) = sources.iter_mut().find(|entry| entry.url == url) {
        *existing = source.clone();
    } else {
        sources.push(source.clone());
    }
    save_custom_sources(home, &sources)?;
    Ok(source)
}

/// 删除自定义源；内置源不可删除（返回 Ok(false)）。
pub fn remove_custom_source(home: &Path, id: &str) -> Result<bool, String> {
    let mut sources = custom_sources(home);
    let before = sources.len();
    sources.retain(|source| source.id != id);
    if sources.len() == before {
        return Ok(false);
    }
    save_custom_sources(home, &sources)?;
    Ok(true)
}

/// 额外注册表源：环境变量 COOMI_EXTRA_REGISTRIES 用逗号分隔 URL。
pub fn extra_registry_urls() -> Vec<String> {
    std::env::var("COOMI_EXTRA_REGISTRIES")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn registry_slug(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_owned();
    if trimmed.is_empty() {
        "mcp-server".into()
    } else {
        trimmed
    }
}

fn string_value(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// 把一个官方 MCP Registry server 描述转成 Coomi 市场条目。
/// 远程（remotes）优先——手机/桌面都不需要再装 Node/Python；否则取 npm/pypi 包。
fn adapt_mcp_server(server: &Value, source_id: &str) -> Option<Value> {
    let full_name = string_value(server, "name")?;
    let id = registry_slug(&full_name);
    let name = string_value(server, "title").unwrap_or_else(|| full_name.clone());
    let description = string_value(server, "description").unwrap_or_default();
    let version = string_value(server, "version").unwrap_or_default();
    let repository = server
        .get("repository")
        .and_then(|repository| repository.get("url"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let publisher = full_name
        .split('/')
        .next()
        .unwrap_or(&full_name)
        .to_owned();

    let transport: String;
    let mut url = String::new();
    let mut command = String::new();
    let mut args: Vec<String> = Vec::new();
    let mut env = serde_json::Map::new();
    let mut required_parameters: Vec<Value> = Vec::new();

    if let Some(remote) = server
        .get("remotes")
        .and_then(Value::as_array)
        .and_then(|remotes| remotes.first())
    {
        let remote_url = string_value(remote, "url")?;
        let remote_type = string_value(remote, "type").unwrap_or_default();
        transport = if remote_type.eq_ignore_ascii_case("sse") {
            "sse".into()
        } else {
            "http".into()
        };
        url = remote_url;
    } else {
        let packages = server.get("packages").and_then(Value::as_array)?;
        let package = packages
            .iter()
            .find(|package| {
                string_value(package, "registryType")
                    .is_some_and(|kind| kind.eq_ignore_ascii_case("npm"))
            })
            .or_else(|| {
                packages.iter().find(|package| {
                    string_value(package, "registryType")
                        .is_some_and(|kind| kind.eq_ignore_ascii_case("pypi"))
                })
            })?;
        let registry_type = string_value(package, "registryType")?;
        let identifier = string_value(package, "identifier")?;
        let is_npm = registry_type.eq_ignore_ascii_case("npm");
        command = if is_npm { "npx".into() } else { "uvx".into() };
        if is_npm {
            args.push("-y".into());
        }
        args.push(identifier.clone());
        if let Some(runtime_arguments) = package.get("runtimeArguments").and_then(Value::as_array) {
            for argument in runtime_arguments {
                if let Some(value) = argument.get("value").and_then(Value::as_str) {
                    if is_npm && (value == "-y" || value == "--yes") && args.first().is_some_and(|first| first == "-y") {
                        continue;
                    }
                    args.insert(args.len().saturating_sub(1), value.to_owned());
                }
            }
        }
        if let Some(package_arguments) = package.get("packageArguments").and_then(Value::as_array) {
            for argument in package_arguments {
                if let Some(value) = argument.get("value").and_then(Value::as_str) {
                    args.push(value.to_owned());
                }
            }
        }
        if let Some(variables) = package.get("environmentVariables").and_then(Value::as_array) {
            for variable in variables {
                let Some(key) = string_value(variable, "name") else {
                    continue;
                };
                let is_required = variable
                    .get("isRequired")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let default = variable
                    .get("default")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if is_required {
                    env.insert(key.clone(), json!(format!("{{{{{key}}}}}")));
                    let label = string_value(variable, "description")
                        .unwrap_or_else(|| key.clone());
                    required_parameters.push(json!({
                        "key": key,
                        "label": label,
                        "secret": variable.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
                    }));
                } else if !default.is_empty() {
                    env.insert(key, json!(default));
                }
            }
        }
        transport = "stdio".into();
    }

    let requires = if command.is_empty() {
        Vec::new()
    } else {
        vec![command.clone()]
    };
    let mut entry = json!({
        "id": id,
        "name": name,
        "description": description,
        "transport": transport,
        "command": command,
        "args": args,
        "env": env,
        "required_parameters": required_parameters,
        "requires": requires,
        "available": true,
        "repository": repository,
        "version": version,
        "publisher": publisher,
        "registry_name": full_name,
        "source": source_id,
    });
    if !url.is_empty() {
        entry["url"] = json!(url);
    }
    Some(entry)
}

/// 官方 MCP Registry 响应 → Coomi 市场结构。
pub fn adapt_mcp_registry(payload: &Value, source_id: &str) -> Value {
    let mut mcps = Vec::new();
    let mut seen = HashSet::new();
    if let Some(list) = payload.get("servers").and_then(Value::as_array) {
        for wrapper in list {
            let Some(server) = wrapper.get("server") else {
                continue;
            };
            let Some(entry) = adapt_mcp_server(server, source_id) else {
                continue;
            };
            let id = entry
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if !seen.insert(id) {
                continue;
            }
            mcps.push(entry);
        }
    }
    json!({
        "skills": [],
        "mcps": mcps,
        "updated_at": Value::Null,
        "source_kind": KIND_MCP_REGISTRY,
        "source": source_id,
    })
}

/// 对 Coomi registry.json 做本地搜索（市场源本身不大，前端也做一次过滤）。
pub fn filter_registry(registry: &mut Value, query: &str) {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return;
    }
    for key in ["skills", "mcps"] {
        let Some(list) = registry.get_mut(key).and_then(Value::as_array_mut) else {
            continue;
        };
        list.retain(|item| {
            [
                item.get("id").and_then(Value::as_str),
                item.get("name").and_then(Value::as_str),
                item.get("description").and_then(Value::as_str),
                item.get("author").and_then(Value::as_str),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.to_lowercase().contains(&needle))
                || item
                    .get("tags")
                    .and_then(Value::as_array)
                    .is_some_and(|tags| {
                        tags.iter()
                            .filter_map(Value::as_str)
                            .any(|tag| tag.to_lowercase().contains(&needle))
                    })
        });
    }
}

/// 合并多个 registry.json：按 id 去重，后源覆盖同 id，保留来源标签。
pub fn merge_registries(sources: &[(String, Value)]) -> Value {
    let mut skills: HashMap<String, Value> = HashMap::new();
    let mut mcps: HashMap<String, Value> = HashMap::new();
    let mut updated_at = String::new();
    for (source, registry) in sources {
        if let Some(list) = registry.get("skills").and_then(Value::as_array) {
            for item in list {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    let mut owned = item.clone();
                    owned["source"] = json!(source);
                    skills.insert(id.to_owned(), owned);
                }
            }
        }
        if let Some(list) = registry.get("mcps").or_else(|| registry.get("mcp")).and_then(Value::as_array)
        {
            for item in list {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    let mut owned = item.clone();
                    owned["source"] = json!(source);
                    mcps.insert(id.to_owned(), owned);
                }
            }
        }
        if let Some(ts) = registry.get("updated_at").and_then(Value::as_str) {
            if ts > updated_at.as_str() {
                updated_at = ts.to_owned();
            }
        }
    }
    let mut skill_list: Vec<Value> = skills.into_values().collect();
    skill_list.sort_by_key(|v| {
        v.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    });
    let mut mcp_list: Vec<Value> = mcps.into_values().collect();
    mcp_list.sort_by_key(|v| {
        v.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    });
    json!({
        "skills": skill_list,
        "mcps": mcp_list,
        "updated_at": updated_at,
        "sources": sources.iter().map(|(s, _)| s.clone()).collect::<Vec<_>>(),
    })
}

/// Skill 安装前备份目录，便于回滚。
pub fn backup_skill(home: &Path, skill_id: &str) -> Option<PathBuf> {
    let src = home.join("skills").join(skill_id);
    if !src.is_dir() {
        return None;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let dest = home
        .join("cache")
        .join("skill-backups")
        .join(format!("{skill_id}-{stamp}"));
    if fs::create_dir_all(&dest).is_err() {
        return None;
    }
    copy_dir(&src, &dest).ok()?;
    // 写索引
    let index_path = home.join("cache").join("skill-backups").join("index.json");
    let mut index: Value = fs::read_to_string(&index_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({ "entries": [] }));
    if let Some(arr) = index.get_mut("entries").and_then(Value::as_array_mut) {
        arr.push(json!({
            "skillId": skill_id,
            "backup": dest.display().to_string(),
            "at": stamp,
        }));
        while arr.len() > 20 {
            arr.remove(0);
        }
    }
    let _ = fs::write(&index_path, serde_json::to_vec_pretty(&index).unwrap_or_default());
    Some(dest)
}

/// 回滚到最近一次备份。
pub fn rollback_skill(home: &Path, skill_id: &str) -> Result<PathBuf, String> {
    let index_path = home.join("cache").join("skill-backups").join("index.json");
    let index: Value = fs::read_to_string(&index_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({ "entries": [] }));
    let backup = index
        .get("entries")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .filter(|e| e.get("skillId").and_then(Value::as_str) == Some(skill_id))
                .max_by_key(|e| e.get("at").and_then(Value::as_u64).unwrap_or(0))
                .and_then(|e| e.get("backup").and_then(Value::as_str).map(str::to_owned))
        })
        .ok_or_else(|| format!("没有找到 `{skill_id}` 的备份"))?;
    let src = PathBuf::from(&backup);
    if !src.is_dir() {
        return Err("备份目录已不存在".into());
    }
    let dest = home.join("skills").join(skill_id);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| format!("清理当前目录失败: {e}"))?;
    }
    copy_dir(&src, &dest).map_err(|e| format!("恢复失败: {e}"))?;
    Ok(dest)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let target = to.join(&name);
        if path.is_dir() {
            copy_dir(&path, &target)?;
        } else {
            fs::copy(&path, &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapts_remote_and_package_entries() {
        let payload = json!({
            "servers": [
                { "server": {
                    "name": "ac.demo/remote",
                    "title": "Demo Remote",
                    "description": "remote server",
                    "version": "1.2.3",
                    "remotes": [{ "type": "streamable-http", "url": "https://demo.example/mcp" }]
                }},
                { "server": {
                    "name": "io.demo/files",
                    "description": "files package",
                    "version": "0.3.0",
                    "packages": [{
                        "registryType": "npm",
                        "identifier": "@demo/files",
                        "runtimeArguments": [{ "value": "-y" }],
                        "environmentVariables": [
                            { "name": "API_KEY", "description": "API 密钥", "isRequired": true, "isSecret": true },
                            { "name": "MODE", "description": "mode", "default": "safe" }
                        ]
                    }],
                    "repository": { "url": "https://github.com/demo/files" }
                }}
            ]
        });
        let adapted = adapt_mcp_registry(&payload, "mcp-official");
        let mcps = adapted["mcps"].as_array().expect("mcps");
        assert_eq!(mcps.len(), 2);
        assert_eq!(mcps[0]["transport"], "http");
        assert_eq!(mcps[0]["url"], "https://demo.example/mcp");
        assert_eq!(mcps[1]["transport"], "stdio");
        assert_eq!(mcps[1]["command"], "npx");
        assert_eq!(mcps[1]["args"][0], "-y");
        assert_eq!(mcps[1]["args"][1], "@demo/files");
        assert_eq!(mcps[1]["env"]["MODE"], "safe");
        assert_eq!(mcps[1]["env"]["API_KEY"], "{{API_KEY}}");
        assert_eq!(mcps[1]["required_parameters"][0]["key"], "API_KEY");
        assert_eq!(mcps[1]["required_parameters"][0]["secret"], true);
        assert_eq!(mcps[1]["source"], "mcp-official");
    }

    #[test]
    fn custom_sources_are_persisted_and_protected() {
        let home = tempfile::tempdir().expect("home");
        let source = add_custom_source(
            home.path(),
            "My Registry",
            "https://example.com/registry.json",
            "",
        )
        .expect("add source");
        assert_eq!(source.kind, KIND_COOMI);
        assert_eq!(source.id, "my-registry");
        assert!(all_sources(home.path()).iter().any(|entry| entry.id == "my-registry"));
        assert!(remove_custom_source(home.path(), &source.id).expect("remove"));
        assert!(!all_sources(home.path()).iter().any(|entry| entry.id == "my-registry"));
        // 内置源 id 不能被自定义源覆盖。
        let colliding = add_custom_source(
            home.path(),
            "official",
            "https://example.com/x.json",
            "",
        )
        .expect("collision source");
        assert_ne!(colliding.id, "official");
        assert!(!remove_custom_source(home.path(), "official").expect("no builtin"));
    }

    #[test]
    fn detects_mcp_registry_sources() {
        assert_eq!(
            detect_kind("https://registry.modelcontextprotocol.io/v0/servers"),
            KIND_MCP_REGISTRY
        );
        assert_eq!(
            detect_kind("https://example.com/registry.json"),
            KIND_COOMI
        );
    }
}
