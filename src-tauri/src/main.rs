#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::HashSet,
    env,
    hash::{DefaultHasher, Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::AtomicBool, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    include_image, menu::MenuBuilder, tray::TrayIconBuilder, AppHandle, Emitter, Listener, Manager,
    RunEvent, State, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

mod agent_halo;
mod appshots;
mod native_app_icon;
mod native_desktop;
mod pip;
mod traffic_lights;

use appshots::{
    appshots_read_image_data_url, appshots_read_image_data_url_by_id, appshots_report_composer_slot,
    appshots_set_enabled,
    appshots_set_motion_enabled, appshots_set_target_session, appshots_skip_motion,
    appshots_trigger, AppshotsState,
};
use native_app_icon::desktop_get_app_icon;
use native_desktop::{
    desktop_capture_screenshot, desktop_get_capabilities, desktop_get_collector_status,
    desktop_get_frontmost_context, desktop_get_permission_status, desktop_list_recent_events,
    desktop_control_voice_aec, desktop_open_system_settings, desktop_request_microphone_permission,
    desktop_start_audio_rec, desktop_start_collector, desktop_start_voice_aec,
    desktop_stop_audio_rec, desktop_stop_collector, desktop_stop_voice_aec,
    desktop_update_analyze_text, desktop_write_voice_aec_playback, NativeDesktopState,
};
use agent_halo::{agent_halo_hide, agent_halo_mode, agent_halo_show, AgentHaloState};
use pip::{pip_control, pip_controls, pip_frame, pip_hide, pip_show};

/// 生产通道 webServer 端口；测试包用 `PROD_WEB_PORT + 槽位号` 以便与生产包、以及彼此同时运行。
const PROD_WEB_PORT: u16 = 8180;
/// dev 槽 1 的端口（历史默认）。槽 N 的端口由 channel_web_port 从 identifier 推导。
const DEV_WEB_PORT: u16 = 8181;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(90);
/// healthcheck 轮询间隔。webServer 就绪窗口实测 0.8s(warm)~3.7s(cold)，健康端点在
/// listen 之前一律 connection-refused（近乎零成本），故用 100ms 均匀覆盖整个窗口：
/// 把「就绪→壳侦测到」的量子化损耗从最坏 ~500ms 压到 ~100ms，每次启动都受益。
const HEALTH_INTERVAL: Duration = Duration::from_millis(100);
/// 首帧就绪信号(renderer-ready)的兜底超时：renderer 正常会在导航后 ~2.5s 完成首次
/// commit 并发信号,壳侧收到才显示窗口(消除启动闪烁)。万一信号丢失,超时后无论如何
/// 显示,避免窗口永久隐藏。实测 renderer 首帧 ~2.5s,故兜底设 5s(既覆盖慢机、又远小于
/// 原 10s,信号丢失时最坏也就 ~6s 出窗口而非 11s)。
const RENDERER_READY_TIMEOUT: Duration = Duration::from_secs(5);
/// 退出时先发 SIGTERM 让 webServer 走干净关库路径（checkpoint + 删 -wal/-shm），
/// 超过这个时限还没退出才 SIGKILL 兜底。
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const GRACEFUL_SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(100);
const DEFAULT_CLOUD_API_URL: &str = "https://agentneo.vercel.app";
const BUNDLED_RUNTIME_ROOT_ENV: &str = "AGENT_NEO_BUNDLED_RUNTIME_ROOT";
const RESOURCE_DIR_ENV: &str = "AGENT_NEO_RESOURCE_DIR";
const BOOT_DIAGNOSTICS_PATH_ENV: &str = "AGENT_NEO_TAURI_BOOT_DIAGNOSTICS_FILE";
const BOOT_DIAGNOSTICS_FILE: &str = "desktop-shell-boot-latest.json";
const SHELL_EVENTS_FILE: &str = "desktop-shell-events.ndjson";
const GLOBAL_HOTKEY_FOCUS_RETRY_DELAYS_MS: &[u64] = &[0, 25, 50, 100, 200, 400, 800];
const BUNDLED_NODE_PATHS: &[&[&str]] = &[
    &["dist", "bundled-node", "bin", "node"],
    &["dist", "bundled-node", "node"],
    &["bundled-node", "bin", "node"],
    &["bundled-node", "node"],
    // Windows 官方包是顶层 node.exe（prepare-bundled-node.mjs win32 布局）；
    // 候选按存在性过滤，跨平台共用一张表即可
    &["dist", "bundled-node", "node.exe"],
    &["bundled-node", "node.exe"],
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum DesktopShellBootStage {
    ChannelEnvApplied,
    ResourcePreflight,
    ServerScriptResolved,
    NodeBinaryResolved,
    WebServerSpawned,
    HealthReady,
    WindowNavigated,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopShellIssue {
    severity: String,
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum DesktopShellResourceKind {
    WebServer,
    Renderer,
    Runtime,
    NativeModule,
    Resource,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum DesktopShellResourceStatus {
    Present,
    Missing,
    NotExecutable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopShellResourceCheck {
    id: String,
    label: String,
    kind: DesktopShellResourceKind,
    path: String,
    required: bool,
    status: DesktopShellResourceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopShellPreviousFailure {
    stage: DesktopShellBootStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    recorded_stage: Option<DesktopShellBootStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    web_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    web_server_pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopShellBootDiagnostics {
    schema_version: u8,
    generated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle_id: Option<String>,
    pid: u32,
    web_port: u16,
    stage: DesktopShellBootStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    failed_stage: Option<DesktopShellBootStage>,
    health_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    boot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    web_server_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    script_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_binary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health_matched_boot_token: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_failure: Option<DesktopShellPreviousFailure>,
    resources: Vec<DesktopShellResourceCheck>,
    issues: Vec<DesktopShellIssue>,
}

#[derive(Default)]
struct AppState {
    web_server: Mutex<Option<OwnedWebServerChild>>,
}

struct OwnedWebServerChild {
    child: Child,
    pid: u32,
    owner: &'static str,
    started_at: String,
    stdin_eof_cleanup: bool,
}

struct DesktopShellProcessCleanup {
    owner: String,
    pid: u32,
    started_at: String,
    cleaned_at: String,
    exit_reason: String,
    wait_status: Option<String>,
    stdin_eof_cleanup: bool,
}

#[derive(Default)]
struct KeybindingHotkeysState {
    registered: Mutex<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeybindingGlobalHotkeyInput {
    action_id: String,
    accelerator: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeybindingGlobalHotkeyEvent {
    action_id: String,
    accelerator: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeybindingGlobalHotkeyResult {
    action_id: String,
    accelerator: String,
    registered: bool,
    error: Option<String>,
}

impl AppState {
    fn store_child(&self, child: Child) {
        let pid = child.id();
        let mut guard = self.web_server.lock().expect("web_server mutex poisoned");
        *guard = Some(OwnedWebServerChild {
            child,
            pid,
            owner: "tauri-shell",
            started_at: now_millis_string(),
            stdin_eof_cleanup: true,
        });
    }

    fn cleanup(&self) -> Option<DesktopShellProcessCleanup> {
        let mut guard = self.web_server.lock().expect("web_server mutex poisoned");

        let mut owned = guard.take()?;
        let (exit_reason, wait_status) = terminate_child(&mut owned.child);
        Some(DesktopShellProcessCleanup {
            owner: owned.owner.to_string(),
            pid: owned.pid,
            started_at: owned.started_at,
            cleaned_at: now_millis_string(),
            exit_reason,
            wait_status,
            stdin_eof_cleanup: owned.stdin_eof_cleanup,
        })
    }
}

/// 已经发出「请自行退出」的信号之后：轮询等它退，超时才 SIGKILL 兜底。
/// unix / not(unix) 两个 `terminate_child` 共用同一份超时策略，避免两处各自漂移。
/// exit_reason 区分 graceful/forced，是事后判断「这次退出干不干净」的唯一证据。
fn wait_then_force_kill(child: &mut Child, graceful_reason: &str) -> (String, Option<String>) {
    let deadline = Instant::now() + GRACEFUL_SHUTDOWN_TIMEOUT;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return (graceful_reason.to_string(), Some(status.to_string())),
            Ok(None) => thread::sleep(GRACEFUL_SHUTDOWN_POLL_INTERVAL),
            Err(_) => break,
        }
    }

    force_kill(child, "forced-sigkill-timeout")
}

/// 先发 SIGTERM 让 webServer 自己走干净关库路径，再交给 `wait_then_force_kill` 轮询等它退。
#[cfg(unix)]
fn terminate_child(child: &mut Child) -> (String, Option<String>) {
    let pid = child.id() as i32;
    // SAFETY: pid 是刚 spawn 出、尚未被 wait 掉的子进程句柄，SIGTERM 是标准的
    // 「请自行退出」信号，不涉及内存操作。
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return force_kill(child, "forced-sigkill-sigterm-send-failed");
    }

    wait_then_force_kill(child, "graceful-sigterm")
}

/// Windows 没有 POSIX 信号，TerminateProcess（Child::kill）不给子进程任何收尾机会。
/// 但 webServer 本来就监听 stdin EOF 自杀（`webServer.ts` 的 `process.stdin.on('end')`，
/// spawn 时的 `.stdin(Stdio::piped())` 就是为它准备的），所以这里关掉 stdin 写端
/// 当作「请自行退出」，再走与 unix 同一套轮询 + 超时兜底。
/// 不用 CREATE_NEW_PROCESS_GROUP + CTRL_BREAK_EVENT：那要 unsafe winapi + 改 spawn flags
/// （已带 CREATE_NO_WINDOW，叠加还得另验），而 stdin EOF 这条通路是现成且已在用的。
#[cfg(not(unix))]
fn terminate_child(child: &mut Child) -> (String, Option<String>) {
    // take() 取出 ChildStdin，出作用域即关闭管道写端 → 子进程 stdin 收到 EOF。
    if child.stdin.take().is_none() {
        return force_kill(child, "forced-sigkill-no-stdin-pipe");
    }

    wait_then_force_kill(child, "graceful-stdin-eof")
}

fn force_kill(child: &mut Child, reason: &str) -> (String, Option<String>) {
    if let Err(error) = child.kill() {
        return (format!("cleanup-kill-failed:{error}"), None);
    }
    let wait_status = child.wait().map(|status| status.to_string()).ok();
    (reason.to_string(), wait_status)
}

// ============================================================================
// Windows 孤儿进程收割（T2 工单，2026-08-07）
//
// 根因：mac/linux 上「本进程正常退出」靠 SIGTERM/SIGKILL（`terminate_child`）
// 主动收 webServer；但真机孤儿（连续 3 代 msedgewebview2，最老存活 4 天）
// 来自**任务管理器"结束任务"/进程崩溃**——这类情况下本进程的任何清理代码
// 都不会跑，只能靠：
//   1. webServer(node.exe) 自己监听 stdin EOF 自杀（webServer.ts 已有，
//      `Command::stdin(Stdio::piped())` 保证父进程消失时子进程收到 EOF）；
//   2. WebView2 的浏览器/GPU/渲染子进程不是我们 `Command::spawn()` 出来的，
//      没有那根 stdin 管道，只能靠 WebView2 自己的心跳检测宿主存活——真机
//      证据说明这条心跳不可靠。
//
// 两条孤儿分走两条不同的认领路径，刻意不合并成一套：
//
// 1. **webServer(node.exe)** ——已有更强的现成机制：
//    `stale_web_server_port_holders`/`clear_stale_web_server_port`（此前
//    Windows 分支是永远返回空的 stub，本单补上 `netstat -ano` 实现）。
//    「谁占着我们的固定端口」是精确且不与其他槽冲突的身份证据，不需要
//    再造一套。**不**把 webServer 也塞进下面的 Job Object 认领文件——
//    "node.exe" 是极通用的运行时文件名（VS Code / 其他 Electron 应用都会
//    有一堆常驻 node.exe），pid 复用后镜像名照样能对上，用它当身份核对
//    形同虚设，反而可能错杀不相干的进程。
//
// 2. **WebView2 的浏览器/GPU/渲染子进程**不是我们 `Command::spawn()` 出来
//    的，没有 pid、没有端口，只能借 Job Object 只读枚举发现，收割语义
//    复用本仓已有的孤儿 PTY 收割模式
//    (`src/host/services/terminal/terminalSessionManager.ts:143-152`)：
//    落盘 {pid, ownerPid, 身份标记} + 启动时三道核对，不新造第二套语义：
//      a. ownerPid（记账时的宿主 Tauri 进程）现在必须已经死了——否则可能
//         是另一个仍在运行的实例正常持有的子进程，误杀等于砍别人正在用
//         的东西；
//      b. pid 现在报告的进程镜像名仍是 "msedgewebview2.exe"；
//      c. pid 现在的完整命令行仍带着记账时的 WebView2 数据目录
//         （`--user-data-dir=<路径>`，精确路径匹配，见
//         `command_line_contains_data_dir`）。**b 单独不够**："msedgewebview2.exe"
//         不是我们独有的进程名——Teams/Outlook/系统 Edge 的 WebView2 都用
//         同一个可执行文件，pid 被系统回收给别家应用（宿主重启后尤其常见）
//         时 a+b 会同时通过，必须靠 c 的绝对路径匹配排除。c 不是"按进程名
//         /cmdline 宽匹配"（错题本禁的是前缀式近似匹配，例如 `.dev` 撞上
//         `.dev2`）——数据目录是每个通道独有的绝对路径，`command_line_contains_data_dir`
//         要求路径后紧跟分隔符/引号/结尾，是精确边界匹配。
//    Job Object 本身：把本进程加入一个 Job，之后 CreateProcess 出的子孙
//    进程默认继承成员身份（Windows 8+ 支持嵌套 Job，WebView2 不会给自己
//    的子进程设 CREATE_BREAKAWAY_FROM_JOB），用
//    `QueryInformationJobObject` 只读枚举当前成员 pid 即可发现它们。
//    **特意不设 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE**：终止动作一律走上面
//    三道认领核对后的显式 taskkill，不依赖内核在本进程句柄关闭时自动杀光
//    整个 Job——那样会在「本进程正常退出但 webServer 优雅关库还没走完」的
//    窗口里（例如应用内更新触发的 restart），把 stdin-EOF 优雅关闭合同
//    截断，在本可以善终的场景里制造硬杀。
// ============================================================================

#[cfg(target_os = "windows")]
static WINDOWS_CONTAINMENT_JOB: std::sync::OnceLock<isize> = std::sync::OnceLock::new();

/// 把本进程加入一个匿名 Job（不设 KILL_ON_JOB_CLOSE），让之后本进程直接
/// 或间接 CreateProcess 出的子孙都继承 Job 成员身份，供 `enumerate_job_member_pids`
/// 只读枚举。必须在 Tauri 创建任何窗口/webServer 子进程之前完成，故在
/// `main()` 最开头调用。
#[cfg(target_os = "windows")]
fn install_windows_process_containment() {
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // SAFETY: 两个指针参数按 Win32 文档允许为 null（匿名、无安全属性的
    // Job）；AssignProcessToJobObject 的两个句柄都是本次调用刚拿到的有效
    // 句柄，GetCurrentProcess 返回的伪句柄无需关闭。
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!(
                "windows process containment: CreateJobObjectW failed ({})",
                std::io::Error::last_os_error()
            );
            return;
        }
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            eprintln!(
                "windows process containment: AssignProcessToJobObject failed ({})",
                std::io::Error::last_os_error()
            );
            return;
        }
        let _ = WINDOWS_CONTAINMENT_JOB.set(job as isize);
    }
    // job 句柄故意不关闭：随本进程退出被内核自动回收，回收本身不触发任何
    // 终止动作（没设 KILL_ON_JOB_CLOSE）。
}

#[cfg(not(target_os = "windows"))]
fn install_windows_process_containment() {}

/// 只读枚举当前 Job 成员 pid（含本进程自身）。查询失败/未曾成功加入 Job
/// 一律返回空——枚举只是发现孤儿候选的手段，不是收割判定本身，静默降级
/// 不会导致误杀，只会导致「这次没发现」。
#[cfg(target_os = "windows")]
fn enumerate_job_member_pids() -> Vec<u32> {
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    };

    let Some(&job_raw) = WINDOWS_CONTAINMENT_JOB.get() else {
        return Vec::new();
    };
    let job = job_raw as windows_sys::Win32::Foundation::HANDLE;

    // WebView2 + webServer 正常远小于 128 个子孙进程；一次性给够容量，
    // 容量不够时只是少枚举几个（NumberOfProcessIdsInList 会小于
    // NumberOfAssignedProcesses），不影响正确性只影响覆盖率。
    const MAX_TRACKED: usize = 128;
    let ids_offset = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
    let buffer_len = ids_offset + MAX_TRACKED * std::mem::size_of::<usize>();
    let mut buffer = vec![0u8; buffer_len];
    let mut returned_len: u32 = 0;

    // SAFETY: buffer 按「头部字段 + MAX_TRACKED 个尾随 pid 槽位」分配，size
    // 按整块缓冲区长度传入——这是 Win32 变长结构体（此处是
    // JOBOBJECT_BASIC_PROCESS_ID_LIST.ProcessIdList: [usize; 1] 的 C 变长
    // 数组惯用法）的标准调用方式。
    let ok = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicProcessIdList,
            buffer.as_mut_ptr() as *mut core::ffi::c_void,
            buffer_len as u32,
            &mut returned_len,
        )
    };
    if ok == 0 {
        return Vec::new();
    }

    // SAFETY: 调用成功后头部字段已被内核填充，count 已用 MAX_TRACKED 封顶，
    // 不会越界读 buffer。
    let header = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
    let count = (header.NumberOfProcessIdsInList as usize).min(MAX_TRACKED);

    let mut pids = Vec::with_capacity(count);
    let usize_len = std::mem::size_of::<usize>();
    for i in 0..count {
        let offset = ids_offset + i * usize_len;
        let mut raw = [0u8; std::mem::size_of::<usize>()];
        raw.copy_from_slice(&buffer[offset..offset + usize_len]);
        pids.push(usize::from_ne_bytes(raw) as u32);
    }
    pids
}

#[cfg(not(target_os = "windows"))]
fn enumerate_job_member_pids() -> Vec<u32> {
    Vec::new()
}

/// 一条落盘的「认领记录」：记账时的 pid + 进程镜像名 + 数据目录标记 +
/// 宿主进程 id。结构与 `terminalSessionManager.ts` 的 `PersistedTerminalPid`
/// 一一对应，只是多了 `data_dir`（见下方 `claimed_windows_orphans` 为什么
/// 需要它）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ClaimedWindowsProcess {
    pid: u32,
    /// 记账时这个 pid 报告的进程镜像名（如 "msedgewebview2.exe"）。
    image_name: String,
    /// 记账时本实例的 WebView2 数据目录（`app_local_data_dir()`，Tauri 强制
    /// 传给 WebView2 的 `--user-data-dir`）。收割时核对目标 pid 现在的完整
    /// 命令行是否仍带着这个路径——见下方为什么仅镜像名不够。
    data_dir: String,
    owner_pid: u32,
}

/// 纯函数：只按认领收割，三道核对缺一不可——喂伪进程清单即可单测，不摸
/// 文件系统/系统调用。
///   1. owner 必须已死（且不是当前进程自己）；
///   2. pid 现在的镜像名仍与记账时一致；
///   3. pid 现在的完整命令行仍带着记账时的数据目录路径。
///
/// **为什么镜像名不够、必须加第 3 道**："msedgewebview2.exe" 不是我们独有
/// 的进程名——Teams/Outlook/系统 Edge 的 WebView2 都用同一个可执行文件。
/// 一旦我们记账的 pid 被系统回收给别家应用的 msedgewebview2.exe（宿主重启
/// 后尤其常见），前两道核对（owner 已死 + 镜像名匹配）全部通过，会 taskkill
/// 别人家的进程。WebView2 子进程的命令行必带 `--user-data-dir=<路径>`，
/// 这是我们通道独有的绝对路径，用它做精确匹配（`command_line_contains_data_dir`
/// 要求路径后紧跟分隔符/引号/结尾，不是任意子串）——这不是"按进程名/cmdline
/// 宽匹配"（错题本禁止的是前缀式近似匹配，例如 `.dev` 撞上 `.dev2`），而是
/// 对一个绝对路径做精确边界匹配，是强判据。
fn claimed_windows_orphans(
    claims: &[ClaimedWindowsProcess],
    current_pid: u32,
    is_owner_alive: impl Fn(u32) -> bool,
    live_image_name: impl Fn(u32) -> Option<String>,
    live_command_line: impl Fn(u32) -> Option<String>,
) -> Vec<u32> {
    claims
        .iter()
        .filter(|claim| claim.owner_pid != current_pid && !is_owner_alive(claim.owner_pid))
        .filter(|claim| {
            live_image_name(claim.pid)
                .is_some_and(|name| name.eq_ignore_ascii_case(&claim.image_name))
        })
        .filter(|claim| {
            live_command_line(claim.pid)
                .is_some_and(|cmdline| command_line_contains_data_dir(&cmdline, &claim.data_dir))
        })
        .map(|claim| claim.pid)
        .collect()
}

/// `command_line` 里是否精确带着 `data_dir` 这个路径段——数据目录后面必须
/// 紧跟路径分隔符、引号或直接是命令行结尾，不能是任意前缀命中。防止
/// `...code-agent.dev` 被 `...code-agent.dev2` 这种前缀撞上（错题本：
/// pkill 前缀互相命中的同一类坑，这里换成了精确路径匹配版本）。
fn command_line_contains_data_dir(command_line: &str, data_dir: &str) -> bool {
    if data_dir.is_empty() {
        return false;
    }
    let mut search_from = 0;
    while let Some(offset) = command_line[search_from..].find(data_dir) {
        let match_start = search_from + offset;
        let match_end = match_start + data_dir.len();
        let boundary_ok = command_line[match_end..]
            .chars()
            .next()
            .map(|next_char| matches!(next_char, '\\' | '/' | '"' | '\'' | ' '))
            .unwrap_or(true); // 数据目录就是命令行的结尾
        if boundary_ok {
            return true;
        }
        search_from = match_start + 1;
    }
    false
}

/// 解析 `tasklist /FI "PID eq N" /FO CSV /NH` 的一行：
/// `"image.exe","1234","Console","1","1,234 K"`。字段两侧带引号；/FI 已经
/// 按 pid 过滤，直接取第一个字段去掉引号即可，不需要完整 CSV 语法解析器
/// （工作集字段本身含逗号，逐字段 `split(',')` 会切错，这也是不用它的
/// 原因）。
fn parse_tasklist_csv_image_name(output: &str, expected_pid: u32) -> Option<String> {
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split("\",\"");
        let image_name = fields.next()?.trim_start_matches('"');
        let pid_field = fields.next()?;
        if pid_field.parse::<u32>().ok()? == expected_pid {
            return Some(image_name.to_string());
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn windows_command_no_window(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// 查 pid 现在的镜像名；pid 不存在（已死）返回 None。
#[cfg(target_os = "windows")]
fn windows_tasklist_image_name(pid: u32) -> Option<String> {
    let output = windows_command_no_window("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_tasklist_csv_image_name(&String::from_utf8_lossy(&output.stdout), pid)
}

#[cfg(target_os = "windows")]
fn windows_process_is_alive(pid: u32) -> bool {
    windows_tasklist_image_name(pid).is_some()
}

/// 查 pid 现在的完整命令行。`tasklist` 不暴露 cmdline，这里改用
/// PowerShell 的 CIM（`Win32_Process.CommandLine`）——只在 webview2 第三道
/// 核对（数据目录精确匹配）里用，且只对已经通过前两道核对的少量候选 pid
/// 调用，不是批量扫描。pid 不存在/查询失败返回 None。
#[cfg(target_os = "windows")]
fn windows_process_command_line(pid: u32) -> Option<String> {
    let script = format!("(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine");
    let output = windows_command_no_window("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(target_os = "windows")]
fn claimed_processes_file_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(strip_verbatim_prefix)
        .map(|dir| dir.join("windows-process-claims.json"))
}

#[cfg(target_os = "windows")]
fn read_claimed_processes(path: &Path) -> Vec<ClaimedWindowsProcess> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn write_claimed_processes(path: &Path, claims: &[ClaimedWindowsProcess]) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(claims) {
        let _ = std::fs::write(path, json);
    }
}

/// 启动时调用：收割上一代崩溃/被强杀留下的 WebView2 子孙孤儿（webServer
/// 走独立的端口认领机制，见 `stale_web_server_port_holders`，不经过这条
/// 路径——理由见文件头注释）。三道核对见 `claimed_windows_orphans`。返回
/// 实际收割的 pid，供落 shell event。
#[cfg(target_os = "windows")]
fn reap_stale_windows_processes(app: &tauri::AppHandle) -> Vec<u32> {
    let Some(path) = claimed_processes_file_path(app) else {
        return Vec::new();
    };
    let claims = read_claimed_processes(&path);
    if claims.is_empty() {
        return Vec::new();
    }

    let current_pid = std::process::id();
    let reaped = claimed_windows_orphans(
        &claims,
        current_pid,
        windows_process_is_alive,
        windows_tasklist_image_name,
        windows_process_command_line,
    );

    for pid in &reaped {
        let _ = windows_command_no_window("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }

    // 收割过的从账上抹掉；没收割的（owner 还活着 / 身份对不上）原样留着，
    // 交给它们各自的下一次启动再核。
    let reaped_set: HashSet<u32> = reaped.iter().copied().collect();
    let survivors: Vec<ClaimedWindowsProcess> = claims
        .into_iter()
        .filter(|claim| !reaped_set.contains(&claim.pid))
        .collect();
    write_claimed_processes(&path, &survivors);

    reaped
}

#[cfg(not(target_os = "windows"))]
fn reap_stale_windows_processes(_app: &tauri::AppHandle) -> Vec<u32> {
    Vec::new()
}

/// renderer 首帧就绪后调用：WebView2 的浏览器/渲染子进程此时必已存在，借
/// Job Object 只读枚举把它们的 pid 落盘，供下次启动收割本次实例万一被
/// 强杀/崩溃后留下的孤儿。best-effort：任何一步失败都只是「这次没落到
/// 账」，不影响窗口正常展示。
///
/// **故意不收 webServer 的 pid**：它已经有一套更强的现成机制——
/// `stale_web_server_port_holders`/`clear_stale_web_server_port`（本单刚补
/// 上 Windows 分支）按「谁占着我们的固定端口」认领，端口号是精确且不会
/// 冲突的身份证据。webServer 走端口，WebView2 走 Job Object，两条认领路径
/// 分工明确，不重叠。
///
/// `data_dir` 用 `app_local_data_dir()`——Tauri 在 Windows/Linux 上强制把
/// 这个目录（`resolve(identifier, BaseDirectory::LocalData)`）当
/// `webview_attributes.data_directory` 传给 WebView2，也就是它每个子进程
/// 命令行里 `--user-data-dir=` 后面那串路径。用它而不是 `app_data_dir()`
/// （二者在 Windows 上分别是 Local/Roaming，不是同一个目录）。
#[cfg(target_os = "windows")]
fn capture_windows_process_claims(app: &tauri::AppHandle) {
    let Some(path) = claimed_processes_file_path(app) else {
        return;
    };
    let Some(data_dir) = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(strip_verbatim_prefix)
        .map(|dir| path_to_string(&dir))
    else {
        return;
    };
    let current_pid = std::process::id();

    let mut claims = Vec::new();
    for pid in enumerate_job_member_pids() {
        if pid == current_pid {
            continue;
        }
        if let Some(image_name) = windows_tasklist_image_name(pid) {
            claims.push(ClaimedWindowsProcess {
                pid,
                image_name,
                data_dir: data_dir.clone(),
                owner_pid: current_pid,
            });
        }
    }

    write_claimed_processes(&path, &claims);
}

#[cfg(not(target_os = "windows"))]
fn capture_windows_process_claims(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod windows_process_reap_tests {
    use super::{
        claimed_windows_orphans, command_line_contains_data_dir, parse_tasklist_csv_image_name,
        parse_windows_netstat_port_holders, ClaimedWindowsProcess,
    };

    const OUR_DATA_DIR: &str = r"C:\Users\x\AppData\Local\com.linchen.code-agent.dev";
    const OUR_CMDLINE: &str = r#""C:\Program Files\...\msedgewebview2.exe" --user-data-dir="C:\Users\x\AppData\Local\com.linchen.code-agent.dev\EBWebView""#;

    fn claim(pid: u32, image_name: &str, owner_pid: u32) -> ClaimedWindowsProcess {
        ClaimedWindowsProcess {
            pid,
            image_name: image_name.to_string(),
            data_dir: OUR_DATA_DIR.to_string(),
            owner_pid,
        }
    }

    #[test]
    fn reaps_only_when_all_three_gates_pass() {
        let claims = vec![claim(100, "msedgewebview2.exe", 1)];
        let reaped = claimed_windows_orphans(
            &claims,
            999,
            |_owner| false,
            |pid| (pid == 100).then(|| "msedgewebview2.exe".to_string()),
            |pid| (pid == 100).then(|| OUR_CMDLINE.to_string()),
        );
        assert_eq!(reaped, vec![100]);
    }

    #[test]
    fn skips_when_owner_still_alive() {
        // 另一个仍在运行的实例正常持有的子进程——即便镜像名/数据目录都
        // 匹配，owner 活着就说明这不是孤儿，绝不能杀。
        let claims = vec![claim(100, "msedgewebview2.exe", 1)];
        let reaped = claimed_windows_orphans(
            &claims,
            999,
            |_owner| true,
            |pid| (pid == 100).then(|| "msedgewebview2.exe".to_string()),
            |pid| (pid == 100).then(|| OUR_CMDLINE.to_string()),
        );
        assert!(reaped.is_empty());
    }

    #[test]
    fn skips_when_pid_reused_by_different_image() {
        // owner 已死，但 100 号 pid 现在是别的进程（系统复用）——身份核不
        // 对就不杀，宁可漏收也不能误杀。
        let claims = vec![claim(100, "msedgewebview2.exe", 1)];
        let reaped = claimed_windows_orphans(
            &claims,
            999,
            |_owner| false,
            |pid| (pid == 100).then(|| "unrelated-app.exe".to_string()),
            |pid| (pid == 100).then(|| OUR_CMDLINE.to_string()),
        );
        assert!(reaped.is_empty());
    }

    #[test]
    fn skips_when_pid_reused_by_a_different_apps_webview2() {
        // 红线场景：owner 已死、镜像名同样是 "msedgewebview2.exe"（Teams/
        // Outlook/系统 Edge 都用这个名字），但目标 pid 现在的命令行指向
        // 别家应用自己的数据目录——绝不能只凭镜像名就 taskkill。
        let claims = vec![claim(100, "msedgewebview2.exe", 1)];
        let other_apps_cmdline =
            r#""C:\Program Files\...\msedgewebview2.exe" --user-data-dir="C:\Users\x\AppData\Local\Microsoft\Teams\EBWebView""#;
        let reaped = claimed_windows_orphans(
            &claims,
            999,
            |_owner| false,
            |pid| (pid == 100).then(|| "msedgewebview2.exe".to_string()),
            |pid| (pid == 100).then(|| other_apps_cmdline.to_string()),
        );
        assert!(reaped.is_empty());
    }

    #[test]
    fn skips_when_command_line_unavailable() {
        // 查不到命令行（进程已死/查询失败）——和查不到镜像名一样，宁可
        // 漏收也不能杀。
        let claims = vec![claim(100, "msedgewebview2.exe", 1)];
        let reaped = claimed_windows_orphans(
            &claims,
            999,
            |_owner| false,
            |pid| (pid == 100).then(|| "msedgewebview2.exe".to_string()),
            |_pid| None,
        );
        assert!(reaped.is_empty());
    }

    #[test]
    fn skips_when_pid_no_longer_exists() {
        let claims = vec![claim(100, "msedgewebview2.exe", 1)];
        let reaped = claimed_windows_orphans(&claims, 999, |_owner| false, |_pid| None, |_pid| {
            None
        });
        assert!(reaped.is_empty());
    }

    #[test]
    fn skips_claims_owned_by_current_process() {
        // 记账的 owner 就是当前正在跑的这个实例自己——不是「上一代」，不
        // 该被 startup reap 碰。
        let claims = vec![claim(100, "msedgewebview2.exe", 999)];
        let reaped = claimed_windows_orphans(
            &claims,
            999,
            |_owner| false,
            |_pid| Some("msedgewebview2.exe".to_string()),
            |_pid| Some(OUR_CMDLINE.to_string()),
        );
        assert!(reaped.is_empty());
    }

    #[test]
    fn does_not_cross_slot_collide_on_owner_pid() {
        // 多个 claim 各自独立核对，互不影响——防止「一个 owner 判断污染
        // 另一条记录」这类合并逻辑错误。
        let claims = vec![
            claim(100, "msedgewebview2.exe", 1),
            claim(200, "msedgewebview2.exe", 2),
        ];
        let reaped = claimed_windows_orphans(
            &claims,
            999,
            |owner| owner == 2, // 只有 owner=2 还活着
            |pid| (pid == 100 || pid == 200).then(|| "msedgewebview2.exe".to_string()),
            |pid| (pid == 100 || pid == 200).then(|| OUR_CMDLINE.to_string()),
        );
        assert_eq!(reaped, vec![100]);
    }

    #[test]
    fn data_dir_boundary_match_ignores_prefix_collision() {
        // 错题本同款坑的精确路径版本："...code-agent.dev" 不能被
        // "...code-agent.dev2\EBWebView" 前缀命中——必须紧跟分隔符/引号/
        // 结尾才算命中。
        let dev_slot_1 = r"C:\Users\x\AppData\Local\com.linchen.code-agent.dev";
        let dev_slot_2_cmdline =
            r#"--user-data-dir="C:\Users\x\AppData\Local\com.linchen.code-agent.dev2\EBWebView""#;
        assert!(!command_line_contains_data_dir(
            dev_slot_2_cmdline,
            dev_slot_1
        ));

        let dev_slot_1_cmdline =
            r#"--user-data-dir="C:\Users\x\AppData\Local\com.linchen.code-agent.dev\EBWebView""#;
        assert!(command_line_contains_data_dir(
            dev_slot_1_cmdline,
            dev_slot_1
        ));
    }

    #[test]
    fn data_dir_match_rejects_empty_marker() {
        assert!(!command_line_contains_data_dir("anything at all", ""));
    }

    #[test]
    fn parses_tasklist_csv_image_name() {
        let output = "\"node.exe\",\"4242\",\"Console\",\"1\",\"12,345 K\"\r\n";
        assert_eq!(
            parse_tasklist_csv_image_name(output, 4242),
            Some("node.exe".to_string())
        );
    }

    #[test]
    fn tasklist_csv_returns_none_for_other_pid() {
        let output = "\"node.exe\",\"4242\",\"Console\",\"1\",\"12,345 K\"\r\n";
        assert_eq!(parse_tasklist_csv_image_name(output, 1), None);
    }

    #[test]
    fn tasklist_csv_handles_empty_output() {
        assert_eq!(parse_tasklist_csv_image_name("", 4242), None);
    }

    #[test]
    fn netstat_finds_listener_on_matching_port() {
        let output = "\
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:8180           0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:8180         127.0.0.1:55000        ESTABLISHED     4242
";
        assert_eq!(
            parse_windows_netstat_port_holders(output, 8180, 999),
            vec![4242]
        );
    }

    #[test]
    fn netstat_ignores_client_connections_to_the_port() {
        // 客户端连到我们端口的连接：本地地址是临时端口、外部地址才是
        // 8180——不该被当成「持有端口」的进程。
        let output = "  TCP    127.0.0.1:55321        127.0.0.1:8180         ESTABLISHED     1111\n";
        assert!(parse_windows_netstat_port_holders(output, 8180, 999).is_empty());
    }

    #[test]
    fn netstat_excludes_current_process_and_dedupes() {
        let output = "\
  TCP    0.0.0.0:8180           0.0.0.0:0              LISTENING       999
  TCP    0.0.0.0:8180           0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:8180         127.0.0.1:1           ESTABLISHED     4242
";
        assert_eq!(
            parse_windows_netstat_port_holders(output, 8180, 999),
            vec![4242]
        );
    }

    #[test]
    fn netstat_does_not_confuse_similar_port_prefixes() {
        // 8180 与 18180、81800 不能互相命中——ends_with 的冒号前缀已经
        // 保证这点，这里钉一条回归测试。
        let output = "\
  TCP    0.0.0.0:18180          0.0.0.0:0              LISTENING       1
  TCP    0.0.0.0:81800          0.0.0.0:0              LISTENING       2
";
        assert!(parse_windows_netstat_port_holders(output, 8180, 999).is_empty());
    }
}

// 本地档，不是 CI 门（`.github/workflows/` 全仓 grep `cargo test` 零命中）。
// unix-only：起真子进程验编排，Windows 分支的 stdin-EOF 行为只有 static-contract 档证据。
#[cfg(all(test, unix))]
mod terminate_child_tests {
    use super::terminate_child;
    use std::process::{Command, Stdio};
    use std::{thread, time::Duration};

    /// 让 shell 有时间跑到 `trap` 那一行再发信号，否则会跟「装 trap」赛跑：
    /// SIGTERM 在 trap 生效前打到默认处理上，把 ignore 场景误判成 graceful。
    fn let_shell_install_trap() {
        thread::sleep(Duration::from_millis(100));
    }

    #[test]
    fn sigterm_handled_by_child_reports_graceful() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("trap 'exit 0' TERM; while :; do sleep 0.1; done")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn trap-TERM test child");
        let_shell_install_trap();

        let (exit_reason, wait_status) = terminate_child(&mut child);

        assert_eq!(exit_reason, "graceful-sigterm");
        assert!(wait_status.is_some());
    }

    #[test]
    fn sigterm_ignored_by_child_falls_back_to_forced_kill() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("trap '' TERM; while :; do sleep 0.1; done")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn trap-ignore test child");
        let_shell_install_trap();

        let (exit_reason, wait_status) = terminate_child(&mut child);

        assert_eq!(exit_reason, "forced-sigkill-timeout");
        assert!(wait_status.is_some());
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

// Windows 的 resource_dir()/current_exe() 常返回 `\\?\C:\...` 扩展长度（verbatim）路径。
// 这种前缀传给 bundled node.exe 当主脚本/cwd 时，node 的模块解析会把盘符 `C:`
// 抠出来 lstat → `EISDIR: illegal operation on a directory, lstat 'C:'`，webServer
// 启动即崩、app 秒退（真机实测，Windows Server 2019 + node v24）。把它规整成普通
// `C:\...` 路径再交给 node。非 Windows 为恒等（macOS 路径无此前缀，零影响）。
#[cfg(target_os = "windows")]
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p
}

#[cfg(not(target_os = "windows"))]
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    p
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
        // strip_verbatim_prefix: Windows 上去掉 `\\?\` 前缀（见函数注释）。
        let resource_dir = strip_verbatim_prefix(resource_dir);
        packaged_roots.push(resource_dir.join("_up_"));
        packaged_roots.push(resource_dir.clone());

        if let Some(parent) = resource_dir.parent() {
            packaged_roots.push(parent.to_path_buf());
        }
    }

    if let Ok(exe_path) = env::current_exe() {
        let exe_path = strip_verbatim_prefix(exe_path);
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
        // release 只信任 bundle 内资源。dev_roots = 编译机的 CARGO_MANIFEST_DIR
        // 源码路径 + 运行时 cwd，在用户机器上要么不存在、要么不可信：fallback 到
        // 它们只会加载版本不匹配的旧副本（白屏）或用户可控目录里的代码。bundle
        // 缺失时宁可走 Layer 3 启动失败弹窗，也不 fallback 到 dev 路径。
        let _ = dev_roots;
        roots.extend(packaged_roots);
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

fn web_server_log_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(strip_verbatim_prefix)
        .map(|dir| dir.join("logs"))
}

fn now_millis_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn parse_port_holder_pids(output: &str, current_pid: u32) -> Vec<u32> {
    let mut seen = HashSet::new();
    output
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .filter(|pid| *pid != current_pid)
        .filter(|pid| seen.insert(*pid))
        .collect()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn stale_web_server_port_holders(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}")])
        .output()
        .map_err(|error| format!("Failed to inspect localhost:{port}: {error}"))?;

    if !output.status.success() && output.stdout.is_empty() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_port_holder_pids(&stdout, std::process::id()))
}

/// 解析 `netstat -ano -p TCP` 的一行，取「本地地址」端口等于 `port` 的行
/// 的 PID（最后一个空白分隔字段——TCP 行末尾就是 PID）。只匹配本地地址
/// 端口，天然排除只是「连到这个端口」的客户端连接（它们的本地地址端口
/// 是临时端口，不等于 `port`）；不依赖 State 列的 LISTENING 文案，规避
/// 非英文 Windows 下该文案被本地化导致的漏判。
fn parse_windows_netstat_port_holders(output: &str, port: u16, current_pid: u32) -> Vec<u32> {
    let port_suffix = format!(":{port}");
    let mut seen = HashSet::new();
    output
        .lines()
        .map(str::trim)
        .filter(|line| line.len() >= 3 && line[..3].eq_ignore_ascii_case("tcp"))
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let _proto = fields.next()?;
            let local_addr = fields.next()?;
            if !local_addr.ends_with(&port_suffix) {
                return None;
            }
            fields.last()?.parse::<u32>().ok()
        })
        .filter(|pid| *pid != current_pid)
        .filter(|pid| seen.insert(*pid))
        .collect()
}

/// Windows 版 `stale_web_server_port_holders`：mac/linux 用 lsof，Windows
/// 没有 lsof，改用系统自带的 netstat（此前该函数在 Windows 上是永远返回
/// 空的 stub，等于「打包启动前清理上一代残留 webServer」这道保险在
/// Windows 上完全没生效——T2 工单排查项之一）。
#[cfg(target_os = "windows")]
fn stale_web_server_port_holders(port: u16) -> Result<Vec<u32>, String> {
    let output = windows_command_no_window("netstat")
        .args(["-ano", "-p", "TCP"])
        .output()
        .map_err(|error| format!("Failed to inspect localhost:{port}: {error}"))?;

    if !output.status.success() && output.stdout.is_empty() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_windows_netstat_port_holders(
        &stdout,
        port,
        std::process::id(),
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn stale_web_server_port_holders(_port: u16) -> Result<Vec<u32>, String> {
    Ok(Vec::new())
}

fn clear_stale_web_server_port(port: u16) -> Result<Vec<u32>, String> {
    let pids = stale_web_server_port_holders(port)?;
    if pids.is_empty() {
        return Ok(pids);
    }

    for pid in &pids {
        #[cfg(target_os = "windows")]
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();

        #[cfg(not(target_os = "windows"))]
        let status = Command::new("kill").args(["-9", &pid.to_string()]).status();

        match status {
            Ok(status) if status.success() => {}
            Ok(status) => {
                return Err(format!(
                    "Failed to clear stale webServer process {pid}: exit status {status}"
                ));
            }
            Err(error) => {
                return Err(format!(
                    "Failed to clear stale webServer process {pid}: {error}"
                ));
            }
        }
    }

    thread::sleep(Duration::from_millis(300));
    Ok(pids)
}

fn boot_diagnostics_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    web_server_log_dir(app).map(|dir| dir.join(BOOT_DIAGNOSTICS_FILE))
}

fn shell_events_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    web_server_log_dir(app).map(|dir| dir.join(SHELL_EVENTS_FILE))
}

fn token_fingerprint(token: &str) -> String {
    let mut hasher = DefaultHasher::new();
    token.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn desktop_shell_channel(bundle_id: Option<&str>, is_debug: bool) -> &'static str {
    if is_debug || bundle_id.is_some_and(|id| dev_slot(id).is_some()) {
        "dev"
    } else {
        "prod"
    }
}

fn desktop_shell_event_payload(
    diagnostics: &DesktopShellBootDiagnostics,
    level: &str,
    event: &str,
    message: &str,
    details: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "schemaVersion": 1,
        "source": "tauri-shell",
        "generatedAt": now_millis_string(),
        "level": level,
        "event": event,
        "stage": diagnostics.stage,
        "appVersion": diagnostics.app_version,
        "bundleId": diagnostics.bundle_id,
        "channel": desktop_shell_channel(diagnostics.bundle_id.as_deref(), cfg!(debug_assertions)),
        "pid": diagnostics.pid,
        "webPort": diagnostics.web_port,
        "message": message,
    });

    if let Some(object) = payload.as_object_mut() {
        if let Some(boot_id) = diagnostics.boot_id.as_deref() {
            object.insert("bootId".to_string(), serde_json::json!(boot_id));
            object.insert("sessionId".to_string(), serde_json::json!(boot_id));
        }
        if let Some(web_server_pid) = diagnostics.web_server_pid {
            object.insert(
                "webServerPid".to_string(),
                serde_json::json!(web_server_pid),
            );
        }
        if let Some(details) = details {
            object.insert("details".to_string(), details);
        }
    }

    payload
}

fn append_shell_event_payload(app: &tauri::AppHandle, payload: serde_json::Value) {
    let json = match serde_json::to_string(&payload) {
        Ok(json) => json,
        Err(_) => return,
    };
    eprintln!("{json}");

    let Some(path) = shell_events_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{json}");
    }
}

fn write_shell_event(
    app: &tauri::AppHandle,
    diagnostics: &DesktopShellBootDiagnostics,
    level: &str,
    event: &str,
    message: &str,
    details: Option<serde_json::Value>,
) {
    append_shell_event_payload(
        app,
        desktop_shell_event_payload(diagnostics, level, event, message, details),
    );
}

fn write_process_cleanup_event(app: &tauri::AppHandle, cleanup: DesktopShellProcessCleanup) {
    append_shell_event_payload(
        app,
        serde_json::json!({
            "schemaVersion": 1,
            "source": "tauri-shell",
            "generatedAt": cleanup.cleaned_at,
            "level": "info",
            "event": "desktop-shell-process-cleanup",
            "appVersion": app.config().version,
            "bundleId": app.config().identifier,
            "channel": desktop_shell_channel(Some(&app.config().identifier), cfg!(debug_assertions)),
            "pid": std::process::id(),
            "webPort": web_port(),
            "message": "webServer child cleaned up during Tauri exit",
            "process": {
                "owner": cleanup.owner,
                "role": "webServer",
                "pid": cleanup.pid,
                "startedAt": cleanup.started_at,
                "exitReason": cleanup.exit_reason,
                "waitStatus": cleanup.wait_status,
                "stdinEofCleanup": cleanup.stdin_eof_cleanup,
            }
        }),
    );
}

fn desktop_shell_boot_stage_from_value(value: &serde_json::Value) -> Option<DesktopShellBootStage> {
    serde_json::from_value(value.clone()).ok()
}

fn first_desktop_shell_issue(
    value: &serde_json::Value,
) -> (Option<String>, Option<String>, Option<String>) {
    let Some(issue) = value
        .get("issues")
        .and_then(|issues| issues.as_array())
        .and_then(|issues| issues.first())
    else {
        return (None, None, None);
    };

    (
        issue
            .get("code")
            .and_then(|code| code.as_str())
            .map(str::to_string),
        issue
            .get("message")
            .and_then(|message| message.as_str())
            .map(str::to_string),
        issue
            .get("action")
            .and_then(|action| action.as_str())
            .map(str::to_string),
    )
}

fn previous_boot_failure_from_value(
    value: &serde_json::Value,
) -> Option<DesktopShellPreviousFailure> {
    if value.get("schemaVersion").and_then(|schema| schema.as_u64()) != Some(1) {
        return None;
    }
    let recorded_stage = value
        .get("stage")
        .and_then(desktop_shell_boot_stage_from_value)?;
    if recorded_stage == DesktopShellBootStage::WindowNavigated {
        return None;
    }

    let failed_stage = value
        .get("failedStage")
        .and_then(desktop_shell_boot_stage_from_value);
    let stage = failed_stage
        .clone()
        .unwrap_or_else(|| recorded_stage.clone());
    let (code, message, action) = first_desktop_shell_issue(value);

    Some(DesktopShellPreviousFailure {
        stage,
        recorded_stage: Some(recorded_stage),
        generated_at: value
            .get("generatedAt")
            .and_then(|generated_at| generated_at.as_str())
            .map(str::to_string),
        code: code.or_else(|| {
            Some("desktop-shell-previous-boot-incomplete".to_string())
        }),
        message: message.or_else(|| {
            Some("Previous desktop shell launch did not reach renderer navigation.".to_string())
        }),
        action,
        diagnostic_file: value
            .get("diagnosticFile")
            .and_then(|diagnostic_file| diagnostic_file.as_str())
            .map(str::to_string),
        web_port: value
            .get("webPort")
            .and_then(|web_port| web_port.as_u64())
            .and_then(|web_port| u16::try_from(web_port).ok()),
        web_server_pid: value
            .get("webServerPid")
            .and_then(|web_server_pid| web_server_pid.as_u64())
            .and_then(|web_server_pid| u32::try_from(web_server_pid).ok()),
    })
}

fn read_previous_boot_failure(app: &tauri::AppHandle) -> Option<DesktopShellPreviousFailure> {
    let path = boot_diagnostics_path(app)?;
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    previous_boot_failure_from_value(&value)
}

fn new_boot_diagnostics(app: &tauri::AppHandle) -> DesktopShellBootDiagnostics {
    let previous_failure = read_previous_boot_failure(app);
    DesktopShellBootDiagnostics {
        schema_version: 1,
        generated_at: now_millis_string(),
        app_version: app.config().version.clone(),
        bundle_id: Some(app.config().identifier.clone()),
        pid: std::process::id(),
        web_port: web_port(),
        stage: DesktopShellBootStage::ChannelEnvApplied,
        failed_stage: None,
        health_url: health_url(),
        boot_id: None,
        web_server_pid: None,
        server_root: None,
        script_path: None,
        node_binary: None,
        health_matched_boot_token: None,
        diagnostic_file: boot_diagnostics_path(app).map(|path| path_to_string(&path)),
        previous_failure,
        resources: Vec::new(),
        issues: Vec::new(),
    }
}

fn write_boot_diagnostics(app: &tauri::AppHandle, diagnostics: &DesktopShellBootDiagnostics) {
    let Some(path) = boot_diagnostics_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(diagnostics) {
        let _ = std::fs::write(path, json);
    }
}

fn record_boot_stage(
    app: &tauri::AppHandle,
    diagnostics: &mut DesktopShellBootDiagnostics,
    stage: DesktopShellBootStage,
) {
    diagnostics.stage = stage;
    diagnostics.generated_at = now_millis_string();
    write_boot_diagnostics(app, diagnostics);
    write_shell_event(
        app,
        diagnostics,
        "info",
        "desktop-shell-boot-stage",
        "desktop shell boot stage advanced",
        Some(serde_json::json!({
            "stage": diagnostics.stage,
            "webServerPid": diagnostics.web_server_pid,
            "healthMatchedBootToken": diagnostics.health_matched_boot_token,
        })),
    );
}

fn record_boot_failure(
    app: &tauri::AppHandle,
    diagnostics: &mut DesktopShellBootDiagnostics,
    code: &str,
    message: &str,
) {
    diagnostics.failed_stage = Some(diagnostics.stage.clone());
    diagnostics.stage = DesktopShellBootStage::Failed;
    diagnostics.generated_at = now_millis_string();
    diagnostics.issues.push(DesktopShellIssue {
        severity: "error".to_string(),
        code: code.to_string(),
        message: message.to_string(),
        action: Some("检查桌面包 resources 与 webServer 启动日志".to_string()),
    });
    write_boot_diagnostics(app, diagnostics);
    write_shell_event(
        app,
        diagnostics,
        "error",
        "desktop-shell-boot-failed",
        message,
        Some(serde_json::json!({ "code": code })),
    );
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.is_file() && (metadata.permissions().mode() & 0o111) != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn resource_status(path: &Path, executable: bool) -> DesktopShellResourceStatus {
    if !path.is_file() {
        return DesktopShellResourceStatus::Missing;
    }
    if executable && !is_executable_file(path) {
        return DesktopShellResourceStatus::NotExecutable;
    }
    DesktopShellResourceStatus::Present
}

fn resource_check(
    id: &str,
    label: &str,
    kind: DesktopShellResourceKind,
    path: PathBuf,
    required: bool,
    executable: bool,
) -> DesktopShellResourceCheck {
    let status = resource_status(&path, executable);
    let message = match status {
        DesktopShellResourceStatus::Present => None,
        DesktopShellResourceStatus::Missing => {
            Some("resource missing from packaged bundle".to_string())
        }
        DesktopShellResourceStatus::NotExecutable => {
            Some("resource exists but is not executable".to_string())
        }
    };
    DesktopShellResourceCheck {
        id: id.to_string(),
        label: label.to_string(),
        kind,
        path: path_to_string(&path),
        required,
        status,
        message,
    }
}

fn desktop_shell_resource_preflight(
    root: &Path,
    resource_dir: Option<&Path>,
) -> Vec<DesktopShellResourceCheck> {
    let bundled_node = resolve_bundled_node_binary(root, resource_dir).unwrap_or_else(|| {
        bundled_node_candidates(root, resource_dir)
            .into_iter()
            .next()
            .unwrap_or_else(|| {
                root.join("dist")
                    .join("bundled-node")
                    .join("bin")
                    .join("node")
            })
    });

    vec![
        resource_check(
            "web-server-script",
            "webServer bundle",
            DesktopShellResourceKind::WebServer,
            root.join("dist").join("web").join("webServer.cjs"),
            true,
            false,
        ),
        resource_check(
            "renderer-index",
            "builtin renderer index",
            DesktopShellResourceKind::Renderer,
            root.join("dist").join("renderer").join("index.html"),
            true,
            false,
        ),
        resource_check(
            "bundled-node",
            "bundled Node",
            DesktopShellResourceKind::Runtime,
            bundled_node,
            true,
            true,
        ),
        resource_check(
            "control-plane-public-keys",
            "control-plane public keys",
            DesktopShellResourceKind::Resource,
            root.join("dist")
                .join("web")
                .join("control-plane-public-keys.json"),
            false,
            false,
        ),
        resource_check(
            "better-sqlite3-native",
            "better-sqlite3 native module",
            DesktopShellResourceKind::NativeModule,
            root.join("dist")
                .join("native")
                .join("better-sqlite3")
                .join("build")
                .join("Release")
                .join("better_sqlite3.node"),
            true,
            false,
        ),
    ]
}

fn required_resource_failures(
    resources: &[DesktopShellResourceCheck],
) -> Vec<&DesktopShellResourceCheck> {
    resources
        .iter()
        .filter(|resource| {
            resource.required && resource.status != DesktopShellResourceStatus::Present
        })
        .collect()
}

fn web_server_node_env() -> &'static str {
    if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    }
}

/// 测试/开发通道的数据目录名（槽 1），与生产 `.code-agent` 并存、互不污染。
/// 槽 N>1 在其后追加槽号：`.code-agent-dev2`…
const DEV_DATA_DIR_NAME: &str = ".code-agent-dev";
/// dev 槽位上限，与 src/shared/devSlot.ts 的 MAX_DEV_SLOT 一致。
const MAX_DEV_SLOT: u16 = 9;

/// 从 bundle identifier 反推 dev 槽位号：`.dev` = 1，`.dev2`…`.dev9` = 2…9，非 dev 返回 None。
///
/// 只认严格形态。`.developer` / `.dev-old` / `.dev0` / `.dev02` 一律**不算** dev 通道——
/// 这里判错的代价不是少个端口，是测试包直接写进生产数据目录 `~/.code-agent`。
///
/// TS 侧同源实现在 src/shared/devSlot.ts 的 devSlotFromBundleId()，两边必须一起改。
fn dev_slot(identifier: &str) -> Option<u16> {
    let digits = &identifier[identifier.rfind(".dev")? + ".dev".len()..];
    if digits.is_empty() {
        return Some(1);
    }
    if digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let slot = digits.parse::<u16>().ok()?;
    (1..=MAX_DEV_SLOT).contains(&slot).then_some(slot)
}

/// 根据 bundle identifier 与构建 profile 推导测试/开发通道的数据目录。
/// identifier 带 `.dev[N]` 后缀（打包测试包）走对应槽位，debug 构建（`cargo tauri dev`，
/// identifier 仍是生产值）按槽 1 处理。
/// 返回 `Some(dir)` 表示应把 `CODE_AGENT_DATA_DIR` 设为该目录；`None` 表示沿用生产默认。
fn dev_channel_data_dir(identifier: &str, is_debug: bool, home: Option<&Path>) -> Option<PathBuf> {
    let slot = dev_slot(identifier).or(if is_debug { Some(1) } else { None })?;
    let name = if slot == 1 {
        DEV_DATA_DIR_NAME.to_string()
    } else {
        format!("{DEV_DATA_DIR_NAME}{slot}")
    };
    Some(home?.join(name))
}

/// webServer 监听端口：**只按 `.dev[N]` identifier 切到 8180+N**（打包测试包，与生产 8180
/// 以及彼此并存可同时运行）。`cargo tauri dev` 虽是 dev 数据通道，但 devUrl 与
/// beforeDevCommand 起的 webServer 固定 8180，故端口仍走 8180，避免调试态白屏。
fn channel_web_port(identifier: &str) -> u16 {
    match dev_slot(identifier) {
        Some(slot) => PROD_WEB_PORT + slot,
        None => PROD_WEB_PORT,
    }
}

/// 当前进程实际使用的 webServer 端口：读 apply_channel_env 注入的 `CODE_AGENT_WEB_PORT`，
/// 缺省退回生产端口。SERVER_URL / HEALTH_URL / 错误提示 / spawn 都以此为唯一真源。
fn web_port() -> u16 {
    env::var("CODE_AGENT_WEB_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(PROD_WEB_PORT)
}

fn server_url() -> String {
    format!("http://localhost:{}", web_port())
}

fn health_url() -> String {
    format!("{}/api/health", server_url())
}

/// 在 spawn webServer 之前，按运行通道把数据目录、端口与 bundle id 落到进程 env：
/// - `CODE_AGENT_WEB_PORT`：测试包 8181，生产 8180；随 `.envs()` 传给 webServer（读 WEB_PORT），
///   也是 Rust 端 server_url / health_url / 错误提示的唯一真源，保证两包同时运行不抢端口。
/// - `CODE_AGENT_DATA_DIR`：未显式设置且处于 dev 数据通道时切到 `.code-agent-dev`，
///   随 `.envs()` 传给 node 子进程，原生 appshots / native_desktop 也读它。
/// - `CODE_AGENT_BUNDLE_ID`：暴露真实 bundle id，让麦克风 / 截图逻辑不误读生产包的授权。
fn apply_channel_env(app: &tauri::AppHandle) {
    let identifier = app.config().identifier.clone();
    if env::var_os("CODE_AGENT_BUNDLE_ID").is_none() {
        env::set_var("CODE_AGENT_BUNDLE_ID", &identifier);
    }
    if env::var_os("CODE_AGENT_WEB_PORT").is_none() {
        env::set_var(
            "CODE_AGENT_WEB_PORT",
            channel_web_port(&identifier).to_string(),
        );
    }
    if env::var_os("CODE_AGENT_DATA_DIR").is_some() {
        return; // 已显式指定（含打包测试包），尊重不覆盖
    }
    let home = env::var_os("HOME").map(PathBuf::from);
    if let Some(dir) = dev_channel_data_dir(&identifier, cfg!(debug_assertions), home.as_deref()) {
        eprintln!(
            "[channel] dev/test build ({identifier}) → CODE_AGENT_DATA_DIR={}",
            dir.display()
        );
        env::set_var("CODE_AGENT_DATA_DIR", dir);
    }
}

fn is_server_running() -> bool {
    let client = match Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    matches!(client.get(health_url()).send(), Ok(resp) if resp.status().as_u16() == 200)
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
    #[cfg(target_os = "windows")]
    let candidates = [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files (x86)\\nodejs\\node.exe",
    ];
    #[cfg(not(target_os = "windows"))]
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

fn spawn_web_server_recording(
    app: &tauri::AppHandle,
    diagnostics: &mut DesktopShellBootDiagnostics,
) -> Result<(Child, String), String> {
    if !cfg!(debug_assertions) {
        match clear_stale_web_server_port(web_port()) {
            Ok(pids) if !pids.is_empty() => {
                write_shell_event(
                    app,
                    diagnostics,
                    "warning",
                    "desktop-shell-stale-port-cleaned",
                    "cleared stale webServer process(es) before packaged launch",
                    Some(serde_json::json!({
                        "port": web_port(),
                        "pids": pids,
                    })),
                );
            }
            Ok(_) => {}
            Err(error) => {
                write_shell_event(
                    app,
                    diagnostics,
                    "warning",
                    "desktop-shell-stale-port-cleanup-failed",
                    &error,
                    Some(serde_json::json!({
                        "port": web_port(),
                    })),
                );
            }
        }
    }

    let (script_path, working_dir) = resolve_server_script(app)?;
    diagnostics.script_path = Some(path_to_string(&script_path));
    diagnostics.server_root = Some(path_to_string(&working_dir));
    record_boot_stage(
        app,
        diagnostics,
        DesktopShellBootStage::ServerScriptResolved,
    );

    let boot_token = make_boot_token();
    diagnostics.boot_id = Some(token_fingerprint(&boot_token));
    // Windows: 去掉 `\\?\` 前缀，否则 node 解析脚本路径崩在 lstat 'C:'（见 strip_verbatim_prefix）。
    // script_path/working_dir 来自 candidate_roots（已规整）；此处规整 node 解析另用的 resource_dir。
    let resource_dir = app.path().resource_dir().ok().map(strip_verbatim_prefix);
    let node_binary = resolve_node_binary(&working_dir, resource_dir.as_deref());
    diagnostics.node_binary = Some(path_to_string(&node_binary));
    record_boot_stage(app, diagnostics, DesktopShellBootStage::NodeBinaryResolved);

    diagnostics.resources = desktop_shell_resource_preflight(&working_dir, resource_dir.as_deref());
    record_boot_stage(app, diagnostics, DesktopShellBootStage::ResourcePreflight);
    let required_failures = required_resource_failures(&diagnostics.resources);
    if !cfg!(debug_assertions) && !required_failures.is_empty() {
        let details = required_failures
            .iter()
            .map(|resource| format!("{} ({})", resource.label, resource.path))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "Desktop shell resource preflight failed: missing or unusable required resource(s): {details}"
        ));
    }

    // 显式继承父进程 env，让 launchctl setenv / shell 注入的 HTTPS_PROXY 等变量
    // 流到 webServer 的 Node 进程。Rust Command 默认就继承父 env，但写出来更明确。
    let mut command = Command::new(&node_binary);
    // Windows GUI app 拉起 console 子进程默认弹出黑窗，CREATE_NO_WINDOW 抑制
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .arg(&script_path)
        .current_dir(&working_dir)
        .envs(env::vars())
        .env("CODE_AGENT_TAURI_BOOT_TOKEN", &boot_token)
        .env("NODE_ENV", web_server_node_env())
        // 测试包用 8181、生产 8180，保证两包同时运行不抢端口（webServer 读 WEB_PORT）
        .env("WEB_PORT", web_port().to_string())
        // stdin 用 pipe：本进程死亡（含 panic/SIGABRT）时管道关闭，
        // webServer 监听 stdin EOF 自杀，不留孤儿进程占住端口
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    for (key, value) in web_server_runtime_env(&working_dir, resource_dir.as_deref()) {
        command.env(key, value.as_os_str());
    }
    if let Some(boot_path) = boot_diagnostics_path(app) {
        command.env(BOOT_DIAGNOSTICS_PATH_ENV, boot_path.as_os_str());
    }

    let child = command.spawn().map_err(|error| {
        format!(
            "Failed to start web server at {} (node: {}): {}",
            script_path.display(),
            node_binary.display(),
            error
        )
    })?;
    diagnostics.web_server_pid = Some(child.id());
    write_shell_event(
        app,
        diagnostics,
        "info",
        "desktop-shell-process-started",
        "webServer child process spawned",
        Some(serde_json::json!({
            "process": {
                "owner": "tauri-shell",
                "role": "webServer",
                "pid": child.id(),
                "stdinEofCleanup": true,
            }
        })),
    );
    record_boot_stage(app, diagnostics, DesktopShellBootStage::WebServerSpawned);

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
    let mut saw_boot_token_mismatch = false;

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

        match client.get(health_url()).send() {
            Ok(response) if response.status().as_u16() == 200 => {
                let body = response.text().unwrap_or_default();
                if health_matches_boot_token(&body, expected_boot_token) {
                    return Ok(());
                }
                saw_boot_token_mismatch = true;
                thread::sleep(HEALTH_INTERVAL);
            }
            Ok(_) | Err(_) => thread::sleep(HEALTH_INTERVAL),
        }
    }

    if saw_boot_token_mismatch {
        return Err(format!(
            "Timed out after {}s waiting for {} with matching boot token",
            HEALTH_TIMEOUT.as_secs(),
            health_url()
        ));
    }

    Err(format!(
        "Timed out after {}s waiting for {}",
        HEALTH_TIMEOUT.as_secs(),
        health_url()
    ))
}

/// spawn webServer 并等待健康检查通过。失败时清理子进程，并对"端口被占"场景
/// 给出可操作的错误信息（而不是裸超时）。
fn start_web_server_recording(
    app: &tauri::AppHandle,
    diagnostics: &mut DesktopShellBootDiagnostics,
) -> Result<Child, String> {
    let (mut child, boot_token) = spawn_web_server_recording(app, diagnostics)?;
    if let Err(error) = wait_for_healthcheck(&mut child, Some(&boot_token)) {
        diagnostics.health_matched_boot_token = Some(false);
        let _ = child.kill();
        let _ = child.wait();
        if is_server_running() {
            let message = format!(
                "端口 {} 被其他进程占用，Agent Neo 无法启动自己的服务。\n\
                 请退出占用端口的程序（或重启电脑）后重试。\n\n原始错误: {error}",
                web_port()
            );
            record_boot_failure(app, diagnostics, "desktop-shell-port-occupied", &message);
            return Err(message);
        }
        record_boot_failure(app, diagnostics, "desktop-shell-healthcheck-failed", &error);
        return Err(error);
    }
    diagnostics.health_matched_boot_token = Some(true);
    record_boot_stage(app, diagnostics, DesktopShellBootStage::HealthReady);
    Ok(child)
}

fn start_web_server(app: &tauri::AppHandle) -> Result<Child, String> {
    let mut diagnostics = new_boot_diagnostics(app);
    write_boot_diagnostics(app, &diagnostics);
    start_web_server_recording(app, &mut diagnostics)
}

/// 每次启动唯一的 boot URL：HTTP 缓存按完整 URL（含 query）做 key，
/// 全新 query 保证 WKWebView 永远不会用历史缓存的 index.html 当启动文档
/// （旧页带旧 token / 旧资源引用 / 旧 bundle 元数据，会触发前端自愈 reload，
/// 用户看到"启动连刷几下"）。服务端 SPA fallback 忽略 query，路由不受影响。
fn boot_server_url() -> String {
    let boot_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}/?boot={boot_ms}", server_url())
}

fn renderer_navigation_failure_message(error: &str) -> String {
    format!("Renderer navigation failed after webServer healthcheck: {error}")
}

/// 僵尸实例自愈：主窗口已销毁时重建窗口并导航到 webServer；
/// webServer 已死则先重新拉起。保证用户双击图标永远能得到一个窗口。
fn recreate_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    if !is_server_running() {
        let child = start_web_server(app)?;
        app.state::<AppState>().store_child(child);
    }

    let url = boot_server_url()
        .parse::<tauri::Url>()
        .map_err(|error| format!("Invalid server URL: {error}"))?;

    // 与 tauri.conf.json 的 main window 配置保持一致
    let window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
        .title("Agent Neo")
        .inner_size(1200.0, 800.0)
        .min_inner_size(960.0, 640.0)
        .disable_drag_drop_handler()
        .build()
        .map_err(|error| format!("Failed to rebuild main window: {error}"))?;

    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// 启动失败时弹原生错误框告知用户，代替裸 panic（SIGABRT 闪退无提示）。
///
/// 注意：此函数在 Tauri setup hook 阶段调用，此时 NSApplication 事件循环尚未
/// 启动，tauri-plugin-dialog 的 blocking_show 无法呈现 modal（会静默失败）。
/// 改用 osascript 拉起独立的原生 alert 进程，不依赖宿主事件循环，确保用户
/// 一定能看到提示而不是无声闪退。
fn show_startup_failure(error: &str, diagnostic_file: Option<&str>) {
    let message = match diagnostic_file {
        Some(path) => format!("{error}\n\n诊断文件: {path}"),
        None => error.to_string(),
    };
    eprintln!("Startup failure: {message}");
    // AppleScript 字符串转义：反斜杠、双引号、换行
    let safe = message
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ");
    let script = format!("display alert \"Agent Neo 启动失败\" message \"{safe}\" as critical");
    let _ = Command::new("osascript").arg("-e").arg(&script).status();
}

fn cleanup_server(app: &tauri::AppHandle) {
    if let Some(cleanup) = app.state::<AppState>().cleanup() {
        write_process_cleanup_event(app, cleanup);
    }
}

/// 更新安装前显式优雅停 webServer。
///
/// 为什么需要它：Windows 上 tauri-plugin-updater 的 install 在 crate 内部
/// ShellExecuteW 起 NSIS 之后直接 std::process::exit(0)（tauri-plugin-updater-2.10.1
/// updater.rs:865），控制流永不返回 → 渲染器的 relaunch() 执行不到 → RunEvent::Exit
/// 不会来 → cleanup_server 一次都不跑（2026-08-07 Windows 真机：该次启动的
/// webServerPid 在 desktop-shell-events.ndjson 里没有 cleanup 记录）。插件的 JS 路径
/// 也没有入口覆盖它的 on_before_exit。所以只能由渲染器在 install 之前显式调这一下。
///
/// 幂等：AppState::cleanup() 是 take() 语义，之后 RunEvent::Exit 再调一次是 no-op。
/// mac 上这一步同样会跑（此后 relaunch 走 request_restart，cleanup 已被 take，无副作用）。
#[tauri::command]
fn shutdown_web_server_for_update(app: tauri::AppHandle) {
    cleanup_server(&app);
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
    /// true 表示这次检查本身失败了（native + cloud 两条路径都没拿到结果），
    /// 用来和"权威确认已是最新"(has_update=false, check_failed=false)区分开，
    /// 避免把网络/服务失败误报成"已是最新版本"。
    #[serde(default)]
    check_failed: bool,
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
        check_failed: false,
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

fn no_update_info(current_version: String) -> TauriUpdateInfo {
    TauriUpdateInfo {
        has_update: false,
        check_failed: false,
        current_version,
        latest_version: None,
        release_notes: None,
        date: None,
        force_update: None,
        download_url: None,
        file_size: None,
        sha256: None,
    }
}

/// 这次检查彻底失败（native + cloud 都没拿到结果）时返回，
/// has_update=false 但 check_failed=true，让 UI 显示"检查失败"而不是"已是最新"。
fn check_failed_info(current_version: String) -> TauriUpdateInfo {
    TauriUpdateInfo {
        has_update: false,
        check_failed: true,
        current_version,
        latest_version: None,
        release_notes: None,
        date: None,
        force_update: None,
        download_url: None,
        file_size: None,
        sha256: None,
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
            check_failed: false,
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
            check_failed: false,
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

// NOTE: 渲染器是从 remote origin(localhost:8180) 加载的，Tauri 2 ACL 不会把 app 自定义命令
// 授权给 remote，所以这个命令在打包态实际不被渲染器调用（更新走 tauri-updater 插件 JS API）。
// 保留它用于本地(tauri://)模式 / CLI / 测试，逻辑仍区分"检查失败"与"已是最新"。
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<TauriUpdateInfo, String> {
    let current_version = get_app_version(app.clone());
    // native 成功且确认有更新 → 直接返回（权威）。
    // native 成功但无更新 → 它已权威确认"已是最新"，即便后面 cloud 失败也不算检查失败。
    // native 失败 → 记 native_failed，只有当 cloud 也失败时才报"检查失败"。
    let (fallback_info, native_failed) =
        match check_native_update(app, current_version.clone()).await {
            Ok(info) if info.has_update => return Ok(info),
            Ok(info) => (info, false),
            Err(error) => {
                eprintln!("Native update check failed, trying cloud update: {error}");
                (no_update_info(current_version.clone()), true)
            }
        };

    // 两条路径都没拿到结果时，返回 check_failed 而不是把失败伪装成"已是最新"。
    let on_cloud_failure = || {
        if native_failed {
            check_failed_info(current_version.clone())
        } else {
            fallback_info.clone()
        }
    };

    let cloud_version = current_version.clone();
    match tauri::async_runtime::spawn_blocking(move || check_cloud_update(cloud_version)).await {
        Ok(Ok(info)) => Ok(info),
        Ok(Err(error)) => {
            eprintln!("Cloud update check failed: {error}");
            Ok(on_cloud_failure())
        }
        Err(error) => {
            eprintln!("Cloud update check task failed: {error}");
            Ok(on_cloud_failure())
        }
    }
}

/// 真实数据目录，镜像 webServerBootstrap.cjs 的 resolveCompileCacheDir：
/// 显式 CODE_AGENT_DATA_DIR（dev/test 通道）优先，否则 HOME/.code-agent。restart 后真启动
/// 的 cache/DB 都在这里。
fn real_data_dir() -> Option<PathBuf> {
    if let Some(dir) = env::var_os("CODE_AGENT_DATA_DIR") {
        Some(PathBuf::from(dir))
    } else {
        let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"))?;
        Some(PathBuf::from(home).join(".code-agent"))
    }
}

/// C1：更新落盘后、restart 前预热新 bundle 的 V8 compile cache。
/// 用隔离临时数据目录跑 warmup（DB/migration 等副作用落临时目录，绝不碰仍在运行的旧进程的
/// 活库），但把 compile cache 写到真实位置 → restart 后首启命中直接 warm（省 ~2.9s 冷编译）。
/// **best-effort + 超时兜底**：spawn 失败/超时/新 bundle 未就位一律吞掉，绝不阻塞 app.restart()；
/// 最坏退化为今日的冷首启。
fn warm_compile_cache_before_restart(app: &tauri::AppHandle) {
    // 观测 warmup 全程 ~2-4s；20s 给 5x 余量兜慢机，同时把「卡住拖慢 restart」的最坏惩罚封顶。
    const WARMUP_TIMEOUT: Duration = Duration::from_secs(20);
    let Some(real_data) = real_data_dir() else {
        return;
    };
    let real_cache_dir = real_data.join("cache").join("v8-compile-cache");
    let real_db = real_data.join("code-agent.db");
    let Ok((script_path, working_dir)) = resolve_server_script(app) else {
        return;
    };
    let resource_dir = app.path().resource_dir().ok().map(strip_verbatim_prefix);
    let node_binary = resolve_node_binary(&working_dir, resource_dir.as_deref());

    // 隔离临时数据目录：warmup 的副作用（真库快照 + 全量 migration）落这里，用完删除。
    let temp_dir = env::temp_dir().join(format!("agentneo-compile-warmup-{}", std::process::id()));
    if std::fs::create_dir_all(&temp_dir).is_err() {
        return;
    }

    let mut command = Command::new(&node_binary);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .arg(&script_path)
        .current_dir(&working_dir)
        .envs(env::vars())
        .env("CODE_AGENT_COMPILE_WARMUP", "1")
        .env("CODE_AGENT_DATA_DIR", &temp_dir)
        .env("CODE_AGENT_COMPILE_CACHE_DIR", &real_cache_dir)
        .env("CODE_AGENT_E2E", "1")
        .env("CODE_AGENT_RENDERER_HOT_UPDATE", "false")
        .env("NODE_ENV", web_server_node_env())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // 喂真库只读快照，让 warmup 跑真实会话查询路径（V8 才编译那些函数；空库预热几乎无效）。
    if real_db.exists() {
        command.env("CODE_AGENT_WARMUP_SEED_DB", &real_db);
    }
    for (key, value) in web_server_runtime_env(&working_dir, resource_dir.as_deref()) {
        command.env(key, value.as_os_str());
    }

    let started = Instant::now();
    if let Ok(mut child) = command.spawn() {
        let deadline = started + WARMUP_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
        eprintln!(
            "[updater] compile-cache warmup finished in {:?}",
            started.elapsed()
        );
    }
    let _ = std::fs::remove_dir_all(&temp_dir);
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
                    eprintln!(
                        "[updater] download started, total size: {:?}",
                        content_length
                    );
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

    // C1：restart 前预热新 bundle 的 compile cache，让更新后首启直接 warm（best-effort，
    // 失败/超时不阻塞 restart）。此时新 .app 已落盘，resolve_server_script 指向新 bundle。
    warm_compile_cache_before_restart(&app);

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
        bundled_node_candidates, channel_web_port, desktop_shell_channel,
        desktop_shell_event_payload, desktop_shell_resource_preflight, dev_channel_data_dir,
        dev_slot, parse_port_holder_pids, previous_boot_failure_from_value,
        renderer_navigation_failure_message,
        required_resource_failures, web_server_node_env, web_server_runtime_env,
        DesktopShellBootDiagnostics, DesktopShellBootStage, DesktopShellResourceStatus,
        BUNDLED_RUNTIME_ROOT_ENV, DEV_WEB_PORT, PROD_WEB_PORT, RESOURCE_DIR_ENV,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(prefix: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!("{prefix}-{id}"));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, content).expect("write test file");
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("chmod");
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

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
    fn dev_channel_dir_routes_test_builds_to_sibling_dir() {
        let home = PathBuf::from("/Users/x");
        // 打包测试包：identifier 以 .dev 结尾（release 构建）→ 切到 .code-agent-dev
        assert_eq!(
            dev_channel_data_dir("com.linchen.code-agent.dev", false, Some(&home)),
            Some(PathBuf::from("/Users/x/.code-agent-dev"))
        );
        // 开发调试：debug 构建（cargo tauri dev），identifier 仍是生产值 → 也切到 dev
        assert_eq!(
            dev_channel_data_dir("com.linchen.code-agent", true, Some(&home)),
            Some(PathBuf::from("/Users/x/.code-agent-dev"))
        );
        // 生产包：release + 非 .dev → 不切（沿用 ~/.code-agent）
        assert_eq!(
            dev_channel_data_dir("com.linchen.code-agent", false, Some(&home)),
            None
        );
        // 无 HOME → None（不 panic）
        assert_eq!(
            dev_channel_data_dir("com.linchen.code-agent.dev", false, None),
            None
        );
        // 槽 2：数据目录带槽号，与槽 1 / 生产三方并存
        assert_eq!(
            dev_channel_data_dir("com.linchen.code-agent.dev2", false, Some(&home)),
            Some(PathBuf::from("/Users/x/.code-agent-dev2"))
        );
        assert_eq!(
            dev_channel_data_dir("com.linchen.code-agent.dev9", false, Some(&home)),
            Some(PathBuf::from("/Users/x/.code-agent-dev9"))
        );
    }

    #[test]
    fn dev_slot_only_accepts_strict_suffixes() {
        // `.dev` = 槽 1（历史形态），`.devN` = 槽 N
        assert_eq!(dev_slot("com.linchen.code-agent.dev"), Some(1));
        assert_eq!(dev_slot("com.linchen.code-agent.dev1"), Some(1));
        assert_eq!(dev_slot("com.linchen.code-agent.dev9"), Some(9));
        // 生产 identifier 不是 dev
        assert_eq!(dev_slot("com.linchen.code-agent"), None);
        // 近似形态一律拒绝——判错的代价是测试包写进生产数据目录
        assert_eq!(dev_slot("com.linchen.code-agent.developer"), None);
        assert_eq!(dev_slot("com.linchen.code-agent.dev-old"), None);
        assert_eq!(dev_slot("com.linchen.code-agent.dev0"), None);
        assert_eq!(dev_slot("com.linchen.code-agent.dev02"), None);
        // 越界槽号拒绝，不静默开一套新数据目录
        assert_eq!(dev_slot("com.linchen.code-agent.dev10"), None);
    }

    #[test]
    fn channel_web_port_only_splits_on_dev_identifier() {
        // 打包测试包（.dev）→ 8181，与生产 8180 并存可同时运行
        assert_eq!(channel_web_port("com.linchen.code-agent.dev"), DEV_WEB_PORT);
        // 槽 N → 8180+N，槽之间也不抢端口
        assert_eq!(
            channel_web_port("com.linchen.code-agent.dev2"),
            PROD_WEB_PORT + 2
        );
        assert_eq!(
            channel_web_port("com.linchen.code-agent.dev9"),
            PROD_WEB_PORT + 9
        );
        // 生产包 → 8180
        assert_eq!(channel_web_port("com.linchen.code-agent"), PROD_WEB_PORT);
        // 非严格 dev 后缀退回生产端口（与 dev_slot 判据一致）
        assert_eq!(
            channel_web_port("com.linchen.code-agent.developer"),
            PROD_WEB_PORT
        );
        // 注意：端口不按 debug 切——cargo tauri dev 用生产 identifier，仍走 8180
        // 以匹配 devUrl 与 beforeDevCommand 起的 webServer，避免白屏。
    }

    #[test]
    fn web_server_node_env_matches_build_profile() {
        #[cfg(debug_assertions)]
        assert_eq!(web_server_node_env(), "development");

        #[cfg(not(debug_assertions))]
        assert_eq!(web_server_node_env(), "production");
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

    #[test]
    fn desktop_shell_preflight_marks_missing_required_resources() {
        let root = temp_root("agent-shell-preflight-missing");
        let resources = desktop_shell_resource_preflight(&root, None);
        let failures = required_resource_failures(&resources);

        assert!(failures
            .iter()
            .any(|resource| resource.id == "web-server-script"));
        assert!(failures
            .iter()
            .any(|resource| resource.id == "renderer-index"));
        assert!(failures
            .iter()
            .any(|resource| resource.id == "bundled-node"));
        assert!(failures
            .iter()
            .any(|resource| resource.id == "better-sqlite3-native"));

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn desktop_shell_preflight_accepts_required_packaged_resources() {
        let root = temp_root("agent-shell-preflight-ok");
        write_file(
            &root.join("dist").join("web").join("webServer.cjs"),
            "console.log('ok')",
        );
        write_file(
            &root.join("dist").join("renderer").join("index.html"),
            "<html></html>",
        );
        let node = root
            .join("dist")
            .join("bundled-node")
            .join("bin")
            .join("node");
        write_file(&node, "#!/usr/bin/env node\n");
        make_executable(&node);
        write_file(
            &root
                .join("dist")
                .join("native")
                .join("better-sqlite3")
                .join("build")
                .join("Release")
                .join("better_sqlite3.node"),
            "native",
        );

        let resources = desktop_shell_resource_preflight(&root, None);
        assert!(required_resource_failures(&resources).is_empty());
        assert_eq!(
            resources
                .iter()
                .find(|resource| resource.id == "bundled-node")
                .map(|resource| &resource.status),
            Some(&DesktopShellResourceStatus::Present)
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn desktop_shell_channel_splits_dev_and_prod() {
        assert_eq!(
            desktop_shell_channel(Some("com.linchen.code-agent.dev"), false),
            "dev"
        );
        assert_eq!(
            desktop_shell_channel(Some("com.linchen.code-agent"), false),
            "prod"
        );
        assert_eq!(
            desktop_shell_channel(Some("com.linchen.code-agent"), true),
            "dev"
        );
    }

    #[test]
    fn desktop_shell_event_payload_is_structured_without_raw_boot_token() {
        let diagnostics = DesktopShellBootDiagnostics {
            schema_version: 1,
            generated_at: "1".to_string(),
            app_version: Some("0.16.102".to_string()),
            bundle_id: Some("com.linchen.code-agent.dev".to_string()),
            pid: 100,
            web_port: DEV_WEB_PORT,
            stage: DesktopShellBootStage::HealthReady,
            failed_stage: None,
            health_url: "http://localhost:8181/api/health".to_string(),
            boot_id: Some("boot-fingerprint".to_string()),
            web_server_pid: Some(200),
            server_root: None,
            script_path: None,
            node_binary: None,
            health_matched_boot_token: Some(true),
            diagnostic_file: None,
            previous_failure: None,
            resources: Vec::new(),
            issues: Vec::new(),
        };

        let payload = desktop_shell_event_payload(
            &diagnostics,
            "info",
            "desktop-shell-boot-stage",
            "boot stage advanced",
            Some(serde_json::json!({
                "rawToken": "[redacted]",
                "process": { "owner": "tauri-shell", "pid": 200, "stdinEofCleanup": true }
            })),
        );

        assert_eq!(payload["schemaVersion"], 1);
        assert_eq!(payload["source"], "tauri-shell");
        assert_eq!(payload["bootId"], "boot-fingerprint");
        assert_eq!(payload["sessionId"], "boot-fingerprint");
        assert_eq!(payload["webServerPid"], 200);
        assert_eq!(payload["details"]["process"]["owner"], "tauri-shell");
        assert!(!payload.to_string().contains("tauri-secret-token"));
    }

    #[test]
    fn renderer_navigation_failure_message_names_renderer_boundary() {
        assert_eq!(
            renderer_navigation_failure_message("invalid boot URL"),
            "Renderer navigation failed after webServer healthcheck: invalid boot URL"
        );
    }

    #[test]
    fn previous_boot_failure_keeps_failed_stage_for_next_launch() {
        let value = serde_json::json!({
            "schemaVersion": 1,
            "generatedAt": "123",
            "webPort": DEV_WEB_PORT,
            "stage": "failed",
            "failedStage": "web-server-spawned",
            "webServerPid": 456,
            "diagnosticFile": "/tmp/desktop-shell-boot-latest.json",
            "issues": [{
                "severity": "error",
                "code": "desktop-shell-healthcheck-failed",
                "message": "healthcheck timed out",
                "action": "check logs"
            }]
        });

        let failure = previous_boot_failure_from_value(&value).expect("failure");

        assert_eq!(failure.stage, DesktopShellBootStage::WebServerSpawned);
        assert_eq!(failure.recorded_stage, Some(DesktopShellBootStage::Failed));
        assert_eq!(
            failure.code,
            Some("desktop-shell-healthcheck-failed".to_string())
        );
        assert_eq!(failure.web_server_pid, Some(456));
    }

    #[test]
    fn previous_boot_failure_ignores_successful_launch() {
        let value = serde_json::json!({
            "schemaVersion": 1,
            "generatedAt": "123",
            "webPort": DEV_WEB_PORT,
            "stage": "window-navigated"
        });

        assert!(previous_boot_failure_from_value(&value).is_none());
    }

    #[test]
    fn parse_port_holder_pids_filters_current_invalid_and_duplicates() {
        let current_pid = 42;
        let pids = parse_port_holder_pids("41\n42\nnot-a-pid\n41\n43\n", current_pid);

        assert_eq!(pids, vec![41, 43]);
    }
}

#[cfg(test)]
mod update_url_tests {
    use super::{
        check_failed_info, cloud_update_info_from_response, compare_update_versions,
        github_release_page_from_download_url, health_matches_boot_token, no_update_info,
        normalize_manual_update_url, sanitize_release_channel, validate_update_url,
        CloudUpdateResponse,
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

    #[test]
    fn treats_older_cloud_latest_as_no_update() {
        let info = cloud_update_info_from_response(
            CloudUpdateResponse {
                success: Some(true),
                has_update: Some(false),
                force_update: Some(false),
                current_version: Some("0.16.82".to_string()),
                latest_version: Some("0.16.80".to_string()),
                min_version: None,
                download_url: Some(
                    "https://github.com/owner/repo/releases/download/v0.16.80/Code.Agent.dmg"
                        .to_string(),
                ),
                sha256: Some("b".repeat(64)),
                release_notes: Some("older published latest".to_string()),
                file_size: Some(123),
                published_at: Some("2026-05-22T00:00:00Z".to_string()),
            },
            "0.16.82".to_string(),
        );

        assert!(!info.has_update);
        assert_eq!(info.current_version, "0.16.82");
        assert_eq!(info.latest_version, Some("0.16.80".to_string()));
    }

    #[test]
    fn builds_stable_no_update_fallback() {
        let info = no_update_info("0.16.82".to_string());

        assert!(!info.has_update);
        assert!(!info.check_failed);
        assert_eq!(info.current_version, "0.16.82");
        assert_eq!(info.latest_version, None);
        assert_eq!(info.download_url, None);
    }

    #[test]
    fn check_failed_info_is_distinct_from_up_to_date() {
        let failed = check_failed_info("0.16.91".to_string());
        assert!(!failed.has_update);
        assert!(failed.check_failed);
        assert_eq!(failed.current_version, "0.16.91");

        // 权威确认"已是最新"必须 check_failed=false，不能和检查失败混淆。
        let up_to_date = no_update_info("0.16.91".to_string());
        assert!(!up_to_date.has_update);
        assert!(!up_to_date.check_failed);
    }

    #[test]
    fn health_token_match_detects_stale_or_wrong_web_server() {
        assert!(health_matches_boot_token(
            r#"{"status":"ok","tauriBootToken":"boot-1"}"#,
            Some("boot-1")
        ));
        assert!(!health_matches_boot_token(
            r#"{"status":"ok","tauriBootToken":"boot-2"}"#,
            Some("boot-1")
        ));
        assert!(!health_matches_boot_token(
            r#"{"status":"ok"}"#,
            Some("boot-1")
        ));
        assert!(health_matches_boot_token(r#"{"status":"ok"}"#, None));
    }
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .text("quick_ask", "快速提问")
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
                "quick_ask" => {
                    activate_window(app_handle);
                    app_handle.emit("memo:activate", ()).ok();
                }
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

fn request_main_window_focus(app_handle: &AppHandle) -> bool {
    if let Some(win) = app_handle.get_webview_window("main") {
        return win.show().is_ok() && win.unminimize().is_ok() && win.set_focus().is_ok();
    }

    false
}

fn main_window_is_ready(app_handle: &AppHandle) -> bool {
    let Some(win) = app_handle.get_webview_window("main") else {
        return false;
    };
    matches!(win.is_visible(), Ok(true))
        && matches!(win.is_minimized(), Ok(false))
        && matches!(win.is_focused(), Ok(true))
}

fn wait_for_main_window_focus(app_handle: &AppHandle) -> bool {
    for delay_ms in GLOBAL_HOTKEY_FOCUS_RETRY_DELAYS_MS {
        if *delay_ms > 0 {
            thread::sleep(Duration::from_millis(*delay_ms));
        }
        if main_window_is_ready(app_handle) {
            return true;
        }
    }
    false
}

fn toggle_main_window(app_handle: &AppHandle) {
    if let Some(win) = app_handle.get_webview_window("main") {
        let is_visible = win.is_visible().unwrap_or(false);
        if is_visible {
            win.hide().ok();
        } else {
            win.show().ok();
            win.unminimize().ok();
            win.set_focus().ok();
        }
    }
}

fn unregister_configurable_global_hotkeys(app_handle: &AppHandle, state: &KeybindingHotkeysState) {
    let previous = {
        let mut guard = state
            .registered
            .lock()
            .expect("keybinding hotkeys mutex poisoned");
        std::mem::take(&mut *guard)
    };

    for accelerator in previous {
        if let Err(error) = app_handle
            .global_shortcut()
            .unregister(accelerator.as_str())
        {
            eprintln!("Failed to unregister keybinding hotkey {accelerator}: {error}");
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobalHotkeyWindowAction {
    Toggle,
    Focus,
    FocusBeforeEmit,
    None,
}

fn global_hotkey_window_action(action_id: &str) -> GlobalHotkeyWindowAction {
    match action_id {
        "app.toggle" => GlobalHotkeyWindowAction::Toggle,
        "app.quickAsk" | "session.new" => GlobalHotkeyWindowAction::Focus,
        "voice.callToggle" => GlobalHotkeyWindowAction::FocusBeforeEmit,
        _ => GlobalHotkeyWindowAction::None,
    }
}

fn write_global_hotkey_registration_event(app: &AppHandle, result: &KeybindingGlobalHotkeyResult) {
    let registered = result.registered;
    append_shell_event_payload(
        app,
        serde_json::json!({
            "schemaVersion": 1,
            "source": "tauri-shell",
            "generatedAt": now_millis_string(),
            "level": if registered { "info" } else { "error" },
            "event": "desktop-shell-global-hotkey-registration",
            "message": if registered {
                "global hotkey registered"
            } else {
                "global hotkey registration failed"
            },
            "appVersion": app.config().version,
            "bundleId": app.config().identifier,
            "channel": desktop_shell_channel(Some(&app.config().identifier), cfg!(debug_assertions)),
            "actionId": result.action_id,
            "accelerator": result.accelerator,
            "registered": registered,
            "error": result.error,
        }),
    );
}

fn write_global_hotkey_suppressed_event(
    app: &AppHandle,
    action_id: &str,
    accelerator: &str,
    reason: &str,
) {
    append_shell_event_payload(
        app,
        serde_json::json!({
            "schemaVersion": 1,
            "source": "tauri-shell",
            "generatedAt": now_millis_string(),
            "level": "warn",
            "event": "desktop-shell-global-hotkey-suppressed",
            "message": "global hotkey action suppressed before emit",
            "appVersion": app.config().version,
            "bundleId": app.config().identifier,
            "channel": desktop_shell_channel(Some(&app.config().identifier), cfg!(debug_assertions)),
            "actionId": action_id,
            "accelerator": accelerator,
            "reason": reason,
        }),
    );
}

fn write_global_hotkey_focus_timeout_event(app: &AppHandle, action_id: &str, accelerator: &str) {
    append_shell_event_payload(
        app,
        serde_json::json!({
            "schemaVersion": 1,
            "source": "tauri-shell",
            "generatedAt": now_millis_string(),
            "level": "warn",
            "event": "desktop-shell-global-hotkey-focus-timeout",
            "message": "main window focus confirmation timed out; emitting global hotkey",
            "appVersion": app.config().version,
            "bundleId": app.config().identifier,
            "channel": desktop_shell_channel(Some(&app.config().identifier), cfg!(debug_assertions)),
            "actionId": action_id,
            "accelerator": accelerator,
            "emitted": true,
            "focusReady": false,
        }),
    );
}

fn emit_global_hotkey_event(app: &AppHandle, action_id: &str, accelerator: &str) {
    if let Err(error) = app.emit(
        "keybindings:global_hotkey",
        KeybindingGlobalHotkeyEvent {
            action_id: action_id.to_string(),
            accelerator: accelerator.to_string(),
        },
    ) {
        append_shell_event_payload(
            app,
            serde_json::json!({
                "schemaVersion": 1,
                "source": "tauri-shell",
                "generatedAt": now_millis_string(),
                "level": "error",
                "event": "desktop-shell-global-hotkey-emit-failed",
                "message": "failed to emit global hotkey action",
                "appVersion": app.config().version,
                "bundleId": app.config().identifier,
                "channel": desktop_shell_channel(Some(&app.config().identifier), cfg!(debug_assertions)),
                "actionId": action_id,
                "accelerator": accelerator,
                "error": error.to_string(),
            }),
        );
    }
}

/// 把三颗红绿灯摆到与顶行图标同轴（中心 24）。macOS 在 `show()` 与窗口重排时会按系统默认位
/// 复位它们，所以这不是"设一次"的事——show / resize / focus 之后都要重放。摆法幂等，重放无副作用。
fn align_traffic_lights(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window("main") {
        let window_for_main_thread = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ptr) = window_for_main_thread.ns_window() {
                unsafe { traffic_lights::align_traffic_lights(ptr) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// 主窗首次呈现：show + focus + 摆灯。三条 show 路径（invoke 命令 / renderer-ready 事件 /
/// 超时兜底）共用它，别再各写各的——摆灯漏在哪条路径上，就是那条路径赢跑时灯回默认位。
///
/// 摆灯必须**重复断言**：`show()` 返回只代表请求已发出，AppKit 随后还会在自己的排版节拍里
/// 把三颗灯按默认位重排一遍，紧跟其后的那次同步摆会被它盖掉。2026-07-27 实测：只摆一次时
/// 灯留在系统默认的中心 16；此前一次"看起来成了"，是因为手动前置窗口撞上了 Focused 重放
/// ——典型的竞态假绿。摆法是幂等的绝对定位，所以这里在随后几拍里再断言几次；
/// 这是对 AppKit 排版时机的补偿，有界（总计约 2s 内结束），不是轮询。
///
/// `via` 记录三条路径谁先到并写进 shell 事件流：invoke 通道被 ACL 拒掉时会静默降级成
/// 超时兜底，肉眼只看到"窗口慢了两秒"，没有这行日志无法从外部分辨渲染器→壳的 invoke
/// 到底通不通（2026-07-30 原生 AEC ACL 事故就是这么潜伏下来的）。
fn present_main_window(app: &AppHandle, via: &str) {
    append_shell_event_payload(
        app,
        serde_json::json!({
            "schemaVersion": 1,
            "source": "tauri-shell",
            "generatedAt": now_millis_string(),
            "level": "info",
            "event": "desktop-shell-window-presented",
            "message": "main window presented",
            "appVersion": app.config().version,
            "bundleId": app.config().identifier,
            "channel": desktop_shell_channel(Some(&app.config().identifier), cfg!(debug_assertions)),
            "presentedVia": via,
        }),
    );
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    align_traffic_lights(app);
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        thread::spawn(move || {
            for delay_ms in [60u64, 140, 400, 1000] {
                thread::sleep(Duration::from_millis(delay_ms));
                align_traffic_lights(&app);
            }
        });
    }
    // T2 工单：首帧就绪意味着 WebView2 的浏览器/渲染子进程此时必已存在，
    // 借这个时机把它们的 pid 落盘认领，供下次启动收割本次实例万一被强杀/
    // 崩溃后留下的孤儿（webServer 走独立的端口认领机制，不落这个文件，
    // 见 `capture_windows_process_claims` 注释）。放后台线程：涉及若干次
    // tasklist 子进程调用，不能挡在窗口展示的关键路径上。
    #[cfg(target_os = "windows")]
    {
        let app = app.clone();
        thread::spawn(move || {
            capture_windows_process_claims(&app);
        });
    }
}

/// renderer 首帧+初始数据就绪信号的 invoke 直连通道。
/// emit 事件通道在打包态投递不到壳侧(window.once/app.once 均收不到,根因未明),
/// invoke command 不走事件路由,可靠;事件监听与超时兜底仍保留,共用 AtomicBool 去重。
struct RendererReadyShown(Arc<AtomicBool>);

#[tauri::command]
fn renderer_ready(app: AppHandle, state: State<'_, RendererReadyShown>) {
    if !state.0.swap(true, std::sync::atomic::Ordering::SeqCst) {
        present_main_window(&app, "invoke-command");
    }
}

#[tauri::command]
fn keybindings_set_global_hotkeys(
    app: AppHandle,
    state: State<'_, KeybindingHotkeysState>,
    bindings: Vec<KeybindingGlobalHotkeyInput>,
) -> Vec<KeybindingGlobalHotkeyResult> {
    unregister_configurable_global_hotkeys(&app, state.inner());

    let mut registered = Vec::new();
    let mut results = Vec::new();

    for binding in bindings {
        let action_id = binding.action_id.trim().to_string();
        let accelerator = binding.accelerator.trim().to_string();

        if action_id.is_empty() || accelerator.is_empty() {
            let result = KeybindingGlobalHotkeyResult {
                action_id,
                accelerator,
                registered: false,
                error: Some("Missing actionId or accelerator".to_string()),
            };
            write_global_hotkey_registration_event(&app, &result);
            results.push(result);
            continue;
        }

        let event_action_id = action_id.clone();
        let event_accelerator = accelerator.clone();
        let register_result = app.global_shortcut().on_shortcut(
            accelerator.as_str(),
            move |app_handle, _shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }

                match global_hotkey_window_action(event_action_id.as_str()) {
                    GlobalHotkeyWindowAction::Toggle => toggle_main_window(app_handle),
                    GlobalHotkeyWindowAction::Focus => {
                        let _ = request_main_window_focus(app_handle);
                    }
                    GlobalHotkeyWindowAction::FocusBeforeEmit => {
                        // macOS 首次麦克风权限弹窗跟随前台窗口。show、unminimize、set_focus
                        // 先发出请求，再在有界窗口内等待 Window Server 的异步状态回写。
                        // 同步读回失败只代表激活尚未完成，不能把拨号 action 静默吞掉。
                        let app_handle = app_handle.clone();
                        let action_id = event_action_id.clone();
                        let accelerator = event_accelerator.clone();
                        thread::spawn(move || {
                            if !request_main_window_focus(&app_handle) {
                                write_global_hotkey_suppressed_event(
                                    &app_handle,
                                    &action_id,
                                    &accelerator,
                                    "focus_request_failed",
                                );
                                return;
                            }

                            if !wait_for_main_window_focus(&app_handle) {
                                write_global_hotkey_focus_timeout_event(
                                    &app_handle,
                                    &action_id,
                                    &accelerator,
                                );
                            }

                            emit_global_hotkey_event(&app_handle, &action_id, &accelerator);
                        });
                        return;
                    }
                    GlobalHotkeyWindowAction::None => {}
                }

                emit_global_hotkey_event(app_handle, &event_action_id, &event_accelerator);
            },
        );

        match register_result {
            Ok(()) => {
                registered.push(accelerator.clone());
                let result = KeybindingGlobalHotkeyResult {
                    action_id,
                    accelerator,
                    registered: true,
                    error: None,
                };
                write_global_hotkey_registration_event(&app, &result);
                results.push(result);
            }
            Err(error) => {
                let result = KeybindingGlobalHotkeyResult {
                    action_id,
                    accelerator,
                    registered: false,
                    error: Some(error.to_string()),
                };
                write_global_hotkey_registration_event(&app, &result);
                results.push(result);
            }
        }
    }

    {
        let mut guard = state
            .registered
            .lock()
            .expect("keybinding hotkeys mutex poisoned");
        *guard = registered;
    }

    results
}

#[cfg(test)]
mod global_hotkey_tests {
    use super::{global_hotkey_window_action, GlobalHotkeyWindowAction};

    #[test]
    fn voice_call_toggle_requires_focus_before_emit() {
        assert_eq!(
            global_hotkey_window_action("voice.callToggle"),
            GlobalHotkeyWindowAction::FocusBeforeEmit
        );
    }

    #[test]
    fn existing_global_hotkey_window_actions_keep_their_behavior() {
        assert_eq!(
            global_hotkey_window_action("app.toggle"),
            GlobalHotkeyWindowAction::Toggle
        );
        assert_eq!(
            global_hotkey_window_action("app.quickAsk"),
            GlobalHotkeyWindowAction::Focus
        );
        assert_eq!(
            global_hotkey_window_action("session.new"),
            GlobalHotkeyWindowAction::Focus
        );
        assert_eq!(
            global_hotkey_window_action("voice.toggle"),
            GlobalHotkeyWindowAction::None
        );
    }
}

fn setup_global_shortcut(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    {
        appshots::setup_dual_command_hotkey(app.handle().clone())
            .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
        appshots::enable_hover_when_inactive(app.handle());
        appshots::enable_first_mouse_click(app.handle());
    }

    Ok(())
}

fn main() {
    // T2 工单：必须在 Tauri 创建任何窗口（含 WebView2）/webServer 子进程之前
    // 完成，否则后创建的子孙进程赶不上加入 Job（见函数注释）。非 Windows 平台
    // 是空操作。
    install_windows_process_containment();

    let app = tauri::Builder::default()
        // single-instance 必须在其他 plugin 之前注册：后启动的进程会直接退出，
        // 并把 argv/cwd 传给已运行的实例，由 callback 聚焦已有窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 有窗口就弹出聚焦；窗口已销毁（僵尸实例）就重建，
            // 保证用户双击图标永远能得到一个窗口而不是"闪退"。
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            } else if let Err(error) = recreate_main_window(app) {
                eprintln!("Failed to recreate main window: {error}");
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .manage(NativeDesktopState::default())
        .manage(AppshotsState::default())
        .manage(KeybindingHotkeysState::default())
        .manage(AgentHaloState::default())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            check_for_update,
            install_update,
            open_update_url,
            shutdown_web_server_for_update,
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
            desktop_start_voice_aec,
            desktop_write_voice_aec_playback,
            desktop_control_voice_aec,
            desktop_stop_voice_aec,
            desktop_get_app_icon,
            appshots_trigger,
            appshots_read_image_data_url,
            appshots_read_image_data_url_by_id,
            appshots_report_composer_slot,
            appshots_set_enabled,
            appshots_skip_motion,
            appshots_set_target_session,
            appshots_set_motion_enabled,
            pip_show,
            pip_frame,
            pip_controls,
            pip_control,
            pip_hide,
            agent_halo_show,
            agent_halo_mode,
            agent_halo_hide,
            keybindings_set_global_hotkeys,
            renderer_ready
        ])
        .setup(|app| {
            // 必须在 spawn webServer 之前：决定本进程（含 node 子进程）的数据目录通道。
            apply_channel_env(&app.handle());
            let mut boot_diagnostics = new_boot_diagnostics(&app.handle());
            write_boot_diagnostics(&app.handle(), &boot_diagnostics);

            // T2 工单：收割上一代崩溃/被强杀留下的 WebView2 子孙孤儿（非
            // Windows 平台是空操作，返回空 vec）。webServer 自己的陈旧端口
            // 占用由下面 `spawn_web_server_recording` 内的
            // `clear_stale_web_server_port` 单独处理（本单已补上 Windows
            // 分支），两条认领路径互不依赖，谁先谁后都不影响正确性。
            let reaped_orphans = reap_stale_windows_processes(&app.handle());
            if !reaped_orphans.is_empty() {
                write_shell_event(
                    &app.handle(),
                    &boot_diagnostics,
                    "warning",
                    "desktop-shell-stale-windows-process-reaped",
                    "reaped orphaned process(es) claimed by a previous instance",
                    Some(serde_json::json!({ "pids": reaped_orphans })),
                );
            }

            if cfg!(debug_assertions) && is_server_running() {
                // Server already running (e.g. started by Tauri beforeDevCommand in dev mode).
                // Release builds must not trust an arbitrary healthy localhost:8180 process:
                // a stale dev server can serve mismatched renderer assets and leave the app white.
                println!(
                    "Web server already running on {}, skipping spawn",
                    server_url()
                );
                boot_diagnostics.health_matched_boot_token = None;
                record_boot_stage(
                    &app.handle(),
                    &mut boot_diagnostics,
                    DesktopShellBootStage::HealthReady,
                );
            } else {
                match start_web_server_recording(&app.handle(), &mut boot_diagnostics) {
                    Ok(child) => app.state::<AppState>().store_child(child),
                    Err(error) => {
                        // 不走 panic（SIGABRT 闪退无提示）：弹错误框告知用户后干净退出
                        show_startup_failure(&error, boot_diagnostics.diagnostic_file.as_deref());
                        std::process::exit(1);
                    }
                }
            }

            let Some(window) = app.get_webview_window("main") else {
                let error =
                    "Renderer main window is missing after webServer healthcheck".to_string();
                record_boot_failure(
                    &app.handle(),
                    &mut boot_diagnostics,
                    "desktop-shell-renderer-window-missing",
                    &error,
                );
                show_startup_failure(&error, boot_diagnostics.diagnostic_file.as_deref());
                std::process::exit(1);
            };

            // window 初始 url 是 about:blank（tauri.conf.json），避免启动竞赛下
            // webServer 未起时页面加载失败白屏。healthcheck 通过后用
            // webview.navigate() 跳到 boot URL（比 eval+JS 更可靠，且走正常
            // 导航而不是 cross-origin replace）。?boot= 每次唯一，绕开
            // WKWebView 对启动文档的历史缓存（启动连刷根因）。
            let navigation_result = boot_server_url()
                .parse::<tauri::Url>()
                .map_err(|error| {
                    renderer_navigation_failure_message(&format!("invalid boot URL: {error}"))
                })
                .and_then(|url| {
                    window
                        .navigate(url)
                        .map_err(|error| renderer_navigation_failure_message(&error.to_string()))
                });
            if let Err(error) = navigation_result {
                record_boot_failure(
                    &app.handle(),
                    &mut boot_diagnostics,
                    "desktop-shell-renderer-navigation-failed",
                    &error,
                );
                show_startup_failure(&error, boot_diagnostics.diagnostic_file.as_deref());
                std::process::exit(1);
            }
            // 窗口在 tauri.conf.json 里是 visible:false。此前是 navigate() 一返回就
            // show()——但 navigate 只表示"导航开始",首帧还没画出,于是出现
            // 深色底→空白→内容的启动闪烁(实测闪 2 下)。改为等 renderer 完成首次
            // 渲染 commit 后发来的 renderer-ready 事件再 show;并加超时兜底,信号丢失
            // 也不会让窗口永久隐藏。show 用 AtomicBool 去重,两条路径谁先到谁生效。
            let shown = Arc::new(AtomicBool::new(false));
            // renderer_ready invoke command 与下面的事件监听/超时兜底共用同一去重标志
            app.manage(RendererReadyShown(shown.clone()));
            {
                let app_for_show = app.handle().clone();
                let shown = shown.clone();
                // 用 app 级 once(而非 window.once):JS emit('renderer-ready') 是全局事件,
                // app 级监听更可靠地收到(实测 window.once 收不到、窗口一直走超时兜底)。
                app.handle().once("renderer-ready", move |_event| {
                    if !shown.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        present_main_window(&app_for_show, "renderer-ready-event");
                    }
                });
            }
            {
                let app_for_timeout = app.handle().clone();
                let shown = shown.clone();
                thread::spawn(move || {
                    thread::sleep(RENDERER_READY_TIMEOUT);
                    if !shown.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        present_main_window(&app_for_timeout, "timeout-fallback");
                    }
                });
            }
            record_boot_stage(
                &app.handle(),
                &mut boot_diagnostics,
                DesktopShellBootStage::WindowNavigated,
            );

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
        // 这里**不要**再挂 Resized 重放摆灯：Resized 是该帧画完之后才送到的，
        // 缩放/双击放大的动画期间会变成「先按默认位画出来、再被拨回去」，肉眼就是灯在抖
        // （2026-07-27 产品负责人实测）。缩放态由 wry 在 drawRect 里的帧内重放负责，
        // 见 tauri.conf.json 的 trafficLightPosition 与 traffic_lights.rs 的注释。
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            cleanup_server(app_handle);
        }
        _ => {}
    });
}
