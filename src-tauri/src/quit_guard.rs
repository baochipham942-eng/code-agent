//! 退出守卫（N-QUIT-RUNNING-NATIVE）：Tauri 壳在退出前问一次 webServer 的
//! `GET /api/quit-guard`（N-QUIT-GUARD-ENDPOINT 落的鉴权路由），有运行中任务
//! 或已挂定时任务时弹原生确认框，默认按钮是「取消」。
//!
//! 纯逻辑（解析/决策/文案/协调器）不依赖 Tauri 类型，可单测；只有
//! `install_shutdown_observer` 一处碰 objc2（macOS 关机通知）。

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 查询 /api/quit-guard 的总超时（连接+读，reqwest client 的 timeout）。
/// 超时/连接失败/非 200/解析失败一律按「有任务」处理（Unknown → 弹框）。
pub const QUIT_GUARD_TIMEOUT: Duration = Duration::from_secs(2);
pub const QUIT_GUARD_PATH: &str = "/api/quit-guard";
/// 鉴权 token 文件名，与 src/web/middleware/auth.ts 的 .dev-token 生命周期对齐。
pub const DEV_TOKEN_FILE: &str = ".dev-token";

// ─────────────────────────────────────────────────────────────────────────────
// 响应解析
// ─────────────────────────────────────────────────────────────────────────────

/// 查询结果：拿到确切的两个计数，或一切「不可确信」的情况（Unknown）。
/// Unknown 永远不允许直接退出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardOutcome {
    Counts {
        active_runs: u64,
        armed_schedules: u64,
    },
    Unknown,
}

/// 只接受恰好两个非负整数键的 `{"activeRuns":n,"armedSchedules":m}`：
/// 非 200、缺键、多键、字符串数字、负数、浮点数一律 Unknown。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GuardCountsBody {
    active_runs: u64,
    armed_schedules: u64,
}

pub fn parse_guard_response(status: u16, body: &str) -> GuardOutcome {
    if status != 200 {
        return GuardOutcome::Unknown;
    }
    match serde_json::from_str::<GuardCountsBody>(body) {
        Ok(counts) => GuardOutcome::Counts {
            active_runs: counts.active_runs,
            armed_schedules: counts.armed_schedules,
        },
        Err(_) => GuardOutcome::Unknown,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 退出决策（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

/// 弹框文案的四种形态（text key），由 decide_quit 从计数推导。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitPrompt {
    RunningTasks,
    ScheduledTasks,
    Both,
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitDecision {
    /// 直接退出，不弹框。
    ExitNow,
    /// 弹原生确认框，携带对应文案。
    Confirm(QuitPrompt),
}

/// 豁免类：系统关机 / 已确认的更新重启 / 信号退出。任一命中 → ExitNow。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitSkip {
    SystemShutdown,
    UpdateRestart,
    SignalExit,
}

pub fn decide_quit(outcome: GuardOutcome, skip: Option<QuitSkip>) -> QuitDecision {
    if skip.is_some() {
        return QuitDecision::ExitNow;
    }
    match outcome {
        // Unknown 宁可多问一次，绝不直接退出
        GuardOutcome::Unknown => QuitDecision::Confirm(QuitPrompt::Unverified),
        GuardOutcome::Counts {
            active_runs,
            armed_schedules,
        } => match (active_runs > 0, armed_schedules > 0) {
            (false, false) => QuitDecision::ExitNow,
            (true, false) => QuitDecision::Confirm(QuitPrompt::RunningTasks),
            (false, true) => QuitDecision::Confirm(QuitPrompt::ScheduledTasks),
            (true, true) => QuitDecision::Confirm(QuitPrompt::Both),
        },
    }
}

pub const QUIT_DIALOG_TITLE: &str = "确定要退出 Agent Neo 吗？";
pub const QUIT_DIALOG_CANCEL_BUTTON: &str = "取消";
pub const QUIT_DIALOG_QUIT_BUTTON: &str = "退出";

/// 四种弹框文案，互不相同（有单测钉死）。
pub fn quit_prompt_text(prompt: QuitPrompt) -> &'static str {
    match prompt {
        QuitPrompt::RunningTasks => "退出后，运行中的任务将被中断。",
        QuitPrompt::ScheduledTasks => "退出后，定时任务将不再执行。",
        QuitPrompt::Both => "退出后，运行中的任务将被中断，定时任务将不再执行。",
        QuitPrompt::Unverified => "无法确认是否有任务在运行。退出可能中断任务或使定时任务失效。",
    }
}

/// 对话框应答 → 动作。`answer_is_first_button` 是 tauri-plugin-dialog `show`
/// 回调的 bool：true 表示按下的是第一个自定义按钮。我们把安全动作「取消」
/// 放在第一个（也是 macOS NSAlert / Windows TaskDialog 的默认回车键）按钮上，
/// 所以 true → 不退出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitAnswerAction {
    StayRunning,
    Quit,
}

pub fn dialog_answer_action(answer_is_first_button: bool) -> QuitAnswerAction {
    if answer_is_first_button {
        QuitAnswerAction::StayRunning
    } else {
        QuitAnswerAction::Quit
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 协调器（弹框去重 / 一次性放行 / 豁免标志）
// ─────────────────────────────────────────────────────────────────────────────

/// 原子标志组，挂在 Tauri managed state（`Arc<QuitCoordinator>`）上。
#[derive(Default)]
pub struct QuitCoordinator {
    /// 弹框是否开着：开着期间再来的退出请求并入这一个弹框。
    dialog_open: AtomicBool,
    /// 程序化 `exit()` 前置位，重入的 ExitRequested 消费一次后直接放行。
    exit_allowed: AtomicBool,
    system_shutdown: AtomicBool,
    update_restart_confirmed: AtomicBool,
    signal_exit: AtomicBool,
}

impl QuitCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    /// 弹框去重：只有「无弹框时的第一个请求」拿到 true；期间后续请求 false。
    pub fn begin_request(&self) -> bool {
        self.dialog_open
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// 用户应答后复位，之后的退出请求可以再次弹框。
    pub fn finish(&self) {
        self.dialog_open.store(false, Ordering::SeqCst);
    }

    pub fn allow_exit(&self) {
        self.exit_allowed.store(true, Ordering::Release);
    }

    /// 消费一次：放行一次程序化退出后即复位，一次确认不能豁免之后的退出。
    pub fn exit_allowed(&self) -> bool {
        self.exit_allowed.swap(false, Ordering::AcqRel)
    }

    pub fn set_system_shutdown(&self) {
        self.system_shutdown.store(true, Ordering::Release);
    }

    pub fn set_update_restart_confirmed(&self) {
        self.update_restart_confirmed.store(true, Ordering::Release);
    }

    /// SIGINT/SIGTERM：install_signal_handler 在 handle.exit(0) 之前置位。
    pub fn set_signal_exit(&self) {
        self.signal_exit.store(true, Ordering::Release);
    }

    /// 豁免查询（优先级无关行为，只影响上报哪个变体）：最不可逆的先报。
    pub fn current_skip(&self) -> Option<QuitSkip> {
        if self.system_shutdown.load(Ordering::Acquire) {
            Some(QuitSkip::SystemShutdown)
        } else if self.signal_exit.load(Ordering::Acquire) {
            Some(QuitSkip::SignalExit)
        } else if self.update_restart_confirmed.load(Ordering::Acquire) {
            Some(QuitSkip::UpdateRestart)
        } else {
            None
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// token 读取（镜像 auth.ts 的 resolveDevAuthTokenPath）
// ─────────────────────────────────────────────────────────────────────────────

/// server 进程的 cwd（spawn 时的 working_dir）落在 `*.app/Contents/Resources`
/// 里 → 读 `<数据目录>/.dev-token`；否则（dev）读 `<cwd>/.dev-token`。
/// 与 src/web/middleware/auth.ts `resolveDevAuthTokenPath` 逐分支对齐。
pub fn quit_guard_token_path(server_root: &Path, data_dir: Option<&Path>) -> Option<PathBuf> {
    if is_packaged_resources_path(server_root) {
        data_dir.map(|dir| dir.join(DEV_TOKEN_FILE))
    } else {
        Some(server_root.join(DEV_TOKEN_FILE))
    }
}

/// 读 token：缺失/读不了/不是 UUID 形状 → None（= Unknown，弹框）。绝不记日志外发。
pub fn read_quit_guard_token(server_root: &Path, data_dir: Option<&Path>) -> Option<String> {
    let path = quit_guard_token_path(server_root, data_dir)?;
    let content = std::fs::read_to_string(path).ok()?;
    let trimmed = content.trim();
    if is_uuid_shaped(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// 镜像 auth.ts 的 UUID_RE：`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
fn is_uuid_shaped(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// 镜像 auth.ts 的 isPackagedResourceCwd：路径里存在 `*.app/Contents/Resources` 段。
fn is_packaged_resources_path(path: &Path) -> bool {
    let segments: Vec<_> = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect();
    (0..segments.len().saturating_sub(2)).any(|index| {
        segments[index].ends_with(".app")
            && segments[index + 1] == "Contents"
            && segments[index + 2] == "Resources"
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 查询（worker 线程里调，绝不在事件循环线程上跑）
// ─────────────────────────────────────────────────────────────────────────────

pub fn query_quit_guard(base_url: &str, token: Option<&str>, timeout: Duration) -> GuardOutcome {
    // token 缺失/不可读 = 无法鉴权 = Unknown，且绝不发无鉴权请求
    let Some(token) = token else {
        return GuardOutcome::Unknown;
    };
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(timeout)
        // 守卫查询只打 localhost，绕开系统代理，避免代理环境把它变成 Unknown
        .no_proxy()
        .build()
    else {
        return GuardOutcome::Unknown;
    };
    let url = format!("{base_url}{QUIT_GUARD_PATH}");
    let Ok(response) = client.get(&url).bearer_auth(token).send() else {
        return GuardOutcome::Unknown;
    };
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    parse_guard_response(status, &body)
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS 关机观察者
// ─────────────────────────────────────────────────────────────────────────────

/// macOS：监听 NSWorkspaceWillPowerOffNotification，系统关机时置 system_shutdown，
/// 之后的退出请求不弹框（不能让 AppKit 模态框拖住关机流程）。
/// 观察者 token 泄漏换取订阅随进程存活（与 appshots 的 tracker 同款处理）。
#[cfg(target_os = "macos")]
pub fn install_shutdown_observer(coordinator: Arc<QuitCoordinator>) {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceWillPowerOffNotification};
    use objc2_foundation::NSNotificationCenter;

    let workspace = NSWorkspace::sharedWorkspace();
    let center: objc2::rc::Retained<NSNotificationCenter> = workspace.notificationCenter();
    let block = RcBlock::new(
        move |_notification: std::ptr::NonNull<objc2_foundation::NSNotification>| {
            coordinator.set_system_shutdown();
        },
    );
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceWillPowerOffNotification),
            None,
            None,
            &block,
        )
    };
    std::mem::forget(observer);
}

// ponytail: Windows/Linux 未实现关机检测——系统注销/关机时退出请求可能仍会弹框。
// tauri-runtime-wry 不处理 WM_QUERYENDSESSION（tao-0.35.2 event_loop.rs:2382 注释），
// 现状也无法拦截，见证据档「未验证/已知缺口」。
#[cfg(not(target_os = "macos"))]
pub fn install_shutdown_observer(_coordinator: Arc<QuitCoordinator>) {}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU64, AtomicUsize};
    use std::sync::Mutex;
    use std::thread;

    const TEST_TIMEOUT: Duration = Duration::from_secs(2);
    const TEST_UUID: &str = "0f1e2d3c-4b5a-6978-897a-6b5c4d3e2f10";

    fn counts(active_runs: u64, armed_schedules: u64) -> GuardOutcome {
        GuardOutcome::Counts {
            active_runs,
            armed_schedules,
        }
    }

    // ── decide_quit 表驱动 ────────────────────────────────────────────────────

    #[test]
    fn decide_quit_maps_counts_to_prompts() {
        let cases: &[(GuardOutcome, QuitDecision)] = &[
            (counts(0, 0), QuitDecision::ExitNow),
            (
                counts(1, 0),
                QuitDecision::Confirm(QuitPrompt::RunningTasks),
            ),
            (
                counts(7, 0),
                QuitDecision::Confirm(QuitPrompt::RunningTasks),
            ),
            (
                counts(0, 1),
                QuitDecision::Confirm(QuitPrompt::ScheduledTasks),
            ),
            (
                counts(0, 9),
                QuitDecision::Confirm(QuitPrompt::ScheduledTasks),
            ),
            (counts(2, 3), QuitDecision::Confirm(QuitPrompt::Both)),
            (
                GuardOutcome::Unknown,
                QuitDecision::Confirm(QuitPrompt::Unverified),
            ),
        ];
        for (outcome, expected) in cases {
            assert_eq!(
                decide_quit(*outcome, None),
                *expected,
                "outcome {outcome:?} 应映射到 {expected:?}"
            );
        }
    }

    #[test]
    fn decide_quit_any_skip_exits_now() {
        let skips = [
            QuitSkip::SystemShutdown,
            QuitSkip::UpdateRestart,
            QuitSkip::SignalExit,
        ];
        let outcomes = [counts(0, 0), counts(1, 1), GuardOutcome::Unknown];
        for skip in skips {
            for outcome in outcomes {
                assert_eq!(
                    decide_quit(outcome, Some(skip)),
                    QuitDecision::ExitNow,
                    "豁免 {skip:?} 遇 {outcome:?} 必须直接退出"
                );
            }
        }
    }

    #[test]
    fn quit_prompt_texts_are_pairwise_distinct() {
        let prompts = [
            QuitPrompt::RunningTasks,
            QuitPrompt::ScheduledTasks,
            QuitPrompt::Both,
            QuitPrompt::Unverified,
        ];
        for i in 0..prompts.len() {
            for j in (i + 1)..prompts.len() {
                assert_ne!(
                    quit_prompt_text(prompts[i]),
                    quit_prompt_text(prompts[j]),
                    "{} 与 {} 文案必须互不相同",
                    quit_prompt_text(prompts[i]),
                    quit_prompt_text(prompts[j])
                );
            }
        }
        // 台账验收的原文措辞必须出现
        assert!(quit_prompt_text(QuitPrompt::RunningTasks).contains("运行中的任务将被中断"));
        assert!(quit_prompt_text(QuitPrompt::ScheduledTasks).contains("定时任务将不再执行"));
        assert!(quit_prompt_text(QuitPrompt::Unverified).contains("无法确认是否有任务在运行"));
    }

    // ── parse_guard_response ──────────────────────────────────────────────────

    #[test]
    fn parse_guard_response_accepts_exact_body() {
        assert_eq!(
            parse_guard_response(200, r#"{"activeRuns":2,"armedSchedules":3}"#),
            counts(2, 3)
        );
        // 键序无关
        assert_eq!(
            parse_guard_response(200, r#"{"armedSchedules":3,"activeRuns":2}"#),
            counts(2, 3)
        );
        assert_eq!(
            parse_guard_response(200, r#"{"activeRuns":0,"armedSchedules":0}"#),
            counts(0, 0)
        );
    }

    #[test]
    fn parse_guard_response_rejects_everything_else() {
        let bad_bodies = [
            r#""#,                                              // 空体
            r#"not json"#,                                      // 非 JSON
            r#"null"#,                                          // null
            r#"{"activeRuns":1}"#,                              // 缺键
            r#"{"armedSchedules":1}"#,                          // 缺另一键
            r#"{"activeRuns":1,"armedSchedules":0,"extra":1}"#, // 多键
            r#"{"activeRuns":"1","armedSchedules":0}"#,         // 字符串数字
            r#"{"activeRuns":-1,"armedSchedules":0}"#,          // 负数
            r#"{"activeRuns":1.5,"armedSchedules":0}"#,         // 浮点
            r#"{"activeRuns":1.0,"armedSchedules":0}"#,         // 整值浮点也算非整数
        ];
        for body in bad_bodies {
            assert_eq!(
                parse_guard_response(200, body),
                GuardOutcome::Unknown,
                "200 + {body} 必须判 Unknown"
            );
        }
        // 非 200：即使 body 合法也 Unknown
        for status in [401u16, 403, 500, 404, 502] {
            assert_eq!(
                parse_guard_response(status, r#"{"activeRuns":0,"armedSchedules":0}"#),
                GuardOutcome::Unknown,
                "status {status} 必须判 Unknown"
            );
        }
    }

    // ── query_quit_guard（本地 TcpListener stub，零外网） ─────────────────────

    enum StubMode {
        Respond {
            status: u16,
            body: &'static str,
        },
        /// 收下请求但永不应答，持住连接
        Hang,
    }

    fn spawn_stub(mode: StubMode) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        thread::spawn(move || {
            let Ok(Ok(mut stream)) = listener.accept().map(|(s, _)| Ok::<_, std::io::Error>(s))
            else {
                return;
            };
            let mut raw = String::new();
            let mut buf = [0u8; 8192];
            loop {
                match stream.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        raw.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if raw.contains("\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            if let Ok(mut guard) = recorded.lock() {
                guard.push(raw.clone());
            }
            match mode {
                StubMode::Respond { status, body } => {
                    let response = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
                StubMode::Hang => {
                    thread::sleep(Duration::from_secs(6));
                }
            }
        });
        (format!("http://127.0.0.1:{}", addr.port()), requests)
    }

    #[test]
    fn query_quit_guard_returns_counts_and_sends_bearer() {
        let (base_url, requests) = spawn_stub(StubMode::Respond {
            status: 200,
            body: r#"{"activeRuns":1,"armedSchedules":2}"#,
        });
        let outcome = query_quit_guard(&base_url, Some(TEST_UUID), TEST_TIMEOUT);
        assert_eq!(outcome, counts(1, 2));
        let recorded = requests.lock().expect("stub mutex");
        let raw = recorded.first().expect("stub 应该看到恰好一个请求");
        assert!(
            raw.starts_with("GET /api/quit-guard HTTP/1.1"),
            "请求行应是 GET {QUIT_GUARD_PATH}，实际：{raw}"
        );
        assert!(
            raw.contains(&format!("authorization: Bearer {TEST_UUID}"))
                || raw.contains(&format!("Authorization: Bearer {TEST_UUID}")),
            "必须携带 Authorization: Bearer <token>，实际：{raw}"
        );
    }

    #[test]
    fn query_quit_guard_non_200_is_unknown() {
        let (base_url, _requests) = spawn_stub(StubMode::Respond {
            status: 500,
            body: r#"{"error":"quit-guard-unavailable"}"#,
        });
        assert_eq!(
            query_quit_guard(&base_url, Some(TEST_UUID), TEST_TIMEOUT),
            GuardOutcome::Unknown
        );
    }

    #[test]
    fn query_quit_guard_timeout_is_unknown_within_bounds() {
        let (base_url, _requests) = spawn_stub(StubMode::Hang);
        let started = std::time::Instant::now();
        let outcome = query_quit_guard(&base_url, Some(TEST_UUID), TEST_TIMEOUT);
        let elapsed = started.elapsed();
        assert_eq!(outcome, GuardOutcome::Unknown);
        assert!(
            elapsed >= TEST_TIMEOUT,
            "挂死连接应在超时后才返回，实际 {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(4),
            "2s 超时不应拖到 {elapsed:?}"
        );
    }

    #[test]
    fn query_quit_guard_connection_refused_is_unknown() {
        // 拿一个必然没人监听的端口：bind 后立刻 drop
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let base_url = format!("http://127.0.0.1:{port}");
        assert_eq!(
            query_quit_guard(&base_url, Some(TEST_UUID), TEST_TIMEOUT),
            GuardOutcome::Unknown
        );
    }

    #[test]
    fn query_quit_guard_without_token_makes_no_request() {
        let (base_url, requests) = spawn_stub(StubMode::Respond {
            status: 200,
            body: r#"{"activeRuns":0,"armedSchedules":0}"#,
        });
        assert_eq!(
            query_quit_guard(&base_url, None, TEST_TIMEOUT),
            GuardOutcome::Unknown
        );
        thread::sleep(Duration::from_millis(200));
        assert!(
            requests.lock().expect("stub mutex").is_empty(),
            "token 缺失时绝不能发请求"
        );
    }

    // ── token 文件解析 ────────────────────────────────────────────────────────

    static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quit-guard-{tag}-{}-{}",
            std::process::id(),
            TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn token_reader_accepts_uuid_shaped_file() {
        let root = temp_root("uuid-ok");
        std::fs::write(root.join(DEV_TOKEN_FILE), format!("{TEST_UUID}\n")).expect("write");
        assert_eq!(
            read_quit_guard_token(&root, None),
            Some(TEST_UUID.to_string())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn token_reader_rejects_missing_empty_or_non_uuid() {
        // 缺文件
        let root = temp_root("uuid-missing");
        assert_eq!(read_quit_guard_token(&root, None), None);
        // 空文件
        std::fs::write(root.join(DEV_TOKEN_FILE), "   \n").expect("write");
        assert_eq!(read_quit_guard_token(&root, None), None);
        // 非 UUID
        std::fs::write(root.join(DEV_TOKEN_FILE), "hello-token").expect("write");
        assert_eq!(read_quit_guard_token(&root, None), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn token_path_mirrors_auth_ts_resolution() {
        // dev：cwd 不在 .app 内 → <cwd>/.dev-token
        let dev_root = std::path::PathBuf::from("/Users/neo/work/code-agent");
        assert_eq!(
            quit_guard_token_path(&dev_root, None),
            Some(dev_root.join(DEV_TOKEN_FILE))
        );
        // 打包态：cwd 在 *.app/Contents/Resources → <数据目录>/.dev-token
        let packaged_root =
            std::path::PathBuf::from("/Applications/Agent Neo Dev.app/Contents/Resources");
        let data_dir = std::path::PathBuf::from("/Users/neo/.code-agent-dev");
        assert_eq!(
            quit_guard_token_path(&packaged_root, Some(&data_dir)),
            Some(data_dir.join(DEV_TOKEN_FILE))
        );
        // 打包态但数据目录不可解析 → None
        assert_eq!(quit_guard_token_path(&packaged_root, None), None);
    }

    // ── QuitCoordinator 并发 ──────────────────────────────────────────────────

    #[test]
    fn coordinator_allows_exactly_one_concurrent_request() {
        let coordinator = Arc::new(QuitCoordinator::new());
        let granted = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..50 {
            let coordinator = coordinator.clone();
            let granted = granted.clone();
            handles.push(thread::spawn(move || {
                if coordinator.begin_request() {
                    granted.fetch_add(1, Ordering::SeqCst);
                }
            }));
        }
        for handle in handles {
            handle.join().expect("join worker");
        }
        assert_eq!(
            granted.load(Ordering::SeqCst),
            1,
            "连发 50 次退出请求只允许一个拿到弹框权"
        );
        // 弹框开着期间再来一次，仍然拒绝
        assert!(!coordinator.begin_request());
        // 用户应答后复位，下次退出请求可再次弹框
        coordinator.finish();
        assert!(coordinator.begin_request());
        coordinator.finish();
    }

    #[test]
    fn coordinator_exit_allowed_is_consumed_once() {
        let coordinator = QuitCoordinator::new();
        assert!(!coordinator.exit_allowed());
        coordinator.allow_exit();
        assert!(coordinator.exit_allowed(), "置位后的第一次读取应放行");
        assert!(
            !coordinator.exit_allowed(),
            "放行一次后必须复位，不能豁免后续退出"
        );
    }

    #[test]
    fn coordinator_skip_flags_map_to_quit_skip() {
        let coordinator = QuitCoordinator::new();
        assert_eq!(coordinator.current_skip(), None);
        coordinator.set_update_restart_confirmed();
        assert_eq!(coordinator.current_skip(), Some(QuitSkip::UpdateRestart));
        coordinator.set_signal_exit();
        assert_eq!(
            coordinator.current_skip(),
            Some(QuitSkip::SignalExit),
            "信号退出优先于更新重启上报"
        );
        coordinator.set_system_shutdown();
        assert_eq!(
            coordinator.current_skip(),
            Some(QuitSkip::SystemShutdown),
            "关机优先级最高"
        );
        // exit_allowed 是独立机制：确认后的程序化退出走它，不占豁免标志
        coordinator.allow_exit();
        assert!(coordinator.exit_allowed());
    }

    // ── 对话框应答映射表 ──────────────────────────────────────────────────────

    #[test]
    fn dialog_answer_action_maps_default_button_to_stay_running() {
        // 第一个按钮（= 默认回车键 =「取消」）→ 不退出
        assert_eq!(dialog_answer_action(true), QuitAnswerAction::StayRunning);
        // 第二个按钮（「退出」）→ 退出
        assert_eq!(dialog_answer_action(false), QuitAnswerAction::Quit);
    }
}
