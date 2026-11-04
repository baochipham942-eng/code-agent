// ============================================================================
// WebServer Exit — webServer 子进程「为什么死了」的壳侧取证
// (N-WEBSERVER-DEATH-SUPERVISE-DIAG)
// ============================================================================
// Batch-24 dogfood 三次 webServer 消失（03:05-03:11）无 crash report、无系统 kill
// 记录，node 进程走的是正常退出路径且与最后一个 200 同秒——盘上没有任何东西能
// 说明为什么：壳从不 inspect 启动后的子进程（`try_wait` 只在 healthcheck 与编译
// 缓存预热里调用），子进程自己的 "Shutting down..." 只进 console，而 stdout/stderr
// 在 launchd 下直接丢失。本模块补三块取证，让下一次死亡「归因可判定」：
//
//   1. `describe_exit` / `classify_exit`：真实 `ExitStatus` → 退出码 / 信号 /
//      归因（killed-by-signal / exited-nonzero / exited-zero-unrequested）；
//      端口是否易主（`port_holders_excluding_dead`）是与归因解耦的独立事实，
//      任意组合（被信号杀 + 端口易主 / 退出 0 + 端口易主）都可能。
//   2. 每个「被壳 spawn 并收管」的子进程一个 watcher 线程：每秒在
//      `AppState.web_server` 锁内轮询 `try_wait`；子进程死在槽里（cleanup 没有
//      接手）时 TAKE 出槽（只报一次、`cleanup()` 不再碰它）并落
//      `desktop-shell-webserver-exited-unexpectedly`（error 级）事件。故意停机
//      走 `cleanup()` 自己的 `desktop-shell-process-cleanup` 事件，两类互斥。
//      这里**不做**自动重启（那是 N-WEBSERVER-DEATH-SUPERVISE-RESTART 票）。
//   3. stdio 落盘：`open_stdio_log`（spawn 前 5MiB 轮转 `.1`，追加模式），
//      `tail_stdio_log`（取最后 ~4KB 进事件）。打开失败由调用方回退 inherit
//      并落 warning——不许静默降级。
// ============================================================================

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::Manager;

/// watcher 轮询间隔（任务书口径：约每秒一次）。
pub const WATCHER_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// stdio 日志轮转阈值：spawn 时超过 5MiB 先轮转成 `.1`。
pub const STDIO_LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// 事件里带的 stdio 尾巴长度（约 4KB）。
pub const STDIO_TAIL_BYTES: u64 = 4096;
/// stdio 日志文件名（`<web_server_log_dir>/webserver-stdio.log`）。
pub const WEBSERVER_STDIO_LOG_FILE: &str = "webserver-stdio.log";
/// 轮转后的上一代日志（只保留最近一代，取证用途足够）。
pub const WEBSERVER_STDIO_LOG_ROTATED_FILE: &str = "webserver-stdio.log.1";
/// 子进程死在槽里（非 cleanup 接手）时落的 shell 事件名。
pub const UNEXPECTED_EXIT_EVENT: &str = "desktop-shell-webserver-exited-unexpectedly";

pub const CAUSE_KILLED_BY_SIGNAL: &str = "killed-by-signal";
pub const CAUSE_EXITED_NONZERO: &str = "exited-nonzero";
pub const CAUSE_EXITED_ZERO_UNREQUESTED: &str = "exited-zero-unrequested";

/// `describe_exit` 的结果：退出码与信号互斥（unix 上被信号杀的进程 `code()`
/// 返回 None；windows 只有退出码概念）。
pub struct ExitDescription {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub signal_name: Option<String>,
}

/// 把真实 `ExitStatus` 拆成退出码 / 信号 / 信号名。unix 走
/// `ExitStatusExt::signal()`，windows 只有 code（`signal`/`signal_name` 恒 None）。
pub fn describe_exit(status: &ExitStatus) -> ExitDescription {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return ExitDescription {
                exit_code: None,
                signal: Some(signal),
                signal_name: Some(signal_name(signal)),
            };
        }
    }
    ExitDescription {
        exit_code: status.code(),
        signal: None,
        signal_name: None,
    }
}

/// 归因：信号杀 / 非零退出 / 未经请求的 0 退出。调用前提是 watcher 已经确认
/// 这次死亡不是 cleanup 主动发起的（槽还在我们手里），所以 0 退出只能是
/// 「自己正常退出路径走了」——batch-24 案发现场的那一类。
pub fn classify_exit(status: &ExitStatus) -> &'static str {
    let described = describe_exit(status);
    if described.signal.is_some() {
        CAUSE_KILLED_BY_SIGNAL
    } else if described.exit_code.unwrap_or(0) != 0 {
        CAUSE_EXITED_NONZERO
    } else {
        CAUSE_EXITED_ZERO_UNREQUESTED
    }
}

/// POSIX.1-1990 标准信号在 Linux/macOS/BSD 上编号一致，这些给真名；其余
/// （实时信号、平台私有信号）编号跨平台不一致，老实回退成 `signal-N`，
/// 数字本身已在 `signal` 字段里。
pub fn signal_name(signal: i32) -> String {
    let stable = match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => "",
    };
    if stable.is_empty() {
        format!("signal-{signal}")
    } else {
        stable.to_string()
    }
}

/// 端口易主占用者 = 死掉的 webServer 之外还有谁占着 `web_port()`。
/// 死进程自己不会再出现在 lsof/netstat 结果里，但按 pid 过滤一次做保险——
/// 这个事实与 `classify_exit` 的归因完全解耦，单独成一个布尔。
pub fn port_holders_excluding_dead(holders: &[u32], dead_pid: u32) -> Vec<u32> {
    holders
        .iter()
        .copied()
        .filter(|pid| *pid != dead_pid)
        .collect()
}

/// watcher 轮询到点时的判定：只有槽位仍握着**同一个** pid 才有权报告。
/// - 槽空：`cleanup()` 已 take——故意停机，绝不报 unexpected（否则正常退出
///   每次都会多出一条假警报，取证档反被噪音淹死）；
/// - 槽里换了新 pid：window-recreate 已重新 spawn，旧 watcher 让位。
///
/// 抽成纯函数便于单测（线程路径难以直测）。
pub fn watcher_should_report(slot_pid: Option<u32>, watched_pid: u32) -> bool {
    slot_pid == Some(watched_pid)
}

/// `started_at`（毫秒字符串）到现在的 uptime，毫秒。解析失败按 0 处理。
pub fn uptime_ms_since(started_at_ms: &str) -> u128 {
    let started = started_at_ms.parse::<u128>().unwrap_or(0);
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
        .saturating_sub(started)
}

/// spawn 前打开 stdio 日志：超过 5MiB 先轮转成 `.1`，再以追加模式打开。
/// stdout/stderr 共用一个句柄（调用方 try_clone）；O_APPEND 保证两边交错写
/// 不会互相覆盖。返回 Err = 调用方回退 `Stdio::inherit()` 并落 warning 事件。
pub fn open_stdio_log(log_dir: &Path) -> std::io::Result<fs::File> {
    fs::create_dir_all(log_dir)?;
    let path = log_dir.join(WEBSERVER_STDIO_LOG_FILE);
    if let Ok(metadata) = fs::metadata(&path) {
        if metadata.len() > STDIO_LOG_ROTATE_BYTES {
            let rotated = log_dir.join(WEBSERVER_STDIO_LOG_ROTATED_FILE);
            // 已有 .1 直接覆盖：只留最近一代历史，当前代永远在主文件里
            let _ = fs::remove_file(&rotated);
            fs::rename(&path, &rotated)?;
        }
    }
    fs::OpenOptions::new().create(true).append(true).open(&path)
}

/// stdio 日志的最后 ~4KB（事件附件用）。文件不存在 / 读不了返回 None——
/// stdio 本来就可能回退到 inherit，取证缺一角不挡事件本身。
pub fn tail_stdio_log(log_dir: &Path) -> Option<String> {
    let path = log_dir.join(WEBSERVER_STDIO_LOG_FILE);
    let mut file = fs::File::open(&path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(STDIO_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buffer = vec![0u8; (len - start) as usize];
    file.read_exact(&mut buffer).ok()?;
    // 边界可能劈开半个多字节字符，lossy 收尾可接受：这是取证尾巴不是协议
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

/// 一次性健康探针结果：子进程死后 server 还应不应答。
/// `http-200` = 端口上有活人答话（多半是易主的新占用者）；
/// `unreachable: …` = 没人应答（webServer 真死了）。字符串进事件，可读优先。
pub fn probe_health(health_url: &str) -> String {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build();
    match client {
        Ok(client) => match client.get(health_url).send() {
            Ok(response) => format!("http-{}", response.status().as_u16()),
            Err(error) => format!("unreachable: {error}"),
        },
        Err(error) => format!("client-build-failed: {error}"),
    }
}

/// `desktop-shell-webserver-exited-unexpectedly` 事件的全部事实。
/// 纯数据 + 纯构造，事件 JSON 每个字段都能单测钉住（acceptance ③）。
pub struct UnexpectedExitFacts {
    pub app_version: Option<String>,
    pub bundle_id: Option<String>,
    pub web_port: u16,
    pub shell_pid: u32,
    pub pid: u32,
    pub started_at: String,
    pub uptime_ms: u128,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub signal_name: Option<String>,
    pub cause: &'static str,
    pub port_held_by_other: bool,
    pub port_holder_pids: Vec<u32>,
    pub health_probe: String,
    pub stdio_tail: Option<String>,
}

pub fn unexpected_exit_event_payload(facts: &UnexpectedExitFacts) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "source": "tauri-shell",
        "generatedAt": crate::now_millis_string(),
        "level": "error",
        "event": UNEXPECTED_EXIT_EVENT,
        "appVersion": facts.app_version,
        "bundleId": facts.bundle_id,
        "channel": crate::desktop_shell_channel(facts.bundle_id.as_deref(), cfg!(debug_assertions)),
        "pid": facts.shell_pid,
        "webPort": facts.web_port,
        "message": "webServer child exited while still owned by the shell (not an intentional cleanup)",
        "process": {
            "owner": "tauri-shell",
            "role": "webServer",
            "pid": facts.pid,
            "startedAt": facts.started_at,
            "uptimeMs": facts.uptime_ms,
            "exitCode": facts.exit_code,
            "signal": facts.signal,
            "signalName": facts.signal_name,
            "cause": facts.cause,
            "portHeldByOther": facts.port_held_by_other,
            "portHolderPids": facts.port_holder_pids,
            "healthProbe": facts.health_probe,
            "stdioTail": facts.stdio_tail,
        }
    })
}

/// watcher 单步的结局。
#[derive(Debug)]
pub enum WatchTick {
    /// 子进程还活着（或 try_wait 偶发失败）——继续轮询。
    StillRunning,
    /// 槽空（cleanup() 已 take，故意停机）或已换新 pid（window-recreate 重启）
    /// ——停止监视，**绝不**落 unexpected 事件。
    SlotGone,
    /// 子进程死在槽里（cleanup 没接手）：已把 child TAKE 出槽（cleanup() 将看到
    /// 空槽不再碰它、也只报这一次），调用方负责落事件。
    ExitedUnexpectedly(crate::OwnedWebServerChild, ExitStatus),
}

/// watcher 的每秒单步（在 `AppState.web_server` 锁内执行）。锁与判定集中在这个
/// 纯入口里：线程体只剩 sleep + match，单测用真实 Mutex + 真实子进程驱动。
pub fn watch_tick(
    slot: &std::sync::Mutex<Option<crate::OwnedWebServerChild>>,
    watched_pid: u32,
) -> WatchTick {
    let mut guard = match slot.lock() {
        Ok(guard) => guard,
        Err(_) => return WatchTick::StillRunning, // 锁毒化：主流程已在 panic 路径，轮询让位
    };
    if !watcher_should_report(guard.as_ref().map(|owned| owned.pid), watched_pid) {
        return WatchTick::SlotGone;
    }
    match guard.as_mut().expect("slot checked above").child.try_wait() {
        Ok(Some(status)) => {
            // 死在槽里：TAKE 出槽（cleanup() 将看到空槽，不再碰、不再发事件）
            let owned = guard.take().expect("slot checked above");
            WatchTick::ExitedUnexpectedly(owned, status)
        }
        Ok(None) => WatchTick::StillRunning,
        // try_wait 偶发失败下一轮再试
        Err(_) => WatchTick::StillRunning,
    }
}

/// 每个「被壳 spawn 并收管」的子进程一个 watcher 线程。在两个 `store_child`
/// 调用点（setup 主启动 + window-recreate 重启）之后各启一个。
/// 线程创建失败只意味着取证缺失，不影响主流程。
pub fn spawn_exit_watcher(app: tauri::AppHandle, watched_pid: u32) {
    let _ = std::thread::Builder::new()
        .name("webserver-exit-watcher".to_string())
        .spawn(move || watch_web_server_child(app, watched_pid));
}

fn watch_web_server_child(app: tauri::AppHandle, watched_pid: u32) {
    loop {
        std::thread::sleep(WATCHER_POLL_INTERVAL);
        let state = app.state::<crate::AppState>();
        match watch_tick(&state.web_server, watched_pid) {
            WatchTick::StillRunning => continue,
            WatchTick::SlotGone => return,
            WatchTick::ExitedUnexpectedly(owned, status) => {
                let cause = classify_exit(&status);
                let dead_pid = owned.pid;
                report_unexpected_exit(&app, owned, status);
                // 取证已落盘，交给监督线程拉起替代者（有界重启 + backoff，
                // 连续 3 败弹「重试」对话框；N-WEBSERVER-DEATH-SUPERVISE-RESTART）。
                crate::webserver_supervise::supervise_after_death(
                    app.clone(),
                    cause,
                    dead_pid,
                    crate::webserver_supervise::PATH_OWNED_CHILD,
                );
                return;
            }
        }
    }
}

/// 死在槽里的收尾：端口易主 / 健康探针 / stdio 尾巴 + 落
/// `desktop-shell-webserver-exited-unexpectedly`（error 级）事件。
fn report_unexpected_exit(app: &tauri::AppHandle, owned: crate::OwnedWebServerChild, status: ExitStatus) {
    let described = describe_exit(&status);
    let holder_pids = crate::stale_web_server_port_holders(crate::web_port())
        .map(|holders| port_holders_excluding_dead(&holders, owned.pid))
        .unwrap_or_default();
    let facts = UnexpectedExitFacts {
        app_version: app.config().version.clone(),
        bundle_id: Some(app.config().identifier.clone()),
        web_port: crate::web_port(),
        shell_pid: std::process::id(),
        pid: owned.pid,
        started_at: owned.started_at.clone(),
        uptime_ms: uptime_ms_since(&owned.started_at),
        exit_code: described.exit_code,
        signal: described.signal,
        signal_name: described.signal_name,
        cause: classify_exit(&status),
        port_held_by_other: !holder_pids.is_empty(),
        port_holder_pids: holder_pids,
        health_probe: probe_health(&crate::health_url()),
        stdio_tail: crate::web_server_log_dir(app).and_then(|dir| tail_stdio_log(&dir)),
    };
    crate::append_shell_event_payload(app, unexpected_exit_event_payload(&facts));
}

/// `web_server_log_dir` 的 stdio 日志完整路径（main.rs spawn 用）。
pub fn stdio_log_path(log_dir: &Path) -> PathBuf {
    log_dir.join(WEBSERVER_STDIO_LOG_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command};

    // ── describe/classify：真实 ExitStatus（acceptance ①②）────────────────

    #[cfg(unix)]
    #[test]
    fn sigkill_reports_killed_by_signal_with_signal_9() {
        let status = Command::new("sh")
            .arg("-c")
            .arg("kill -9 $$")
            .status()
            .expect("spawn sh");
        let described = describe_exit(&status);
        assert_eq!(described.signal, Some(9), "sh -c 'kill -9 $$' 必须死于信号 9");
        assert_eq!(described.signal_name.as_deref(), Some("SIGKILL"));
        assert_eq!(described.exit_code, None, "被信号杀的进程没有退出码");
        assert_eq!(classify_exit(&status), CAUSE_KILLED_BY_SIGNAL);
    }

    #[cfg(unix)]
    #[test]
    fn exit_3_reports_exited_nonzero_with_code_3() {
        let status = Command::new("sh")
            .arg("-c")
            .arg("exit 3")
            .status()
            .expect("spawn sh");
        let described = describe_exit(&status);
        assert_eq!(described.exit_code, Some(3));
        assert_eq!(described.signal, None);
        assert_eq!(described.signal_name, None);
        assert_eq!(classify_exit(&status), CAUSE_EXITED_NONZERO);
    }

    #[cfg(unix)]
    #[test]
    fn unrequested_exit_0_reports_exited_zero_unrequested() {
        let status = Command::new("sh")
            .arg("-c")
            .arg("exit 0")
            .status()
            .expect("spawn sh");
        let described = describe_exit(&status);
        assert_eq!(described.exit_code, Some(0));
        assert_eq!(classify_exit(&status), CAUSE_EXITED_ZERO_UNREQUESTED);
    }

    // ── portHeldByOther 与 cause 解耦（acceptance ③）───────────────────────

    #[cfg(unix)]
    #[test]
    fn port_held_by_other_is_reported_separately_from_cause() {
        let killed = Command::new("sh")
            .arg("-c")
            .arg("kill -9 $$")
            .status()
            .expect("spawn sh");
        let zero = Command::new("sh")
            .arg("-c")
            .arg("exit 0")
            .status()
            .expect("spawn sh");
        let dead_pid = 424_242u32;

        // 同一份「假占用者名单」配不同归因：cause 只看 status，port 只看 holders
        let holders = vec![dead_pid, 7777, 8888];
        let survivors = port_holders_excluding_dead(&holders, dead_pid);
        assert_eq!(survivors, vec![7777, 8888]);
        assert_eq!(classify_exit(&killed), CAUSE_KILLED_BY_SIGNAL);
        assert_eq!(classify_exit(&zero), CAUSE_EXITED_ZERO_UNREQUESTED);

        // 名单为空 → portHeldByOther=false，归因不受影响
        assert!(port_holders_excluding_dead(&[dead_pid], dead_pid).is_empty());
        assert_eq!(classify_exit(&killed), CAUSE_KILLED_BY_SIGNAL);

        // 事件 JSON 带上两组独立事实
        let facts = UnexpectedExitFacts {
            app_version: Some("0.0.0-test".to_string()),
            bundle_id: Some("com.example.test".to_string()),
            web_port: 8180,
            shell_pid: 111,
            pid: dead_pid,
            started_at: "1000".to_string(),
            uptime_ms: 5000,
            exit_code: describe_exit(&zero).exit_code,
            signal: describe_exit(&killed).signal,
            signal_name: describe_exit(&killed).signal_name,
            cause: classify_exit(&zero),
            port_held_by_other: !survivors.is_empty(),
            port_holder_pids: survivors,
            health_probe: "http-200".to_string(),
            stdio_tail: Some("last output".to_string()),
        };
        let payload = unexpected_exit_event_payload(&facts);
        assert_eq!(payload["level"], "error");
        assert_eq!(payload["event"], UNEXPECTED_EXIT_EVENT);
        let process = payload["process"].as_object().expect("process object");
        for key in [
            "pid",
            "startedAt",
            "uptimeMs",
            "exitCode",
            "signal",
            "signalName",
            "cause",
            "portHeldByOther",
            "portHolderPids",
            "healthProbe",
            "stdioTail",
        ] {
            assert!(process.contains_key(key), "事件缺任务书点名的字段 {key}");
        }
        assert_eq!(payload["process"]["portHeldByOther"], true);
        assert_eq!(payload["process"]["portHolderPids"], serde_json::json!([7777, 8888]));
        assert_eq!(payload["process"]["cause"], CAUSE_EXITED_ZERO_UNREQUESTED);
        assert_eq!(payload["process"]["signal"], 9);
        assert_eq!(payload["process"]["signalName"], "SIGKILL");
    }

    // ── watcher 判定：cleanup 已 take 绝不报（acceptance ④）────────────────

    #[test]
    fn watcher_does_not_report_after_cleanup_took_the_child() {
        // 槽空 = cleanup() 已 take —— 故意停机，绝不产生 unexpected 事件
        assert!(!watcher_should_report(None, 4242));
        // 槽里还是同一个 pid 才报
        assert!(watcher_should_report(Some(4242), 4242));
        // 槽里换了新 child（window-recreate 重启）——旧 watcher 让位不报
        assert!(!watcher_should_report(Some(7777), 4242));
    }

    /// 真实槽位 + 真实子进程的 watch_tick 驱动器。
    fn slot_with(child: Child, pid: u32) -> std::sync::Mutex<Option<crate::OwnedWebServerChild>> {
        std::sync::Mutex::new(Some(crate::OwnedWebServerChild {
            child,
            pid,
            owner: "tauri-shell",
            started_at: crate::now_millis_string(),
            stdin_eof_cleanup: true,
        }))
    }

    #[test]
    fn watch_tick_takes_dead_child_out_of_slot_and_reports_once() {
        // 真实子进程，自然退出（exit 0，未经请求——cleanup 没接手）
        let child = Command::new("sh").arg("-c").arg("exit 0").spawn().expect("spawn");
        let pid = child.id();
        let slot = slot_with(child, pid);

        // 先等子进程死透（spawn 与首拍之间有竞态，sh 未必已经退出）；
        // 轮询只读 try_wait，不动槽位内容。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let exited = slot
                .lock()
                .expect("lock")
                .as_mut()
                .expect("child in slot")
                .child
                .try_wait()
                .expect("try_wait")
                .is_some();
            if exited || std::time::Instant::now() > deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // 第一拍：死在槽里 → ExitedUnexpectedly，且 child 已被 TAKE 出槽
        let (owned, status) = match watch_tick(&slot, pid) {
            WatchTick::ExitedUnexpectedly(owned, status) => (owned, status),
            other => panic!("第一拍必须报 ExitedUnexpectedly，实际 {other:?}"),
        };
        assert_eq!(owned.pid, pid);
        assert_eq!(classify_exit(&status), CAUSE_EXITED_ZERO_UNREQUESTED);
        assert!(slot.lock().expect("lock").is_none(), "child 必须 TAKE 出槽");

        // 第二拍：槽已空 → SlotGone（只报一次，cleanup 不会再碰）
        assert!(matches!(watch_tick(&slot, pid), WatchTick::SlotGone));
    }

    #[test]
    fn watch_tick_reports_nothing_while_child_is_alive() {
        // 真实活子进程：watch_tick 必须继续轮询，绝不误报
        let child = Command::new("sh").arg("-c").arg("sleep 30").spawn().expect("spawn");
        let pid = child.id();
        let slot = slot_with(child, pid);
        assert!(matches!(watch_tick(&slot, pid), WatchTick::StillRunning));
        let _ = slot
            .lock()
            .expect("lock")
            .as_mut()
            .expect("alive")
            .child
            .kill();
    }

    #[test]
    fn intentional_cleanup_then_tick_never_reports_unexpected_exit() {
        // acceptance ④ 的真流程：cleanup() 先把 child 从槽里 take 走（故意停机），
        // 之后 watcher 的任何一拍都不得报 unexpected。
        let child = Command::new("sh").arg("-c").arg("sleep 30").spawn().expect("spawn");
        let pid = child.id();
        let state = crate::AppState::default();
        *state.web_server.lock().expect("lock") = Some(crate::OwnedWebServerChild {
            child,
            pid,
            owner: "tauri-shell",
            started_at: crate::now_millis_string(),
            stdin_eof_cleanup: true,
        });

        // cleanup（旧通道 SIGTERM；sh 立即死）——真实走 AppState::cleanup
        let cleanup = state.cleanup(false);
        assert!(cleanup.is_some(), "cleanup 必须接手槽里的 child");
        assert_eq!(cleanup.expect("checked").pid, pid);
        assert!(state.web_server.lock().expect("lock").is_none());

        // 之后 watcher 的每一拍都是 SlotGone：故意停机绝不产生 unexpected 事件
        assert!(matches!(watch_tick(&state.web_server, pid), WatchTick::SlotGone));
        assert!(matches!(watch_tick(&state.web_server, pid), WatchTick::SlotGone));
    }

    /// ⑥ 反向变异锚：把 main.rs 的 spawn 改回 `Stdio::inherit()`（撤掉 stdio
    /// 落盘重定向）或删掉 store_child 后的 watcher 启动 → 本测试红。
    /// include_str! 在编译期把 main.rs 钉进来，锚的是接线文本本身。
    #[test]
    fn main_rs_wiring_pins_stdio_redirect_and_exit_watcher() {
        let main_rs = include_str!("main.rs");
        assert!(
            main_rs.contains("webserver_exit::open_stdio_log"),
            "spawn 必须先经 open_stdio_log 打开 webserver-stdio.log（撤掉重定向会红）"
        );
        assert!(
            main_rs.contains(".stdout(stdout_stdio)"),
            "stdout 必须重定向到 stdio 日志句柄（改回 inherit 会红）"
        );
        assert!(
            main_rs.contains(".stderr(stderr_stdio)"),
            "stderr 必须重定向到 stdio 日志句柄（改回 inherit 会红）"
        );
        assert!(
            main_rs.contains("webserver_exit::spawn_exit_watcher"),
            "store_child 之后必须启动退出 watcher（删掉会红）"
        );
        // 两处 store_child 调用点（setup 主启动 + window-recreate）都要各有一个 watcher
        assert_eq!(
            main_rs.matches("webserver_exit::spawn_exit_watcher").count(),
            2,
            "watcher 必须在两个 store_child 调用点之后各启一个"
        );
    }

    #[test]
    fn uptime_ms_since_parses_started_at_and_saturates() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let started = (now - 5_000).to_string();
        let uptime = uptime_ms_since(&started);
        assert!(uptime >= 4_900 && uptime <= 6_000, "uptime={uptime}");
        // 非法输入按 0 → uptime = now（不 panic）
        assert!(uptime_ms_since("not-a-number") >= now);
        // started_at 在未来（时钟回拨）→ 饱和到 0
        assert_eq!(uptime_ms_since(&(now + 60_000).to_string()), 0);
    }

    // ── stdio 日志：轮转 + 尾巴（unix/windows 都是真文件系统）──────────────

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "webserver-exit-test-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn stdio_log_rotates_over_5mib_and_appends_fresh_file() {
        let dir = temp_dir("rotate");
        let path = stdio_log_path(&dir);
        fs::write(&path, vec![b'x'; (STDIO_LOG_ROTATE_BYTES + 1) as usize]).expect("seed oversized log");

        let file = open_stdio_log(&dir).expect("open with rotation");
        drop(file);
        assert!(
            dir.join(WEBSERVER_STDIO_LOG_ROTATED_FILE).exists(),
            "超限日志必须轮转成 .1"
        );
        // 主文件从零开始追加
        let metadata = fs::metadata(&path).expect("fresh log");
        assert_eq!(metadata.len(), 0);

        // 未超限的下一轮不再轮转（.1 保持、主文件继续追加）
        fs::write(&path, b"hello").expect("seed small log");
        drop(open_stdio_log(&dir).expect("open again"));
        assert_eq!(fs::read(&path).expect("read"), b"hello");
        assert_eq!(
            fs::metadata(&dir.join(WEBSERVER_STDIO_LOG_ROTATED_FILE))
                .expect("rotated kept")
                .len(),
            STDIO_LOG_ROTATE_BYTES + 1
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_stdio_log_returns_last_4kib() {
        let dir = temp_dir("tail");
        let path = stdio_log_path(&dir);
        let mut blob = vec![b'a'; STDIO_TAIL_BYTES as usize];
        blob.extend_from_slice(b"THE-END-MARKER");
        fs::write(&path, &blob).expect("seed log");

        let tail = tail_stdio_log(&dir).expect("tail");
        assert!(tail.ends_with("THE-END-MARKER"), "尾巴必须是最后一段");
        assert!((tail.len() as u64) <= STDIO_TAIL_BYTES + 1);

        // 文件不存在 → None（stdio 可能回退 inherit，取证缺角不挡事件）
        let empty_dir = temp_dir("tail-empty");
        assert_eq!(tail_stdio_log(&empty_dir), None);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&empty_dir);
    }

    #[test]
    fn signal_name_covers_posix_stable_set_and_falls_back_for_the_rest() {
        assert_eq!(signal_name(9), "SIGKILL");
        assert_eq!(signal_name(15), "SIGTERM");
        assert_eq!(signal_name(2), "SIGINT");
        // 平台私有编号不给假名
        assert_eq!(signal_name(64), "signal-64");
    }
}
