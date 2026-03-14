use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    env,
    fs,
    io::Write,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDesktopCapabilities {
    platform: String,
    supports_screen_capture: bool,
    supports_permission_checks: bool,
    supports_frontmost_context: bool,
    supports_browser_context: bool,
    supports_system_settings_links: bool,
    supports_background_collection: bool,
    phase: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePermissionStatus {
    kind: String,
    status: String,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePermissionSnapshot {
    platform: String,
    checked_at_ms: u128,
    permissions: Vec<NativePermissionStatus>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrontmostContextSnapshot {
    platform: String,
    captured_at_ms: u128,
    app_name: String,
    bundle_id: Option<String>,
    window_title: Option<String>,
    browser_url: Option<String>,
    browser_title: Option<String>,
    document_path: Option<String>,
    session_state: Option<String>,
    idle_seconds: Option<u64>,
    power_source: Option<String>,
    on_ac_power: Option<bool>,
    battery_percent: Option<u8>,
    battery_charging: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotCaptureResult {
    path: String,
    bytes: u64,
    captured_at_ms: u128,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityEvent {
    id: String,
    captured_at_ms: u128,
    app_name: String,
    bundle_id: Option<String>,
    window_title: Option<String>,
    browser_url: Option<String>,
    browser_title: Option<String>,
    document_path: Option<String>,
    session_state: Option<String>,
    idle_seconds: Option<u64>,
    power_source: Option<String>,
    on_ac_power: Option<bool>,
    battery_percent: Option<u8>,
    battery_charging: Option<bool>,
    screenshot_path: Option<String>,
    fingerprint: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NativeDesktopCollectorStatus {
    running: bool,
    phase: String,
    interval_secs: u64,
    capture_screenshots: bool,
    redact_sensitive_contexts: bool,
    retention_days: u64,
    dedupe_window_secs: u64,
    max_recent_events: usize,
    last_event_at_ms: Option<u128>,
    last_cleanup_at_ms: Option<u128>,
    last_error: Option<String>,
    last_fingerprint: Option<String>,
    total_events_written: u64,
    event_dir: Option<String>,
    screenshot_dir: Option<String>,
    events_file: Option<String>,
    sqlite_db_path: Option<String>,
}

impl Default for NativeDesktopCollectorStatus {
    fn default() -> Self {
        Self {
            running: false,
            phase: "p1_background_collector".to_string(),
            interval_secs: 30,
            capture_screenshots: true,
            redact_sensitive_contexts: true,
            retention_days: 7,
            dedupe_window_secs: 60,
            max_recent_events: 20,
            last_event_at_ms: None,
            last_cleanup_at_ms: None,
            last_error: None,
            last_fingerprint: None,
            total_events_written: 0,
            event_dir: None,
            screenshot_dir: None,
            events_file: None,
            sqlite_db_path: None,
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotCaptureRequest {
    output_path: Option<String>,
    silent: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSystemSettingsRequest {
    kind: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CollectorStartRequest {
    interval_secs: Option<u64>,
    capture_screenshots: Option<bool>,
    redact_sensitive_contexts: Option<bool>,
    retention_days: Option<u64>,
    dedupe_window_secs: Option<u64>,
    max_recent_events: Option<usize>,
}

impl Default for CollectorStartRequest {
    fn default() -> Self {
        Self {
            interval_secs: Some(30),
            capture_screenshots: Some(true),
            redact_sensitive_contexts: Some(true),
            retention_days: Some(7),
            dedupe_window_secs: Some(60),
            max_recent_events: Some(20),
        }
    }
}

struct CollectorRuntime {
    stop_flag: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[derive(Default)]
struct CollectorSharedState {
    status: NativeDesktopCollectorStatus,
    recent_events: VecDeque<DesktopActivityEvent>,
}

pub struct NativeDesktopState {
    collector: Mutex<Option<CollectorRuntime>>,
    shared: Arc<Mutex<CollectorSharedState>>,
}

impl Default for NativeDesktopState {
    fn default() -> Self {
        Self {
            collector: Mutex::new(None),
            shared: Arc::new(Mutex::new(CollectorSharedState::default())),
        }
    }
}

impl NativeDesktopState {
    fn stop_collector(&self) -> Result<(), String> {
        let runtime = {
            let mut guard = self.collector.lock().map_err(|_| "Collector mutex poisoned".to_string())?;
            guard.take()
        };

        if let Some(runtime) = runtime {
            runtime.stop_flag.store(true, Ordering::SeqCst);
            runtime
                .handle
                .join()
                .map_err(|_| "Collector thread panicked".to_string())?;
        }

        let mut shared = self.shared.lock().map_err(|_| "Collector shared state poisoned".to_string())?;
        shared.status.running = false;
        Ok(())
    }

    fn status(&self) -> Result<NativeDesktopCollectorStatus, String> {
        let shared = self.shared.lock().map_err(|_| "Collector shared state poisoned".to_string())?;
        Ok(shared.status.clone())
    }

    fn recent_events(&self, limit: usize) -> Result<Vec<DesktopActivityEvent>, String> {
        let shared = self.shared.lock().map_err(|_| "Collector shared state poisoned".to_string())?;
        Ok(shared.recent_events.iter().take(limit).cloned().collect())
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn trim_or_none(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn path_to_string(path: &PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn run_command(binary: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(binary)
        .args(args)
        .output()
        .map_err(|error| format!("Failed to run {binary}: {error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(if detail.is_empty() {
            format!("{binary} exited with status {}", output.status)
        } else {
            detail
        })
    }
}

fn current_date_string() -> String {
    run_command("date", &["+%F"]).unwrap_or_else(|_| "unknown-date".to_string())
}

fn native_desktop_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base_dir = if let Ok(dir) = env::var("CODE_AGENT_DATA_DIR") {
        PathBuf::from(dir)
    } else if let Ok(home) = env::var("HOME") {
        PathBuf::from(home).join(".code-agent")
    } else {
        app.path()
            .app_data_dir()
            .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
    };
    let root = base_dir.join("native-desktop");
    fs::create_dir_all(&root).map_err(|error| format!("Failed to create native desktop root: {error}"))?;
    Ok(root)
}

fn native_events_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = native_desktop_root(app)?.join("events");
    fs::create_dir_all(&dir).map_err(|error| format!("Failed to create event directory: {error}"))?;
    Ok(dir)
}

fn native_screenshot_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = native_desktop_root(app)?.join("screenshots");
    fs::create_dir_all(&dir).map_err(|error| format!("Failed to create screenshot directory: {error}"))?;
    Ok(dir)
}

fn native_sqlite_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(native_desktop_root(app)?.join("desktop-activity.sqlite3"))
}

fn collector_status_file(native_root: &PathBuf) -> PathBuf {
    native_root.join("collector-status.json")
}

fn persist_collector_status(native_root: &PathBuf, status: &NativeDesktopCollectorStatus) -> Result<(), String> {
    fs::create_dir_all(native_root).map_err(|error| format!("Failed to create native desktop root: {error}"))?;
    let payload = serde_json::to_string_pretty(status)
        .map_err(|error| format!("Failed to serialize collector status: {error}"))?;
    fs::write(collector_status_file(native_root), payload)
        .map_err(|error| format!("Failed to write collector status: {error}"))?;
    Ok(())
}

fn collector_event_file_for_date(event_dir: &PathBuf) -> Result<PathBuf, String> {
    fs::create_dir_all(event_dir).map_err(|error| format!("Failed to create event directory: {error}"))?;
    Ok(event_dir.join(format!("{}.jsonl", current_date_string())))
}

fn default_screenshot_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(native_screenshot_dir(app)?.join(format!("native_screenshot_{}.png", now_ms())))
}

fn collector_screenshot_path(screenshot_dir: &PathBuf) -> Result<PathBuf, String> {
    let daily_dir = screenshot_dir.join(current_date_string());
    fs::create_dir_all(&daily_dir).map_err(|error| format!("Failed to create screenshot directory: {error}"))?;
    Ok(daily_dir.join(format!("collector_{}.png", now_ms())))
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Result<String, String> {
    run_command("osascript", &["-e", script])
}

#[cfg(not(target_os = "macos"))]
fn run_osascript(_script: &str) -> Result<String, String> {
    Err("AppleScript is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn probe_accessibility_permission() -> NativePermissionStatus {
    let script = r#"
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          return name of frontApp
        end tell
    "#;

    match run_osascript(script) {
        Ok(_) => NativePermissionStatus {
            kind: "accessibility".to_string(),
            status: "granted".to_string(),
            detail: Some("System Events automation is available.".to_string()),
        },
        Err(error) => NativePermissionStatus {
            kind: "accessibility".to_string(),
            status: "denied".to_string(),
            detail: Some(error),
        },
    }
}

#[cfg(not(target_os = "macos"))]
fn probe_accessibility_permission() -> NativePermissionStatus {
    NativePermissionStatus {
        kind: "accessibility".to_string(),
        status: "unsupported".to_string(),
        detail: Some("Accessibility probing is only implemented on macOS.".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn probe_screen_capture_permission() -> NativePermissionStatus {
    let probe_path = env::temp_dir().join(format!("code-agent-screen-probe-{}.png", now_ms()));
    let output = Command::new("screencapture")
        .args(["-x", "-t", "png"])
        .arg(&probe_path)
        .output();

    let result = match output {
        Ok(output) if output.status.success() => match fs::metadata(&probe_path) {
            Ok(meta) if meta.len() > 0 => NativePermissionStatus {
                kind: "screenCapture".to_string(),
                status: "granted".to_string(),
                detail: Some("Screen capture command succeeded.".to_string()),
            },
            Ok(_) => NativePermissionStatus {
                kind: "screenCapture".to_string(),
                status: "unknown".to_string(),
                detail: Some("screencapture succeeded but returned an empty file.".to_string()),
            },
            Err(error) => NativePermissionStatus {
                kind: "screenCapture".to_string(),
                status: "denied".to_string(),
                detail: Some(format!("Screenshot file unavailable: {error}")),
            },
        },
        Ok(output) => NativePermissionStatus {
            kind: "screenCapture".to_string(),
            status: "denied".to_string(),
            detail: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        },
        Err(error) => NativePermissionStatus {
            kind: "screenCapture".to_string(),
            status: "denied".to_string(),
            detail: Some(format!("Failed to run screencapture: {error}")),
        },
    };

    let _ = fs::remove_file(&probe_path);
    result
}

#[cfg(not(target_os = "macos"))]
fn probe_screen_capture_permission() -> NativePermissionStatus {
    NativePermissionStatus {
        kind: "screenCapture".to_string(),
        status: "unsupported".to_string(),
        detail: Some("Screen capture probing is only implemented on macOS.".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn frontmost_app_triplet() -> Result<(String, Option<String>, Option<String>), String> {
    let script = r#"
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          set appName to name of frontApp
          set bundleId to bundle identifier of frontApp
          try
            set winTitle to name of front window of frontApp
          on error
            set winTitle to ""
          end try
          return appName & linefeed & bundleId & linefeed & winTitle
        end tell
    "#;

    let output = run_osascript(script)?;
    let mut lines = output.lines();
    let app_name = lines.next().unwrap_or("").trim().to_string();
    let bundle_id = trim_or_none(lines.next().unwrap_or(""));
    let remaining = lines.collect::<Vec<_>>().join("\n");
    let window_title = trim_or_none(&remaining);

    if app_name.is_empty() {
        return Err("Could not resolve frontmost application.".to_string());
    }

    Ok((app_name, bundle_id, window_title))
}

#[cfg(target_os = "macos")]
fn browser_context(app_name: &str) -> Result<(Option<String>, Option<String>), String> {
    let script = match app_name {
        "Safari" => Some(
            r#"
                tell application "Safari"
                  if (count of windows) is 0 then return ""
                  set pageUrl to URL of current tab of front window
                  set pageTitle to name of front document
                  return pageUrl & linefeed & pageTitle
                end tell
            "#,
        )
        .map(str::to_string),
        "Google Chrome" | "Chrome" | "Arc" | "Microsoft Edge" | "Chromium" | "Brave Browser" => Some(format!(
            r#"
                tell application "{}"
                  if (count of windows) is 0 then return ""
                  set pageUrl to URL of active tab of front window
                  set pageTitle to title of active tab of front window
                  return pageUrl & linefeed & pageTitle
                end tell
            "#,
            app_name
        )),
        _ => None,
    };

    let Some(script) = script else {
        return Ok((None, None));
    };

    let output = run_osascript(&script)?;
    if output.trim().is_empty() {
        return Ok((None, None));
    }

    let mut lines = output.lines();
    let url = trim_or_none(lines.next().unwrap_or(""));
    let remaining = lines.collect::<Vec<_>>().join("\n");
    let title = trim_or_none(&remaining);
    Ok((url, title))
}

#[cfg(not(target_os = "macos"))]
fn browser_context(_app_name: &str) -> Result<(Option<String>, Option<String>), String> {
    Ok((None, None))
}

#[derive(Default)]
struct SessionSnapshot {
    state: Option<String>,
    idle_seconds: Option<u64>,
}

#[derive(Default)]
struct PowerSnapshot {
    source: Option<String>,
    on_ac_power: Option<bool>,
    battery_percent: Option<u8>,
    battery_charging: Option<bool>,
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                result.push(value);
                index += 3;
                continue;
            }
        }

        result.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&result).to_string()
}

#[cfg(target_os = "macos")]
fn normalize_document_path(raw_value: &str) -> Option<String> {
    let trimmed = raw_value.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(path) = trimmed.strip_prefix("file://localhost") {
        return trim_or_none(&percent_decode(path));
    }

    if let Some(path) = trimmed.strip_prefix("file://") {
        return trim_or_none(&percent_decode(path));
    }

    if trimmed.starts_with('/') {
        return trim_or_none(trimmed);
    }

    None
}

#[cfg(target_os = "macos")]
fn frontmost_document_path() -> Result<Option<String>, String> {
    let script = r#"
        tell application "System Events"
          tell first application process whose frontmost is true
            try
              return value of attribute "AXDocument" of front window
            on error
              return ""
            end try
          end tell
        end tell
    "#;

    let output = run_osascript(script)?;
    Ok(normalize_document_path(&output))
}

#[cfg(not(target_os = "macos"))]
fn frontmost_document_path() -> Result<Option<String>, String> {
    Ok(None)
}

fn parse_bool_marker(haystack: &str, key: &str) -> Option<bool> {
    let yes = format!("\"{key}\"=Yes");
    if haystack.contains(&yes) {
        return Some(true);
    }

    let no = format!("\"{key}\"=No");
    if haystack.contains(&no) {
        return Some(false);
    }

    None
}

fn parse_numeric_value(haystack: &str, key: &str) -> Option<u64> {
    haystack
        .lines()
        .find(|line| line.contains(key))
        .and_then(|line| line.split('=').nth(1))
        .map(str::trim)
        .and_then(|value| {
            let cleaned = value
                .trim_matches('"')
                .trim_start_matches("0x");
            if value.trim_start().starts_with("0x") {
                u64::from_str_radix(cleaned, 16).ok()
            } else {
                cleaned.parse::<u64>().ok()
            }
        })
}

fn session_snapshot(app_name: &str) -> Result<SessionSnapshot, String> {
    let console_output = run_command("ioreg", &["-n", "Root", "-d1"])?;
    let idle_output = run_command("ioreg", &["-c", "IOHIDSystem"])?;

    let on_console = parse_bool_marker(&console_output, "kCGSSessionOnConsoleKey");
    let login_done = parse_bool_marker(&console_output, "kCGSessionLoginDoneKey");
    let idle_seconds = parse_numeric_value(&idle_output, "\"HIDIdleTime\"")
        .map(|value| value / 1_000_000_000);

    let mut state = if on_console == Some(false) || login_done == Some(false) {
        "locked".to_string()
    } else if idle_seconds.unwrap_or(0) >= 300 {
        "idle".to_string()
    } else {
        "active".to_string()
    };

    if app_name == "loginwindow" || app_name == "ScreenSaverEngine" {
        state = "locked".to_string();
    }

    Ok(SessionSnapshot {
        state: Some(state),
        idle_seconds,
    })
}

fn power_snapshot() -> Result<PowerSnapshot, String> {
    let output = run_command("pmset", &["-g", "batt"])?;
    let mut lines = output.lines();
    let power_line = lines.next().unwrap_or_default();
    let battery_line = lines.next().unwrap_or_default();

    let on_ac_power = if power_line.contains("AC Power") {
        Some(true)
    } else if power_line.contains("Battery Power") {
        Some(false)
    } else {
        None
    };

    let source = on_ac_power.map(|value| if value { "ac".to_string() } else { "battery".to_string() });
    let battery_percent = battery_line
        .split_whitespace()
        .find_map(|part| part.strip_suffix('%'))
        .and_then(|value| value.parse::<u8>().ok());
    let battery_charging = if battery_line.contains("charging") || battery_line.contains("charged") {
        Some(true)
    } else if battery_line.contains("discharging") {
        Some(false)
    } else {
        None
    };

    Ok(PowerSnapshot {
        source,
        on_ac_power,
        battery_percent,
        battery_charging,
    })
}

fn contains_ignore_case(value: &str, needle: &str) -> bool {
    value.to_ascii_lowercase().contains(&needle.to_ascii_lowercase())
}

fn is_sensitive_app(app_name: &str, bundle_id: Option<&str>) -> bool {
    let sensitive_apps = [
        "1Password",
        "Passwords",
        "Keychain Access",
        "Authy Desktop",
        "Bitwarden",
        "Dashlane",
        "LastPass",
        "Keeper Password Manager",
        "Proton Pass",
        "Secrets",
    ];
    if sensitive_apps.iter().any(|candidate| app_name.eq_ignore_ascii_case(candidate)) {
        return true;
    }

    if let Some(bundle_id) = bundle_id {
        let lowered = bundle_id.to_ascii_lowercase();
        return [
            "1password",
            "passwords",
            "keychain",
            "authy",
            "bitwarden",
            "dashlane",
            "lastpass",
            "keeper",
            "protonpass",
            "secrets",
        ]
        .iter()
        .any(|needle| lowered.contains(needle));
    }

    false
}

fn is_sensitive_window_title(title: Option<&str>) -> bool {
    let Some(title) = title else {
        return false;
    };

    [
        "password",
        "passkey",
        "one-time code",
        "verification code",
        "security code",
        "private key",
        "secret key",
        "recovery code",
        "two-factor",
        "otp",
        "2fa",
    ]
    .iter()
    .any(|needle| contains_ignore_case(title, needle))
}

fn is_sensitive_context(snapshot: &FrontmostContextSnapshot) -> bool {
    is_sensitive_app(&snapshot.app_name, snapshot.bundle_id.as_deref())
        || is_sensitive_window_title(snapshot.window_title.as_deref())
}

fn redact_sensitive_snapshot(snapshot: FrontmostContextSnapshot) -> FrontmostContextSnapshot {
    FrontmostContextSnapshot {
        window_title: Some("[redacted sensitive window]".to_string()),
        browser_url: None,
        browser_title: None,
        document_path: None,
        ..snapshot
    }
}

fn cleanup_path_if_older_than(path: &PathBuf, cutoff: SystemTime) -> Result<bool, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to stat {}: {error}", path.display()))?;
    let modified = metadata
        .modified()
        .map_err(|error| format!("Failed to read modified time for {}: {error}", path.display()))?;

    if modified >= cutoff {
        return Ok(false);
    }

    if metadata.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Failed to remove directory {}: {error}", path.display()))?;
    } else {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to remove file {}: {error}", path.display()))?;
    }

    Ok(true)
}

fn cleanup_native_desktop_storage(
    event_dir: &PathBuf,
    screenshot_dir: &PathBuf,
    sqlite_path: &PathBuf,
    retention_days: u64,
) -> Result<(), String> {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(retention_days.max(1).saturating_mul(86_400)))
        .unwrap_or(UNIX_EPOCH);
    let cutoff_ms = now_ms().saturating_sub((retention_days.max(1) as u128) * 86_400_000);

    let mut errors = Vec::new();

    if event_dir.exists() {
        match fs::read_dir(event_dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Err(error) = cleanup_path_if_older_than(&path, cutoff) {
                        errors.push(error);
                    }
                }
            }
            Err(error) => errors.push(format!("Failed to read event directory: {error}")),
        }
    }

    if screenshot_dir.exists() {
        match fs::read_dir(screenshot_dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Err(error) = cleanup_path_if_older_than(&path, cutoff) {
                        errors.push(error);
                    }
                }
            }
            Err(error) => errors.push(format!("Failed to read screenshot directory: {error}")),
        }
    }

    if sqlite_path.exists() {
        let sql = format!(
            "DELETE FROM desktop_activity_events WHERE captured_at_ms < {}; VACUUM;",
            cutoff_ms
        );
        if let Err(error) = run_sqlite(sqlite_path, &sql) {
            errors.push(format!("Failed to clean sqlite activity log: {error}"));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(" | "))
    }
}

fn capture_frontmost_context_snapshot() -> Result<FrontmostContextSnapshot, String> {
    let (app_name, bundle_id, window_title) = frontmost_app_triplet()?;
    let (browser_url, browser_title) = browser_context(&app_name).unwrap_or((None, None));
    let document_path = frontmost_document_path().ok().flatten();
    let session = session_snapshot(&app_name).unwrap_or_default();
    let power = power_snapshot().unwrap_or_default();

    Ok(FrontmostContextSnapshot {
        platform: env::consts::OS.to_string(),
        captured_at_ms: now_ms(),
        app_name,
        bundle_id,
        window_title,
        browser_url,
        browser_title,
        document_path,
        session_state: session.state,
        idle_seconds: session.idle_seconds,
        power_source: power.source,
        on_ac_power: power.on_ac_power,
        battery_percent: power.battery_percent,
        battery_charging: power.battery_charging,
    })
}

fn fingerprint_for_context(snapshot: &FrontmostContextSnapshot) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        snapshot.app_name,
        snapshot.bundle_id.clone().unwrap_or_default(),
        snapshot.window_title.clone().unwrap_or_default(),
        snapshot.browser_url.clone().unwrap_or_default(),
        snapshot.document_path.clone().unwrap_or_default(),
        snapshot.session_state.clone().unwrap_or_default(),
        snapshot.power_source.clone().unwrap_or_default(),
        snapshot.battery_percent.map(|value| value.to_string()).unwrap_or_default(),
    )
}

fn capture_screenshot_to_path(output_path: &PathBuf, silent: bool) -> Result<ScreenshotCaptureResult, String> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create screenshot directory: {error}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("screencapture");
        if silent {
            command.arg("-x");
        }
        command.args(["-t", "png"]).arg(output_path);

        let output = command
            .output()
            .map_err(|error| format!("Failed to run screencapture: {error}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = output_path;
        let _ = silent;
        return Err("Native screenshot capture is only implemented on macOS.".to_string());
    }

    let metadata = fs::metadata(output_path)
        .map_err(|error| format!("Screenshot was not written: {error}"))?;

    Ok(ScreenshotCaptureResult {
        path: path_to_string(output_path),
        bytes: metadata.len(),
        captured_at_ms: now_ms(),
    })
}

fn build_activity_event(
    snapshot: FrontmostContextSnapshot,
    fingerprint: String,
    screenshot_path: Option<String>,
) -> DesktopActivityEvent {
    DesktopActivityEvent {
        id: format!("evt-{}", snapshot.captured_at_ms),
        captured_at_ms: snapshot.captured_at_ms,
        app_name: snapshot.app_name,
        bundle_id: snapshot.bundle_id,
        window_title: snapshot.window_title,
        browser_url: snapshot.browser_url,
        browser_title: snapshot.browser_title,
        document_path: snapshot.document_path,
        session_state: snapshot.session_state,
        idle_seconds: snapshot.idle_seconds,
        power_source: snapshot.power_source,
        on_ac_power: snapshot.on_ac_power,
        battery_percent: snapshot.battery_percent,
        battery_charging: snapshot.battery_charging,
        screenshot_path,
        fingerprint,
    }
}

fn persist_activity_event(file_path: &PathBuf, event: &DesktopActivityEvent) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file_path)
        .map_err(|error| format!("Failed to open event log: {error}"))?;
    let payload = serde_json::to_string(event).map_err(|error| format!("Failed to serialize event: {error}"))?;
    writeln!(file, "{payload}").map_err(|error| format!("Failed to write event: {error}"))?;
    Ok(())
}

fn sql_escape(value: &str) -> String {
    value.replace('\'', "''")
}

fn sql_text(value: &str) -> String {
    format!("'{}'", sql_escape(value))
}

fn sql_text_opt(value: &Option<String>) -> String {
    value
        .as_ref()
        .map(|item| sql_text(item))
        .unwrap_or_else(|| "NULL".to_string())
}

fn sql_u64_opt(value: Option<u64>) -> String {
    value
        .map(|item| item.to_string())
        .unwrap_or_else(|| "NULL".to_string())
}

fn sql_u8_opt(value: Option<u8>) -> String {
    value
        .map(|item| item.to_string())
        .unwrap_or_else(|| "NULL".to_string())
}

fn sql_bool_opt(value: Option<bool>) -> String {
    value
        .map(|item| if item { "1".to_string() } else { "0".to_string() })
        .unwrap_or_else(|| "NULL".to_string())
}

fn run_sqlite(sqlite_path: &PathBuf, sql: &str) -> Result<(), String> {
    let output = Command::new("sqlite3")
        .arg(sqlite_path)
        .arg(sql)
        .output()
        .map_err(|error| format!("Failed to run sqlite3: {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(if detail.is_empty() {
            format!("sqlite3 exited with status {}", output.status)
        } else {
            detail
        })
    }
}

fn ensure_sqlite_schema(sqlite_path: &PathBuf) -> Result<(), String> {
    let sql = r#"
CREATE TABLE IF NOT EXISTS desktop_activity_events (
  id TEXT PRIMARY KEY,
  captured_at_ms INTEGER NOT NULL,
  app_name TEXT NOT NULL,
  bundle_id TEXT,
  window_title TEXT,
  browser_url TEXT,
  browser_title TEXT,
  document_path TEXT,
  session_state TEXT,
  idle_seconds INTEGER,
  power_source TEXT,
  on_ac_power INTEGER,
  battery_percent INTEGER,
  battery_charging INTEGER,
  screenshot_path TEXT,
  fingerprint TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desktop_activity_events_captured_at_ms ON desktop_activity_events (captured_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_desktop_activity_events_app_name ON desktop_activity_events (app_name);
CREATE INDEX IF NOT EXISTS idx_desktop_activity_events_browser_url ON desktop_activity_events (browser_url);
"#;

    run_sqlite(sqlite_path, sql)
}

fn persist_activity_event_sqlite(sqlite_path: &PathBuf, event: &DesktopActivityEvent) -> Result<(), String> {
    let raw_json = serde_json::to_string(event).map_err(|error| format!("Failed to serialize event JSON: {error}"))?;
    let sql = format!(
        "INSERT OR REPLACE INTO desktop_activity_events (id, captured_at_ms, app_name, bundle_id, window_title, browser_url, browser_title, document_path, session_state, idle_seconds, power_source, on_ac_power, battery_percent, battery_charging, screenshot_path, fingerprint, raw_json) VALUES ({id}, {captured_at_ms}, {app_name}, {bundle_id}, {window_title}, {browser_url}, {browser_title}, {document_path}, {session_state}, {idle_seconds}, {power_source}, {on_ac_power}, {battery_percent}, {battery_charging}, {screenshot_path}, {fingerprint}, {raw_json});",
        id = sql_text(&event.id),
        captured_at_ms = event.captured_at_ms,
        app_name = sql_text(&event.app_name),
        bundle_id = sql_text_opt(&event.bundle_id),
        window_title = sql_text_opt(&event.window_title),
        browser_url = sql_text_opt(&event.browser_url),
        browser_title = sql_text_opt(&event.browser_title),
        document_path = sql_text_opt(&event.document_path),
        session_state = sql_text_opt(&event.session_state),
        idle_seconds = sql_u64_opt(event.idle_seconds),
        power_source = sql_text_opt(&event.power_source),
        on_ac_power = sql_bool_opt(event.on_ac_power),
        battery_percent = sql_u8_opt(event.battery_percent),
        battery_charging = sql_bool_opt(event.battery_charging),
        screenshot_path = sql_text_opt(&event.screenshot_path),
        fingerprint = sql_text(&event.fingerprint),
        raw_json = sql_text(&raw_json),
    );

    run_sqlite(sqlite_path, &sql)
}

fn normalize_collector_request(request: CollectorStartRequest) -> CollectorStartRequest {
    CollectorStartRequest {
        interval_secs: Some(request.interval_secs.unwrap_or(30).clamp(5, 3600)),
        capture_screenshots: Some(request.capture_screenshots.unwrap_or(true)),
        redact_sensitive_contexts: Some(request.redact_sensitive_contexts.unwrap_or(true)),
        retention_days: Some(request.retention_days.unwrap_or(7).clamp(1, 90)),
        dedupe_window_secs: Some(request.dedupe_window_secs.unwrap_or(60).clamp(5, 3600)),
        max_recent_events: Some(request.max_recent_events.unwrap_or(20).clamp(5, 100)),
    }
}

fn sleep_with_stop(stop_flag: &Arc<AtomicBool>, seconds: u64) {
    for _ in 0..seconds {
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn read_recent_events_from_disk(event_dir: &PathBuf, limit: usize) -> Result<Vec<DesktopActivityEvent>, String> {
    if !event_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files = fs::read_dir(event_dir)
        .map_err(|error| format!("Failed to read event directory: {error}"))?
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .collect::<Vec<_>>();
    files.sort();
    files.reverse();

    let mut events = Vec::new();
    for file in files {
        if events.len() >= limit {
            break;
        }
        let content = fs::read_to_string(&file)
            .map_err(|error| format!("Failed to read event log {}: {error}", file.display()))?;
        for line in content.lines().rev() {
            if events.len() >= limit {
                break;
            }
            if let Ok(event) = serde_json::from_str::<DesktopActivityEvent>(line) {
                events.push(event);
            }
        }
    }

    Ok(events)
}

fn read_recent_events_from_sqlite(
    sqlite_path: &PathBuf,
    limit: usize,
) -> Result<Vec<DesktopActivityEvent>, String> {
    if !sqlite_path.exists() {
        return Ok(Vec::new());
    }

    let sql = format!(
        "SELECT raw_json FROM desktop_activity_events ORDER BY captured_at_ms DESC LIMIT {};",
        limit.clamp(1, 100)
    );
    let output = Command::new("sqlite3")
        .arg("-json")
        .arg(sqlite_path)
        .arg(sql)
        .output()
        .map_err(|error| format!("Failed to read sqlite activity log: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            format!("sqlite3 exited with status {}", output.status)
        } else {
            detail
        });
    }

    let payload = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if payload.is_empty() {
        return Ok(Vec::new());
    }

    let rows = serde_json::from_str::<Vec<serde_json::Value>>(&payload)
        .map_err(|error| format!("Failed to parse sqlite activity rows: {error}"))?;

    let mut events = Vec::new();
    for row in rows {
        let Some(raw_json) = row.get("raw_json").and_then(|value| value.as_str()) else {
            continue;
        };

        if let Ok(event) = serde_json::from_str::<DesktopActivityEvent>(raw_json) {
            events.push(event);
        }
    }

    Ok(events)
}

#[tauri::command]
pub fn desktop_get_capabilities() -> Result<NativeDesktopCapabilities, String> {
    let platform = env::consts::OS.to_string();
    let is_macos = cfg!(target_os = "macos");

    Ok(NativeDesktopCapabilities {
        platform,
        supports_screen_capture: is_macos,
        supports_permission_checks: is_macos,
        supports_frontmost_context: is_macos,
        supports_browser_context: is_macos,
        supports_system_settings_links: is_macos,
        supports_background_collection: is_macos,
        phase: "p1_background_collector".to_string(),
    })
}

#[tauri::command]
pub fn desktop_get_permission_status() -> Result<NativePermissionSnapshot, String> {
    Ok(NativePermissionSnapshot {
        platform: env::consts::OS.to_string(),
        checked_at_ms: now_ms(),
        permissions: vec![probe_screen_capture_permission(), probe_accessibility_permission()],
    })
}

#[tauri::command]
pub fn desktop_get_frontmost_context() -> Result<FrontmostContextSnapshot, String> {
    capture_frontmost_context_snapshot()
}

#[tauri::command]
pub fn desktop_capture_screenshot(
    app: tauri::AppHandle,
    request: Option<ScreenshotCaptureRequest>,
) -> Result<ScreenshotCaptureResult, String> {
    let request = request.unwrap_or_default();
    let output_path = match request.output_path {
        Some(path) => PathBuf::from(path),
        None => default_screenshot_path(&app)?,
    };

    capture_screenshot_to_path(&output_path, request.silent.unwrap_or(true))
}

#[tauri::command]
pub fn desktop_get_collector_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeDesktopState>,
) -> Result<NativeDesktopCollectorStatus, String> {
    let mut status = state.status()?;
    if status.event_dir.is_none() {
        status.event_dir = Some(path_to_string(&native_events_dir(&app)?));
    }
    if status.screenshot_dir.is_none() {
        status.screenshot_dir = Some(path_to_string(&native_screenshot_dir(&app)?));
    }
    if status.sqlite_db_path.is_none() {
        status.sqlite_db_path = Some(path_to_string(&native_sqlite_path(&app)?));
    }
    Ok(status)
}

#[tauri::command]
pub fn desktop_start_collector(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeDesktopState>,
    request: Option<CollectorStartRequest>,
) -> Result<NativeDesktopCollectorStatus, String> {
    state.stop_collector()?;

    let request = normalize_collector_request(request.unwrap_or_default());
    let interval_secs = request.interval_secs.unwrap_or(30);
    let capture_screenshots = request.capture_screenshots.unwrap_or(true);
    let redact_sensitive_contexts = request.redact_sensitive_contexts.unwrap_or(true);
    let retention_days = request.retention_days.unwrap_or(7);
    let dedupe_window_secs = request.dedupe_window_secs.unwrap_or(60);
    let max_recent_events = request.max_recent_events.unwrap_or(20);
    let event_dir = native_events_dir(&app)?;
    let screenshot_dir = native_screenshot_dir(&app)?;
    let native_root = native_desktop_root(&app)?;
    let sqlite_db_path = native_sqlite_path(&app)?;
    let events_file = collector_event_file_for_date(&event_dir)?;
    let _ = ensure_sqlite_schema(&sqlite_db_path);

    {
        let mut shared = state.shared.lock().map_err(|_| "Collector shared state poisoned".to_string())?;
        shared.status = NativeDesktopCollectorStatus {
            running: true,
            phase: "p1_background_collector".to_string(),
            interval_secs,
            capture_screenshots,
            redact_sensitive_contexts,
            retention_days,
            dedupe_window_secs,
            max_recent_events,
            last_event_at_ms: shared.status.last_event_at_ms,
            last_cleanup_at_ms: shared.status.last_cleanup_at_ms,
            last_error: None,
            last_fingerprint: shared.status.last_fingerprint.clone(),
            total_events_written: shared.status.total_events_written,
            event_dir: Some(path_to_string(&event_dir)),
            screenshot_dir: Some(path_to_string(&screenshot_dir)),
            events_file: Some(path_to_string(&events_file)),
            sqlite_db_path: Some(path_to_string(&sqlite_db_path)),
        };
        shared.recent_events.truncate(max_recent_events);
        let _ = persist_collector_status(&native_root, &shared.status);
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_thread = stop_flag.clone();
    let shared = state.shared.clone();
    let native_root_for_thread = native_root.clone();
    let event_dir_for_thread = event_dir.clone();
    let screenshot_dir_for_thread = screenshot_dir.clone();
    let sqlite_db_path_for_thread = sqlite_db_path.clone();

    let handle = thread::spawn(move || {
        if let Err(error) = ensure_sqlite_schema(&sqlite_db_path_for_thread) {
            if let Ok(mut shared) = shared.lock() {
                shared.status.last_error = Some(error);
                let _ = persist_collector_status(&native_root_for_thread, &shared.status);
            }
        }

        while !stop_flag_for_thread.load(Ordering::SeqCst) {
            let should_cleanup = {
                if let Ok(shared) = shared.lock() {
                    shared
                        .status
                        .last_cleanup_at_ms
                        .map(|previous| now_ms().saturating_sub(previous) >= 3_600_000)
                        .unwrap_or(true)
                } else {
                    false
                }
            };

            if should_cleanup {
                let cleanup_result = cleanup_native_desktop_storage(
                    &event_dir_for_thread,
                    &screenshot_dir_for_thread,
                    &sqlite_db_path_for_thread,
                    retention_days,
                );
                if let Ok(mut shared) = shared.lock() {
                    shared.status.last_cleanup_at_ms = Some(now_ms());
                    if let Err(error) = cleanup_result {
                        shared.status.last_error = Some(error);
                    }
                    let _ = persist_collector_status(&native_root_for_thread, &shared.status);
                }
            }

            let snapshot = match capture_frontmost_context_snapshot() {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    if let Ok(mut shared) = shared.lock() {
                        shared.status.last_error = Some(error);
                        let _ = persist_collector_status(&native_root_for_thread, &shared.status);
                    }
                    sleep_with_stop(&stop_flag_for_thread, interval_secs);
                    continue;
                }
            };

            let is_sensitive = redact_sensitive_contexts && is_sensitive_context(&snapshot);
            let snapshot = if is_sensitive {
                redact_sensitive_snapshot(snapshot)
            } else {
                snapshot
            };

            let fingerprint = fingerprint_for_context(&snapshot);
            let should_persist = {
                if let Ok(shared) = shared.lock() {
                    let changed = shared
                        .status
                        .last_fingerprint
                        .as_ref()
                        .map(|previous| previous != &fingerprint)
                        .unwrap_or(true);
                    let aged_out = shared
                        .status
                        .last_event_at_ms
                        .map(|previous| snapshot.captured_at_ms.saturating_sub(previous) >= (dedupe_window_secs as u128 * 1000))
                        .unwrap_or(true);
                    changed || aged_out
                } else {
                    true
                }
            };

            if should_persist {
                let screenshot_path = if capture_screenshots && !is_sensitive {
                    match collector_screenshot_path(&screenshot_dir_for_thread)
                        .and_then(|path| capture_screenshot_to_path(&path, true))
                    {
                        Ok(result) => Some(result.path),
                        Err(error) => {
                            if let Ok(mut shared) = shared.lock() {
                                shared.status.last_error = Some(error);
                                let _ = persist_collector_status(&native_root_for_thread, &shared.status);
                            }
                            None
                        }
                    }
                } else {
                    None
                };

                let event = build_activity_event(snapshot.clone(), fingerprint.clone(), screenshot_path);
                let events_file = match collector_event_file_for_date(&event_dir_for_thread) {
                    Ok(file) => file,
                    Err(error) => {
                        if let Ok(mut shared) = shared.lock() {
                            shared.status.last_error = Some(error);
                            let _ = persist_collector_status(&native_root_for_thread, &shared.status);
                        }
                        sleep_with_stop(&stop_flag_for_thread, interval_secs);
                        continue;
                    }
                };

                match persist_activity_event(&events_file, &event) {
                    Ok(()) => {
                        let sqlite_error = persist_activity_event_sqlite(&sqlite_db_path_for_thread, &event).err();
                        if let Ok(mut shared) = shared.lock() {
                            shared.status.last_event_at_ms = Some(event.captured_at_ms);
                            shared.status.last_error = sqlite_error;
                            shared.status.last_fingerprint = Some(event.fingerprint.clone());
                            shared.status.total_events_written += 1;
                            shared.status.events_file = Some(path_to_string(&events_file));
                            shared.recent_events.push_front(event);
                            while shared.recent_events.len() > max_recent_events {
                                shared.recent_events.pop_back();
                            }
                            let _ = persist_collector_status(&native_root_for_thread, &shared.status);
                        }
                    }
                    Err(error) => {
                        if let Ok(mut shared) = shared.lock() {
                            shared.status.last_error = Some(error);
                            let _ = persist_collector_status(&native_root_for_thread, &shared.status);
                        }
                    }
                }
            }

            sleep_with_stop(&stop_flag_for_thread, interval_secs);
        }

        if let Ok(mut shared) = shared.lock() {
            shared.status.running = false;
            let _ = persist_collector_status(&native_root_for_thread, &shared.status);
        }
    });

    {
        let mut guard = state.collector.lock().map_err(|_| "Collector mutex poisoned".to_string())?;
        *guard = Some(CollectorRuntime { stop_flag, handle });
    }

    state.status()
}

#[tauri::command]
pub fn desktop_stop_collector(
    state: tauri::State<'_, NativeDesktopState>,
) -> Result<NativeDesktopCollectorStatus, String> {
    state.stop_collector()?;
    state.status()
}

#[tauri::command]
pub fn desktop_list_recent_events(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeDesktopState>,
    limit: Option<usize>,
) -> Result<Vec<DesktopActivityEvent>, String> {
    let limit = limit.unwrap_or(10).clamp(1, 100);
    let in_memory = state.recent_events(limit)?;
    if !in_memory.is_empty() {
        return Ok(in_memory);
    }
    let sqlite_events = read_recent_events_from_sqlite(&native_sqlite_path(&app)?, limit)?;
    if !sqlite_events.is_empty() {
        return Ok(sqlite_events);
    }
    read_recent_events_from_disk(&native_events_dir(&app)?, limit)
}

#[tauri::command]
pub fn desktop_open_system_settings(request: OpenSystemSettingsRequest) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let url = match request.kind.as_str() {
            "screenCapture" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            other => return Err(format!("Unsupported settings pane: {other}")),
        };

        let output = Command::new("open")
            .arg(url)
            .output()
            .map_err(|error| format!("Failed to open system settings: {error}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        Ok(true)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Err("System settings deep links are only implemented on macOS.".to_string())
    }
}
