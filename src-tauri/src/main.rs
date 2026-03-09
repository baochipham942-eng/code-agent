use reqwest::blocking::Client;
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

fn spawn_web_server(app: &tauri::AppHandle) -> Result<Child, String> {
    let (script_path, working_dir) = resolve_server_script(app)?;
    let node_binary = env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string());

    Command::new(node_binary)
        .arg(&script_path)
        .current_dir(&working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("Failed to start web server at {}: {}", script_path.display(), error))
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

fn main() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
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
