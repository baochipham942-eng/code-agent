use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    include_image, menu::MenuBuilder, tray::TrayIconBuilder, Emitter, Manager, RunEvent,
    WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent};

mod native_app_icon;
mod native_desktop;

use native_app_icon::desktop_get_app_icon;
use native_desktop::{
    desktop_capture_screenshot, desktop_get_capabilities, desktop_get_collector_status,
    desktop_get_frontmost_context, desktop_get_permission_status, desktop_list_recent_events,
    desktop_open_system_settings, desktop_request_microphone_permission, desktop_start_audio_rec,
    desktop_start_collector, desktop_stop_audio_rec, desktop_stop_collector,
    desktop_update_analyze_text, NativeDesktopState,
};

const SERVER_URL: &str = "http://localhost:8180";
const HEALTH_URL: &str = "http://localhost:8180/api/health";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);
const DEFAULT_CLOUD_API_URL: &str = "https://agentneo.vercel.app";
const BUNDLED_RUNTIME_ROOT_ENV: &str = "AGENT_NEO_BUNDLED_RUNTIME_ROOT";
const RESOURCE_DIR_ENV: &str = "AGENT_NEO_RESOURCE_DIR";
const BUNDLED_NODE_PATHS: &[&[&str]] = &[
    &["dist", "bundled-node", "bin", "node"],
    &["dist", "bundled-node", "node"],
    &["bundled-node", "bin", "node"],
    &["bundled-node", "node"],
];

#[derive(Default)]
struct AppState {
    web_server: Mutex<Option<Child>>,
}

impl AppState {
    fn store_child(&self, child: Child) {
        let mut guard = self.web_server.lock().expect("web_server mutex poisoned");
        *guard = Some(child);
    }

    fn cleanup(&self) {
        let mut guard = self.web_server.lock().expect("web_server mutex poisoned");

        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn unique_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for path in paths {
        if seen.insert(path.clone()) {
            result.push(path);
        }
    }

    result
}

fn candidate_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dev_roots = Vec::new();
    let mut packaged_roots = Vec::new();

    // In dev mode, CARGO_MANIFEST_DIR points to src-tauri/; its parent is the project root
    // where dist/web/webServer.cjs lives. This is the highest-priority candidate for dev.
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(project_root) = manifest_dir.parent() {
        dev_roots.push(project_root.to_path_buf());
    }
    dev_roots.push(manifest_dir.to_path_buf());

    if let Ok(cwd) = env::current_dir() {
        dev_roots.push(cwd);
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        // Tauri preserves resources declared as "../dist/..." under
        // Contents/Resources/_up_/dist/... inside the macOS app bundle.
        packaged_roots.push(resource_dir.join("_up_"));
        packaged_roots.push(resource_dir.clone());

        if let Some(parent) = resource_dir.parent() {
            packaged_roots.push(parent.to_path_buf());
        }
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            packaged_roots.push(exe_dir.to_path_buf());

            if let Some(parent) = exe_dir.parent() {
                packaged_roots.push(parent.to_path_buf());

                if let Some(grandparent) = parent.parent() {
                    packaged_roots.push(grandparent.to_path_buf());
                }
            }
        }
    }

    let mut roots = Vec::new();
    if cfg!(debug_assertions) {
        roots.extend(dev_roots);
        roots.extend(packaged_roots);
    } else {
        roots.extend(packaged_roots);
        roots.extend(dev_roots);
    }

    unique_paths(roots)
}

fn resolve_server_script(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let relative_path = Path::new("dist").join("web").join("webServer.cjs");

    for root in candidate_roots(app) {
        let candidate = root.join(&relative_path);
        if candidate.exists() {
            return Ok((candidate, root));
        }
    }

    Err(format!(
        "Could not find {} in current directory, resource directory, or executable-relative paths",
        relative_path.display()
    ))
}

fn web_server_runtime_env(
    bundled_runtime_root: &Path,
    resource_dir: Option<&Path>,
) -> Vec<(&'static str, PathBuf)> {
    let mut values = vec![(BUNDLED_RUNTIME_ROOT_ENV, bundled_runtime_root.to_path_buf())];

    if let Some(resource_dir) = resource_dir {
        values.push((RESOURCE_DIR_ENV, resource_dir.to_path_buf()));
    }

    values
}

fn is_server_running() -> bool {
    let client = match Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    matches!(client.get(HEALTH_URL).send(), Ok(resp) if resp.status().as_u16() == 200)
}

fn make_boot_token() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("tauri-{}-{now}", std::process::id())
}

fn health_matches_boot_token(body: &str, expected_token: Option<&str>) -> bool {
    let Some(expected_token) = expected_token else {
        return true;
    };

    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return false,
    };

    parsed
        .get("tauriBootToken")
        .and_then(|value| value.as_str())
        .is_some_and(|actual| actual == expected_token)
}

fn append_segments(root: &Path, segments: &[&str]) -> PathBuf {
    segments
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

fn bundled_node_candidates(
    bundled_runtime_root: &Path,
    resource_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = vec![bundled_runtime_root.to_path_buf()];

    if let Some(resource_dir) = resource_dir {
        roots.push(resource_dir.join("_up_"));
        roots.push(resource_dir.to_path_buf());
    }

    unique_paths(
        roots
            .into_iter()
            .flat_map(|root| {
                BUNDLED_NODE_PATHS
                    .iter()
                    .map(move |segments| append_segments(&root, segments))
            })
            .collect(),
    )
}

fn resolve_bundled_node_binary(
    bundled_runtime_root: &Path,
    resource_dir: Option<&Path>,
) -> Option<PathBuf> {
    bundled_node_candidates(bundled_runtime_root, resource_dir)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn resolve_system_node_binary() -> PathBuf {
    // macOS GUI apps launched from Finder have a minimal PATH that excludes
    // common Node.js installation directories. Search them explicitly.
    let candidates = [
        "/usr/local/bin/node",    // Homebrew (Intel Mac)
        "/opt/homebrew/bin/node", // Homebrew (Apple Silicon)
    ];

    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return PathBuf::from(candidate);
        }
    }

    // Fallback: check ~/.nvm/current symlink
    if let Ok(home) = env::var("HOME") {
        let nvm_current = format!("{home}/.nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_current) {
            // Pick the latest version directory
            let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).collect();
            versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
            if let Some(latest) = versions.first() {
                let bin = latest.path().join("bin/node");
                if bin.exists() {
                    return bin;
                }
            }
        }
    }

    PathBuf::from("node")
}

fn resolve_node_binary(bundled_runtime_root: &Path, resource_dir: Option<&Path>) -> PathBuf {
    if !cfg!(debug_assertions) {
        if let Some(bin) = resolve_bundled_node_binary(bundled_runtime_root, resource_dir) {
            return bin;
        }
    }

    if let Ok(bin) = env::var("NODE_BINARY") {
        return PathBuf::from(bin);
    }

    if cfg!(debug_assertions) {
        if let Some(bin) = resolve_bundled_node_binary(bundled_runtime_root, resource_dir) {
            return bin;
        }
    }

    resolve_system_node_binary()
}

fn spawn_web_server(app: &tauri::AppHandle) -> Result<(Child, String), String> {
    let (script_path, working_dir) = resolve_server_script(app)?;
    let boot_token = make_boot_token();
    let resource_dir = app.path().resource_dir().ok();
    let node_binary = resolve_node_binary(&working_dir, resource_dir.as_deref());

    // 显式继承父进程 env，让 launchctl setenv / shell 注入的 HTTPS_PROXY 等变量
    // 流到 webServer 的 Node 进程。Rust Command 默认就继承父 env，但写出来更明确。
    let mut command = Command::new(&node_binary);
    command
        .arg(&script_path)
        .current_dir(&working_dir)
        .envs(env::vars())
        .env("CODE_AGENT_TAURI_BOOT_TOKEN", &boot_token)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    for (key, value) in web_server_runtime_env(&working_dir, resource_dir.as_deref()) {
        command.env(key, value.as_os_str());
    }

    let child = command.spawn().map_err(|error| {
        format!(
            "Failed to start web server at {} (node: {}): {}",
            script_path.display(),
            node_binary.display(),
            error
        )
    })?;

    Ok((child, boot_token))
}

fn wait_for_healthcheck(
    child: &mut Child,
    expected_boot_token: Option<&str>,
) -> Result<(), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))?;

    let deadline = Instant::now() + HEALTH_TIMEOUT;

    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "Web server exited before healthcheck completed: {status}"
                ));
            }
            Ok(None) => {}
            Err(error) => return Err(format!("Failed to inspect web server process: {error}")),
        }

        match client.get(HEALTH_URL).send() {
            Ok(response) if response.status().as_u16() == 200 => {
                let body = response.text().unwrap_or_default();
                if health_matches_boot_token(&body, expected_boot_token) {
                    return Ok(());
                }
                thread::sleep(HEALTH_INTERVAL);
            }
            Ok(_) | Err(_) => thread::sleep(HEALTH_INTERVAL),
        }
    }

    Err(format!(
        "Timed out after {}s waiting for {}",
        HEALTH_TIMEOUT.as_secs(),
        HEALTH_URL
    ))
}

fn cleanup_server(app: &tauri::AppHandle) {
    app.state::<AppState>().cleanup();
}

fn install_signal_handler(app: &tauri::AppHandle) {
    let handle = app.clone();

    let _ = ctrlc::set_handler(move || {
        cleanup_server(&handle);
        handle.exit(0);
    });
}

// ============================================================================
// Tauri Update Commands
// ============================================================================

#[derive(Serialize, Clone)]
struct TauriUpdateInfo {
    has_update: bool,
    current_version: String,
    latest_version: Option<String>,
    release_notes: Option<String>,
    date: Option<String>,
    force_update: Option<bool>,
    download_url: Option<String>,
    file_size: Option<u64>,
    sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudUpdateResponse {
    success: Option<bool>,
    has_update: Option<bool>,
    force_update: Option<bool>,
    current_version: Option<String>,
    latest_version: Option<String>,
    min_version: Option<String>,
    download_url: Option<String>,
    sha256: Option<String>,
    release_notes: Option<String>,
    file_size: Option<u64>,
    published_at: Option<String>,
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.config().version.clone().unwrap_or_default()
}

fn update_api_url(current_version: &str) -> String {
    let base_url = env::var("CLOUD_API_URL").unwrap_or_else(|_| DEFAULT_CLOUD_API_URL.to_string());
    let channel = env::var("CODE_AGENT_RELEASE_CHANNEL")
        .or_else(|_| env::var("UPDATE_RELEASE_CHANNEL"))
        .unwrap_or_else(|_| "stable".to_string());
    let channel = sanitize_release_channel(&channel);
    let platform = match env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        "linux" => "linux",
        other => other,
    };
    format!(
        "{}/api/update?action=check&version={}&platform={}&channel={}",
        base_url.trim_end_matches('/'),
        current_version,
        platform,
        channel
    )
}

fn sanitize_release_channel(channel: &str) -> String {
    let sanitized: String = channel
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if sanitized.is_empty() {
        "stable".to_string()
    } else {
        sanitized.to_lowercase()
    }
}

fn normalize_update_version(version: &str) -> String {
    version.trim().trim_start_matches('v').to_string()
}

fn compare_update_versions(left: &str, right: &str) -> Ordering {
    let left_parts: Vec<u64> = normalize_update_version(left)
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();
    let right_parts: Vec<u64> = normalize_update_version(right)
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();

    for index in 0..left_parts.len().max(right_parts.len()) {
        let left_part = *left_parts.get(index).unwrap_or(&0);
        let right_part = *right_parts.get(index).unwrap_or(&0);
        match left_part.cmp(&right_part) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }

    Ordering::Equal
}

fn normalize_sha256(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase();
    if normalized.len() == 64 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(normalized)
    } else {
        None
    }
}

fn latest_update_version(
    server_latest: Option<&str>,
    policy_min: Option<&str>,
    current_version: &str,
) -> Option<String> {
    let mut latest = server_latest
        .map(normalize_update_version)
        .filter(|version| !version.is_empty());

    if let Some(policy_min) = policy_min {
        let normalized_min = normalize_update_version(policy_min);
        if !normalized_min.is_empty()
            && compare_update_versions(&normalized_min, current_version) == Ordering::Greater
        {
            latest = match latest {
                Some(current_latest)
                    if compare_update_versions(&normalized_min, &current_latest)
                        != Ordering::Greater =>
                {
                    Some(current_latest)
                }
                _ => Some(normalized_min),
            };
        }
    }

    latest
}

fn cloud_update_info_from_response(
    payload: CloudUpdateResponse,
    fallback_current_version: String,
) -> TauriUpdateInfo {
    let current_version = payload
        .current_version
        .clone()
        .unwrap_or(fallback_current_version);
    let policy_min_required = payload
        .min_version
        .as_deref()
        .map(|version| compare_update_versions(version, &current_version) == Ordering::Greater)
        .unwrap_or(false);
    let latest_version = latest_update_version(
        payload.latest_version.as_deref(),
        payload.min_version.as_deref(),
        &current_version,
    );
    let version_has_update = latest_version
        .as_deref()
        .map(|version| compare_update_versions(version, &current_version) == Ordering::Greater)
        .unwrap_or(false);
    let has_update =
        payload.has_update.unwrap_or(false) || version_has_update || policy_min_required;
    let force_update = if payload.force_update.is_some() || policy_min_required {
        Some((payload.force_update.unwrap_or(false) && has_update) || policy_min_required)
    } else {
        None
    };
    let download_url = payload
        .download_url
        .as_deref()
        .and_then(normalize_manual_update_url);
    let sha256 = payload.sha256.as_deref().and_then(normalize_sha256);

    TauriUpdateInfo {
        has_update,
        current_version,
        latest_version,
        release_notes: payload.release_notes,
        date: payload.published_at,
        force_update,
        download_url,
        file_size: payload.file_size,
        sha256,
    }
}

fn check_cloud_update(current_version: String) -> Result<TauriUpdateInfo, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(format!("Agent Neo Tauri/{}", current_version))
        .build()
        .map_err(|error| format!("Failed to build update HTTP client: {error}"))?;

    let response = client
        .get(update_api_url(&current_version))
        .send()
        .map_err(|error| format!("Cloud update check failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Cloud update check failed with HTTP {}",
            response.status()
        ));
    }

    let body = response
        .text()
        .map_err(|error| format!("Failed to read cloud update response: {error}"))?;
    let payload = serde_json::from_str::<CloudUpdateResponse>(&body)
        .map_err(|error| format!("Failed to parse cloud update response: {error}"))?;

    if payload.success == Some(false) {
        return Err("Cloud update API returned success=false".to_string());
    }

    Ok(cloud_update_info_from_response(payload, current_version))
}

async fn check_native_update(
    app: tauri::AppHandle,
    current_version: String,
) -> Result<TauriUpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;

    let update = app
        .updater()
        .map_err(|e| format!("Failed to create updater: {e}"))?
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?;

    match update {
        Some(update) => Ok(TauriUpdateInfo {
            has_update: true,
            current_version,
            latest_version: Some(update.version.clone()),
            release_notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
            force_update: None,
            download_url: None,
            file_size: None,
            sha256: None,
        }),
        None => Ok(TauriUpdateInfo {
            has_update: false,
            current_version,
            latest_version: None,
            release_notes: None,
            date: None,
            force_update: None,
            download_url: None,
            file_size: None,
            sha256: None,
        }),
    }
}

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<TauriUpdateInfo, String> {
    let current_version = get_app_version(app.clone());
    let native_no_update = match check_native_update(app, current_version.clone()).await {
        Ok(info) if info.has_update => return Ok(info),
        Ok(info) => Some(info),
        Err(error) => {
            eprintln!("Native update check failed, trying cloud update: {error}");
            None
        }
    };

    let cloud_version = current_version;
    match tauri::async_runtime::spawn_blocking(move || check_cloud_update(cloud_version)).await {
        Ok(Ok(info)) => Ok(info),
        Ok(Err(error)) => {
            eprintln!("Cloud update check failed: {error}");
            native_no_update.ok_or(error)
        }
        Err(error) => {
            let message = format!("Cloud update check task failed: {error}");
            eprintln!("{message}");
            native_no_update.ok_or(message)
        }
    }
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let update = app
        .updater()
        .map_err(|e| format!("Failed to create updater: {e}"))?
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?;

    let Some(update) = update else {
        return Err("No update available".to_string());
    };

    let mut started = false;
    let install_result = update
        .download_and_install(
            |_chunk_length, content_length| {
                if !started {
                    started = true;
                    eprintln!("[updater] download started, total size: {:?}", content_length);
                }
            },
            || {
                eprintln!("[updater] download finished, installing...");
            },
        )
        .await;

    if let Err(e) = &install_result {
        eprintln!("[updater] install failed: {e:?}");
        let mut source = std::error::Error::source(e);
        let mut depth = 0;
        while let Some(s) = source {
            eprintln!("[updater] cause [{depth}]: {s}");
            source = std::error::Error::source(s);
            depth += 1;
        }
    }
    install_result.map_err(|e| format!("Failed to install update: {e}"))?;

    // Restart the app after update.
    app.restart()
}

// Block raw installer/binary suffixes. open_update_url is only for routing
// the user to a release page (HTML); pulling unsigned binaries must go through
// the native updater's pubkey-verified path.
const BLOCKED_UPDATE_URL_SUFFIXES: &[&str] = &[
    ".dmg",
    ".pkg",
    ".msi",
    ".exe",
    ".appimage",
    ".deb",
    ".rpm",
    ".zip",
    ".tar",
    ".tar.gz",
    ".tgz",
];

fn validate_update_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Update URL must use HTTPS".to_string());
    }

    // Strip query/fragment before suffix check so attackers can't bypass with
    // "?download=1" or "#frag".
    let path_only = url.split(['?', '#']).next().unwrap_or(url).to_lowercase();

    if BLOCKED_UPDATE_URL_SUFFIXES
        .iter()
        .any(|suffix| path_only.ends_with(suffix))
    {
        return Err(
            "Update URL points at a binary download; only release pages \
             (HTML) are allowed here. Use the native updater for verified \
             installers."
                .to_string(),
        );
    }

    Ok(())
}

fn github_release_page_from_download_url(url: &str) -> Option<String> {
    let path = url.strip_prefix("https://github.com/")?;
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 5 || parts[2] != "releases" || parts[3] != "download" {
        return None;
    }
    Some(format!(
        "https://github.com/{}/{}/releases/tag/{}",
        parts[0], parts[1], parts[4]
    ))
}

fn normalize_manual_update_url(url: &str) -> Option<String> {
    if validate_update_url(url).is_ok() {
        return Some(url.to_string());
    }

    github_release_page_from_download_url(url)
        .filter(|release_page| validate_update_url(release_page).is_ok())
}

#[tauri::command]
fn open_update_url(url: String) -> Result<(), String> {
    validate_update_url(&url)?;
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|error| format!("Failed to open update URL: {error}"))
}

#[cfg(test)]
mod runtime_env_tests {
    use super::{
        bundled_node_candidates, web_server_runtime_env, BUNDLED_RUNTIME_ROOT_ENV, RESOURCE_DIR_ENV,
    };
    use std::path::Path;

    #[test]
    fn includes_bundled_runtime_root_for_web_server() {
        let env = web_server_runtime_env(Path::new("/tmp/Agent.app/Contents/Resources/_up_"), None);

        assert_eq!(env.len(), 1);
        assert_eq!(env[0].0, BUNDLED_RUNTIME_ROOT_ENV);
        assert_eq!(
            env[0].1,
            Path::new("/tmp/Agent.app/Contents/Resources/_up_").to_path_buf()
        );
    }

    #[test]
    fn includes_resource_dir_when_available() {
        let env = web_server_runtime_env(
            Path::new("/tmp/Agent.app/Contents/Resources/_up_"),
            Some(Path::new("/tmp/Agent.app/Contents/Resources")),
        );

        assert_eq!(
            env,
            vec![
                (
                    BUNDLED_RUNTIME_ROOT_ENV,
                    Path::new("/tmp/Agent.app/Contents/Resources/_up_").to_path_buf()
                ),
                (
                    RESOURCE_DIR_ENV,
                    Path::new("/tmp/Agent.app/Contents/Resources").to_path_buf()
                ),
            ]
        );
    }

    #[test]
    fn checks_bundled_node_under_packaged_runtime_root_first() {
        let candidates = bundled_node_candidates(
            Path::new("/tmp/Agent.app/Contents/Resources/_up_"),
            Some(Path::new("/tmp/Agent.app/Contents/Resources")),
        );

        assert_eq!(
            candidates[0],
            Path::new("/tmp/Agent.app/Contents/Resources/_up_/dist/bundled-node/bin/node")
                .to_path_buf()
        );
        assert!(candidates.contains(
            &Path::new("/tmp/Agent.app/Contents/Resources/dist/bundled-node/bin/node")
                .to_path_buf()
        ));
    }
}

#[cfg(test)]
mod update_url_tests {
    use super::{
        cloud_update_info_from_response, compare_update_versions,
        github_release_page_from_download_url, normalize_manual_update_url,
        sanitize_release_channel, validate_update_url, CloudUpdateResponse,
    };
    use std::cmp::Ordering;

    #[test]
    fn allows_https_release_page() {
        assert!(validate_update_url("https://github.com/owner/repo/releases/tag/v1.2.3").is_ok());
        assert!(validate_update_url("https://agentneo.vercel.app/releases").is_ok());
    }

    #[test]
    fn rejects_non_https() {
        assert!(validate_update_url("http://github.com/foo").is_err());
        assert!(validate_update_url("file:///tmp/evil.dmg").is_err());
        assert!(validate_update_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn rejects_binary_suffixes() {
        for suffix in [
            ".dmg",
            ".DMG",
            ".pkg",
            ".msi",
            ".exe",
            ".AppImage",
            ".deb",
            ".rpm",
            ".zip",
            ".tar",
            ".tar.gz",
            ".tgz",
        ] {
            let url = format!("https://example.com/foo/bar{}", suffix);
            assert!(
                validate_update_url(&url).is_err(),
                "expected reject for {url}"
            );
        }
    }

    #[test]
    fn rejects_binary_with_query_or_fragment_bypass() {
        // Attackers shouldn't be able to bypass with ?token=x or #anchor.
        assert!(validate_update_url("https://example.com/foo.dmg?download=1").is_err());
        assert!(validate_update_url("https://example.com/foo.exe#fragment").is_err());
        assert!(validate_update_url("https://example.com/foo.tar.gz?v=1#a").is_err());
    }

    #[test]
    fn allows_html_with_query_string() {
        assert!(validate_update_url("https://example.com/release?id=v1").is_ok());
        assert!(validate_update_url("https://example.com/page#section").is_ok());
    }

    #[test]
    fn converts_github_binary_asset_to_release_page() {
        assert_eq!(
            github_release_page_from_download_url(
                "https://github.com/owner/repo/releases/download/v1.2.3/Code%20Agent.dmg"
            ),
            Some("https://github.com/owner/repo/releases/tag/v1.2.3".to_string())
        );
        assert_eq!(
            normalize_manual_update_url(
                "https://github.com/owner/repo/releases/download/v1.2.3/Code%20Agent.dmg"
            ),
            Some("https://github.com/owner/repo/releases/tag/v1.2.3".to_string())
        );
    }

    #[test]
    fn drops_non_github_binary_asset_urls() {
        assert_eq!(
            normalize_manual_update_url("https://example.com/releases/Code.Agent.dmg"),
            None
        );
    }

    #[test]
    fn compares_update_versions_numerically() {
        assert_eq!(
            compare_update_versions("v0.16.76", "0.16.75"),
            Ordering::Greater
        );
        assert_eq!(compare_update_versions("0.16.9", "0.16.10"), Ordering::Less);
        assert_eq!(
            compare_update_versions("0.16.75", "v0.16.75"),
            Ordering::Equal
        );
    }

    #[test]
    fn sanitizes_release_channel_for_update_query() {
        assert_eq!(sanitize_release_channel(" Beta "), "beta");
        assert_eq!(sanitize_release_channel("canary/../../x"), "canaryx");
        assert_eq!(sanitize_release_channel("  "), "stable");
    }

    #[test]
    fn applies_cloud_min_version_policy_to_manual_update_info() {
        let info = cloud_update_info_from_response(
            CloudUpdateResponse {
                success: Some(true),
                has_update: Some(false),
                force_update: Some(true),
                current_version: Some("0.16.75".to_string()),
                latest_version: Some("0.16.75".to_string()),
                min_version: Some("v0.16.76".to_string()),
                download_url: Some(
                    "https://github.com/owner/repo/releases/download/v0.16.76/Code.Agent.dmg"
                        .to_string(),
                ),
                sha256: Some("A".repeat(64)),
                release_notes: Some("policy gate".to_string()),
                file_size: Some(123),
                published_at: Some("2026-05-17T00:00:00Z".to_string()),
            },
            "0.16.75".to_string(),
        );

        assert!(info.has_update);
        assert_eq!(info.force_update, Some(true));
        assert_eq!(info.latest_version, Some("0.16.76".to_string()));
        assert_eq!(
            info.download_url,
            Some("https://github.com/owner/repo/releases/tag/v0.16.76".to_string())
        );
        assert_eq!(info.sha256, Some("a".repeat(64)));
    }
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .text("new_chat", "新建对话")
        .text("paste_context", "粘贴为上下文")
        .separator()
        .quit()
        .build()?;
    const TRAY_ICON: tauri::image::Image<'_> = include_image!("./icons/tray-template.png");

    let _tray = TrayIconBuilder::new()
        .icon(TRAY_ICON)
        .icon_as_template(true)
        .tooltip("Agent Neo")
        .menu(&menu)
        .on_menu_event(move |app_handle, event| {
            let activate_window = |handle: &tauri::AppHandle| {
                if let Some(win) = handle.get_webview_window("main") {
                    win.show().ok();
                    win.set_focus().ok();
                }
            };
            match event.id().as_ref() {
                "new_chat" => {
                    activate_window(app_handle);
                    app_handle.emit("memo:new_chat", ()).ok();
                }
                "paste_context" => {
                    activate_window(app_handle);
                    app_handle.emit("memo:paste_context", ()).ok();
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}

fn setup_global_shortcut(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    app.global_shortcut().on_shortcut(
        "CmdOrCtrl+Shift+A",
        move |_app_handle, _shortcut: &Shortcut, _event: ShortcutEvent| {
            if let Some(win) = handle.get_webview_window("main") {
                win.show().ok();
                win.set_focus().ok();
            }
            handle.emit("memo:activate", ()).ok();
        },
    )?;

    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        // single-instance 必须在其他 plugin 之前注册：后启动的进程会直接退出，
        // 并把 argv/cwd 传给已运行的实例，由 callback 聚焦已有窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(NativeDesktopState::default())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            check_for_update,
            install_update,
            open_update_url,
            desktop_get_capabilities,
            desktop_get_permission_status,
            desktop_get_frontmost_context,
            desktop_capture_screenshot,
            desktop_get_collector_status,
            desktop_start_collector,
            desktop_stop_collector,
            desktop_list_recent_events,
            desktop_open_system_settings,
            desktop_update_analyze_text,
            desktop_request_microphone_permission,
            desktop_start_audio_rec,
            desktop_stop_audio_rec,
            desktop_get_app_icon
        ])
        .setup(|app| {
            if cfg!(debug_assertions) && is_server_running() {
                // Server already running (e.g. started by Tauri beforeDevCommand in dev mode).
                // Release builds must not trust an arbitrary healthy localhost:8180 process:
                // a stale dev server can serve mismatched renderer assets and leave the app white.
                println!("Web server already running on {SERVER_URL}, skipping spawn");
            } else {
                let (mut child, boot_token) = spawn_web_server(&app.handle())?;

                if let Err(error) = wait_for_healthcheck(&mut child, Some(&boot_token)) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error.into());
                }

                app.state::<AppState>().store_child(child);
            }

            if let Some(window) = app.get_webview_window("main") {
                // window 初始 url 是 about:blank（tauri.conf.json），避免启动竞赛下
                // webServer 未起时页面加载失败白屏。healthcheck 通过后用
                // webview.navigate() 跳到 SERVER_URL（比 eval+JS 更可靠，且走正常
                // 导航而不是 cross-origin replace）。
                if let Ok(url) = SERVER_URL.parse() {
                    let _ = window.navigate(url);
                }
                let _ = window.show();
                let _ = window.set_focus();
            }

            // System Tray
            if let Err(e) = setup_tray(app) {
                eprintln!("Failed to setup tray: {e}");
            }

            // Global Shortcut (Cmd+Shift+A)
            if let Err(e) = setup_global_shortcut(app) {
                eprintln!("Failed to setup global shortcut: {e}");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application");

    install_signal_handler(app.handle());

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            api.prevent_close();
            if let Some(win) = app_handle.get_webview_window("main") {
                let _ = win.minimize();
            }
        }
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            cleanup_server(app_handle);
        }
        _ => {}
    });
}
