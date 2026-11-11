//! Host-side chunked uploads into a fixed incoming directory.
use crate::web::{ApiError, AppState};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path as FsPath, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use uuid::Uuid;

pub(in crate::web) const CHUNK_LIMIT: usize = 512 * 1024;
pub(in crate::web) const UPLOAD_LIMIT: u64 = 100 * 1024 * 1024;
const MAX_FILENAME_CHARS: usize = 160;
pub(in crate::web) const MAX_ACTIVE_UPLOADS: usize = 10;
const UPLOAD_IDLE_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug)]
struct UploadSession {
    id: String,
    root: PathBuf,
    temp_path: PathBuf,
    destination: PathBuf,
    filename: String,
    expected_size: u64,
    expected_sha256: String,
    received: u64,
    last_activity: Instant,
}

#[derive(Default)]
pub(in crate::web) struct UploadManager {
    sessions: Mutex<std::collections::HashMap<String, UploadSession>>,
}

impl UploadManager {
    pub(in crate::web) fn new() -> Self { Self::default() }

    pub(in crate::web) async fn cleanup_expired(&self) -> usize {
        self.cleanup_expired_at(Instant::now()).await
    }

    /// 以显式的 `now` 做截止判断：Windows 的 `Instant` 可能从进程/机器启动的
    /// 很短时间点起步，测试里 `Instant::now() - TTL` 会直接 panic。注入时间后
    /// 测试不必依赖机器已运行超过 TTL。
    async fn cleanup_expired_at(&self, now: Instant) -> usize {
        let mut sessions = self.sessions.lock().await;
        let active_roots = sessions.values().map(|session| session.root.clone()).collect::<std::collections::HashSet<_>>();
        for root in active_roots {
            let Ok(entries) = fs::read_dir(&root) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else { continue };
                let Some(id) = name.strip_prefix(".").and_then(|value| value.strip_suffix(".upload")) else { continue };
                if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) || sessions.contains_key(id) { continue; }
                let stale = entry.metadata().ok().and_then(|metadata| metadata.modified().ok())
                    .and_then(|modified| std::time::SystemTime::now().duration_since(modified).ok())
                    .is_some_and(|age| age >= UPLOAD_IDLE_TTL);
                if stale { let _ = fs::remove_file(path); }
            }
        }
        let expired = sessions
            .iter()
            .filter(|(_, session)| now.saturating_duration_since(session.last_activity) >= UPLOAD_IDLE_TTL)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in &expired {
            if let Some(session) = sessions.remove(id) {
                let _ = fs::remove_file(session.temp_path);
            }
        }
        expired.len()
    }

    pub(in crate::web) async fn cancel(&self, id: &str) -> bool {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.remove(id) {
            let _ = fs::remove_file(session.temp_path);
            true
        } else {
            false
        }
    }
}

pub(in crate::web) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_engine_bearer(&state, &headers)?;
    state.uploads.cleanup_expired().await;
    let sessions = state.uploads.sessions.lock().await;
    let now = Instant::now();
    let uploads = sessions.values().map(|session| json!({
        "upload_id": session.id,
        "filename": session.filename,
        "size": session.expected_size,
        "received": session.received,
        "expires_in": UPLOAD_IDLE_TTL.saturating_sub(now.saturating_duration_since(session.last_activity)).as_secs(),
    })).collect::<Vec<_>>();
    Ok(Json(json!({ "uploads": uploads, "max_active": MAX_ACTIVE_UPLOADS, "idle_ttl_seconds": UPLOAD_IDLE_TTL.as_secs() })))
}

pub(in crate::web) async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(upload_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_engine_bearer(&state, &headers)?;
    if state.uploads.cancel(&upload_id).await {
        Ok(Json(json!({ "ok": true, "upload_id": upload_id, "cancelled": true })))
    } else {
        Err(ApiError::not_found("upload session not found"))
    }
}

#[derive(Debug, Deserialize)]
pub(in crate::web) struct StartRequest {
    filename: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
pub(in crate::web) struct ChunkQuery {
    offset: u64,
}

fn require_engine_bearer(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    if state.token.trim().is_empty() {
        return Err(ApiError::unauthorized("uploads require a configured engine access token"));
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if bearer == Some(state.token.as_str()) {
        Ok(())
    } else {
        Err(ApiError::unauthorized("uploads require the engine Bearer token"))
    }
}

fn sanitize_filename(input: &str) -> Result<String, ApiError> {
    let normalized = input.trim().replace('\\', "/");
    let basename = normalized.rsplit('/').next().unwrap_or_default();
    let safe = basename
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, ':' | '<' | '>' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();
    let safe = safe.trim_matches([' ', '.']);
    let safe = safe.chars().take(MAX_FILENAME_CHARS).collect::<String>();
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err(ApiError::bad_request("filename must contain a usable basename"));
    }
    Ok(safe)
}

fn incoming_root(home: &FsPath) -> Result<PathBuf, ApiError> {
    let root = home.join("incoming");
    fs::create_dir_all(&root)
        .map_err(|error| ApiError::internal(format!("create incoming directory: {error}")))?;
    let canonical_home = fs::canonicalize(home)
        .map_err(|error| ApiError::internal(format!("resolve engine home: {error}")))?;
    let canonical_root = fs::canonicalize(&root)
        .map_err(|error| ApiError::internal(format!("resolve incoming directory: {error}")))?;
    if !canonical_root.starts_with(&canonical_home) {
        return Err(ApiError::forbidden("incoming directory resolves outside engine home"));
    }
    Ok(canonical_root)
}

fn sha256_file(path: &FsPath) -> Result<String, ApiError> {
    let mut file = fs::File::open(path)
        .map_err(|error| ApiError::internal(format!("open uploaded file: {error}")))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| ApiError::internal(format!("read uploaded file: {error}")))?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(in crate::web) async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<StartRequest>,
) -> Result<Json<Value>, ApiError> {
    require_engine_bearer(&state, &headers)?;
    state.uploads.cleanup_expired().await;
    if request.size > UPLOAD_LIMIT {
        return Err(ApiError::bad_request("upload exceeds the 100 MiB limit"));
    }
    let expected_sha256 = request.sha256.trim().to_ascii_lowercase();
    if expected_sha256.len() != 64 || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request("sha256 must be 64 hexadecimal characters"));
    }
    let filename = sanitize_filename(&request.filename)?;
    let root = incoming_root(&state.home)?;
    let id = Uuid::new_v4().simple().to_string();
    let temp_path = root.join(format!(".{id}.upload"));
    let destination = root.join(format!("{id}_{filename}"));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| ApiError::internal(format!("create upload staging file: {error}")))?;
    let session = UploadSession {
        id: id.clone(),
        root,
        temp_path,
        destination,
        filename,
        expected_size: request.size,
        expected_sha256,
        received: 0,
        last_activity: Instant::now(),
    };
    {
        let mut sessions = state.uploads.sessions.lock().await;
        let mut expired_files = Vec::new();
        sessions.retain(|_, existing| {
            let keep = existing.last_activity.elapsed() < UPLOAD_IDLE_TTL;
            if !keep { expired_files.push(existing.temp_path.clone()); }
            keep
        });
        for path in expired_files { let _ = fs::remove_file(path); }
        if sessions.len() >= MAX_ACTIVE_UPLOADS {
            let _ = fs::remove_file(&session.temp_path);
            return Err(ApiError::conflict(format!("at most {MAX_ACTIVE_UPLOADS} uploads may be active")));
        }
        sessions.insert(id.clone(), session);
    }
    Ok(Json(json!({
        "upload_id": id,
        "filename": sanitize_filename(&request.filename)?,
        "chunk_size": CHUNK_LIMIT,
        "max_size": UPLOAD_LIMIT,
        "received": 0,
    })))
}

pub(in crate::web) async fn chunk(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(upload_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<ChunkQuery>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    require_engine_bearer(&state, &headers)?;
    if body.is_empty() || body.len() > CHUNK_LIMIT {
        return Err(ApiError::bad_request("chunk size must be 1..512 KiB"));
    }
    state.uploads.cleanup_expired().await;
    let mut sessions = state.uploads.sessions.lock().await;
    let session = sessions
        .get_mut(&upload_id)
        .ok_or_else(|| ApiError::not_found("upload session not found"))?;
    if query.offset != session.received {
        return Err(ApiError::conflict(format!("expected chunk offset {}", session.received)));
    }
    let next = session.received.saturating_add(body.len() as u64);
    if next > session.expected_size {
        return Err(ApiError::bad_request("chunk exceeds declared upload size"));
    }
    if incoming_root(&state.home)? != session.root {
        return Err(ApiError::forbidden("incoming directory changed during upload"));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .open(&session.temp_path)
        .map_err(|error| ApiError::internal(format!("open upload staging file: {error}")))?;
    file.seek(SeekFrom::Start(session.received))
        .map_err(|error| ApiError::internal(format!("seek upload staging file: {error}")))?;
    if let Err(error) = file.write_all(&body).and_then(|_| file.sync_data()) {
        let _ = file.set_len(session.received);
        return Err(ApiError::internal(format!("write upload chunk: {error}")));
    }
    session.received = next;
    session.last_activity = Instant::now();
    Ok(Json(json!({ "upload_id": upload_id, "next_offset": next })))
}

pub(in crate::web) async fn finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(upload_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_engine_bearer(&state, &headers)?;
    state.uploads.cleanup_expired().await;
    let mut sessions = state.uploads.sessions.lock().await;
    let Some(session) = sessions.get(&upload_id).cloned() else {
        return Err(ApiError::not_found("upload session not found"));
    };
    let validation = (|| -> Result<String, ApiError> {
        if session.received != session.expected_size {
            return Err(ApiError::conflict(format!("upload incomplete: {} of {} bytes", session.received, session.expected_size)));
        }
        if incoming_root(&state.home)? != session.root {
            return Err(ApiError::forbidden("incoming directory changed during upload"));
        }
        let actual_sha256 = sha256_file(&session.temp_path)?;
        if actual_sha256 != session.expected_sha256 {
            return Err(ApiError::conflict("uploaded file SHA-256 mismatch"));
        }
        if session.destination.exists() {
            return Err(ApiError::conflict("upload destination already exists"));
        }
        Ok(actual_sha256)
    })();
    let actual_sha256 = match validation {
        Ok(digest) => digest,
        Err(error) => {
            sessions.remove(&upload_id);
            let _ = fs::remove_file(&session.temp_path);
            return Err(error);
        }
    };
    if let Err(error) = fs::rename(&session.temp_path, &session.destination) {
        sessions.remove(&upload_id);
        let _ = fs::remove_file(&session.temp_path);
        return Err(ApiError::internal(format!("commit uploaded file: {error}")));
    }
    sessions.remove(&upload_id);
    Ok(Json(json!({
        "ok": true,
        "upload_id": upload_id,
        "filename": session.filename,
        "path": session.destination.display().to_string(),
        "size": session.expected_size,
        "sha256": actual_sha256,
    })))
}

#[cfg(test)]
mod tests {
    use super::{CHUNK_LIMIT, MAX_ACTIVE_UPLOADS, UPLOAD_LIMIT, UPLOAD_IDLE_TTL, UploadManager, UploadSession, incoming_root, sanitize_filename};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    #[test]
    fn filename_is_reduced_to_a_safe_basename() {
        assert_eq!(sanitize_filename("../../folder\\unsafe:name?.txt").unwrap(), "unsafe_name_.txt");
        assert!(sanitize_filename("../...").is_err());
    }

    #[test]
    fn upload_limits_match_protocol_contract() {
        assert_eq!(CHUNK_LIMIT, 512 * 1024);
        assert_eq!(UPLOAD_LIMIT, 100 * 1024 * 1024);
    }

    #[cfg(unix)]
    #[test]
    fn incoming_symlink_cannot_escape_home() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), home.path().join("incoming")).unwrap();
        assert!(incoming_root(home.path()).is_err());
    }

    #[test]
    fn incoming_root_is_fixed_under_home() {
        let home = tempfile::tempdir().unwrap();
        let root = incoming_root(home.path()).unwrap();
        let canonical_home = fs::canonicalize(home.path()).unwrap();
        assert!(root.starts_with(canonical_home));
        assert_eq!(root.file_name().unwrap(), "incoming");
    }

    fn session(id: &str, temp_path: PathBuf, last_activity: Instant) -> UploadSession {
        UploadSession {
            id: id.to_owned(), root: temp_path.parent().unwrap().to_path_buf(),
            temp_path, destination: PathBuf::new(), filename: "test.bin".into(),
            expected_size: 1, expected_sha256: "0".repeat(64), received: 0, last_activity,
        }
    }

    #[tokio::test]
    async fn upload_manager_reaps_expired_files_and_cancels_active_files() {
        let temp = tempfile::tempdir().unwrap();
        let expired_path = temp.path().join("expired.upload");
        let active_path = temp.path().join("active.upload");
        fs::write(&expired_path, []).unwrap();
        fs::write(&active_path, []).unwrap();
        let manager = UploadManager::new();
        let now = Instant::now();
        {
            let mut sessions = manager.sessions.lock().await;
            sessions.insert("expired".into(), session("expired", expired_path.clone(), now));
            // 活跃会话的时间戳放在“未来”，这样截止点取 TTL 之后也不依赖机器已运行多久。
            sessions.insert("active".into(), session("active", active_path.clone(), now + UPLOAD_IDLE_TTL + Duration::from_secs(1)));
        }
        assert_eq!(manager.cleanup_expired_at(now + UPLOAD_IDLE_TTL + Duration::from_secs(2)).await, 1);
        assert!(!expired_path.exists());
        assert!(active_path.exists());
        assert!(manager.cancel("active").await);
        assert!(!active_path.exists());
        assert!(!manager.cancel("active").await);
    }

    #[test]
    fn active_upload_cap_is_ten() {
        assert_eq!(MAX_ACTIVE_UPLOADS, 10);
    }
}
