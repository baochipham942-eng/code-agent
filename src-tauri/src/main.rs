use reqwest::blocking::Client;
use serde::Serialize;
use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent};

mod native_desktop;

use native_desktop::{
    desktop_capture_screenshot, desktop_get_capabilities, desktop_get_collector_status,
    desktop_get_frontmost_context, desktop_get_permission_status, desktop_list_recent_events,
    desktop_open_system_settings, desktop_start_collector, desktop_stop_collector,
    desktop_update_analyze_text,
    NativeDesktopState,
};

const SERVER_URL: &str = "http://localhost:8080";
const HEALTH_URL: &str = "http://localhost:8080/api/health";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);

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
    let mut roots = Vec::new();

    // In dev mode, CARGO_MANIFEST_DIR points to src-tauri/; its parent is the project root
    // where dist/web/webServer.cjs lives. This is the highest-priority candidate for dev.
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(project_root) = manifest_dir.parent() {
        roots.push(project_root.to_path_buf());
    }
    roots.push(manifest_dir.to_path_buf());

    if let Ok(cwd) = env::current_dir() {
        roots.push(cwd);
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.clone());

        if let Some(parent) = resource_dir.parent() {
            roots.push(parent.to_path_buf());
        }
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            roots.push(exe_dir.to_path_buf());

            if let Some(parent) = exe_dir.parent() {
                roots.push(parent.to_path_buf());

                if let Some(grandparent) = parent.parent() {
                    roots.push(grandparent.to_path_buf());
                }
            }
        }
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

fn is_server_running() -> bool {
    let client = match Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    matches!(client.get(HEALTH_URL).send(), Ok(resp) if resp.status().as_u16() == 200)
}

fn resolve_node_binary() -> String {
    if let Ok(bin) = env::var("NODE_BINARY") {
        return bin;
    }

    // macOS GUI apps launched from Finder have a minimal PATH that excludes
    // common Node.js installation directories. Search them explicitly.
    let candidates = [
        "/usr/local/bin/node",      // Homebrew (Intel Mac)
        "/opt/homebrew/bin/node",    // Homebrew (Apple Silicon)
    ];

    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return candidate.to_string();
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
                    return bin.to_string_lossy().to_string();
                }
            }
        }
    }

    "node".to_string()
}

fn spawn_web_server(app: &tauri::AppHandle) -> Result<Child, String> {
    let (script_path, working_dir) = resolve_server_script(app)?;
    let node_binary = resolve_node_binary();

    Command::new(&node_binary)
        .arg(&script_path)
        .current_dir(&working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| {
            format!(
                "Failed to start web server at {} (node: {}): {}",
                script_path.display(),
                node_binary,
                error
            )
        })
}

fn wait_for_healthcheck() -> Result<(), String> {
    let handle = thread::spawn(|| -> Result<(), String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|error| format!("Failed to build HTTP client: {error}"))?;

        let deadline = Instant::now() + HEALTH_TIMEOUT;

        while Instant::now() < deadline {
            match client.get(HEALTH_URL).send() {
                Ok(response) if response.status().as_u16() == 200 => return Ok(()),
                Ok(_) | Err(_) => thread::sleep(HEALTH_INTERVAL),
            }
        }

        Err(format!(
            "Timed out after {}s waiting for {}",
            HEALTH_TIMEOUT.as_secs(),
            HEALTH_URL
        ))
    });

    handle
        .join()
        .map_err(|_| "Healthcheck thread panicked".to_string())?
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
}

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<TauriUpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;

    let current_version = app.config().version.clone().unwrap_or_default();

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
        }),
        None => Ok(TauriUpdateInfo {
            has_update: false,
            current_version,
            latest_version: None,
            release_notes: None,
            date: None,
        }),
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

    if let Some(update) = update {
        let mut started = false;
        update
            .download_and_install(
                |chunk_length, content_length| {
                    if !started {
                        started = true;
                        println!("Update download started, total size: {:?}", content_length);
                    }
                    println!("Downloaded {} bytes", chunk_length);
                },
                || {
                    println!("Download finished, installing update...");
                },
            )
            .await
            .map_err(|e| format!("Failed to install update: {e}"))?;

        // Restart the app after update
        app.restart();
    } else {
        return Err("No update available".to_string());
    }

    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .manage(NativeDesktopState::default())
        .invoke_handler(tauri::generate_handler![
            check_for_update,
            install_update,
            desktop_get_capabilities,
            desktop_get_permission_status,
            desktop_get_frontmost_context,
            desktop_capture_screenshot,
            desktop_get_collector_status,
            desktop_start_collector,
            desktop_stop_collector,
            desktop_list_recent_events,
            desktop_open_system_settings,
            desktop_update_analyze_text
        ])
        .setup(|app| {
            if is_server_running() {
                // Server already running (e.g. started by Tauri beforeDevCommand in dev mode)
                println!("Web server already running on {SERVER_URL}, skipping spawn");
            } else {
                let child = spawn_web_server(&app.handle())?;
                app.state::<AppState>().store_child(child);

                if let Err(error) = wait_for_healthcheck() {
                    cleanup_server(&app.handle());
                    return Err(error.into());
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(&format!("window.location.replace('{SERVER_URL}')"));
                let _ = window.show();
                let _ = window.set_focus();
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application");

    install_signal_handler(app.handle());

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            cleanup_server(app_handle);
        }
        _ => {}
    });
}
