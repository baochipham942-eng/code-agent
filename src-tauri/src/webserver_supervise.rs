// ============================================================================
// WebServer Supervise — webServer 意外死亡后的有界自动重启
// (N-WEBSERVER-DEATH-SUPERVISE-RESTART)
// ============================================================================
// 承接 DIAG（webserver_exit.rs）：死亡取证已落盘，本模块负责「拉起来」。
// 业主拍板方案 A（2026-11-03）：backoff 1s/2s/4s 的自动重启；连续 3 次尝试
// 失败后弹原生对话框给「重试」按钮（不是只有文案）。参照 VS Code
// ExtensionHostCrashTracker（3 次 / 5 分钟上限）与 systemd StartLimitBurst
// （超限后不再自动拉起、仍允许手动重启），明确否掉无界重启（crash loop）与
// 纯提示（与「不许让用户手动重启」矛盾）。
//
// 尝试失败的口径（任务书）：spawn 后在健康超时窗口内没有拿到「带匹配 boot
// token 的 /api/health 200」，或子进程在健康运行满 60s 之前又死了。健康满
// 60s 的一代算「稳了」，计数清零。状态只在内存里。
//
// 两条死亡路径都汇到这里：
//   - owned child：webserver_exit 的 watcher 报完 unexpected 事件后交接；
//   - attached daemon：本模块自己的守护 watcher（ps 身份 + /health，连续
//     2 拍 miss 才判死）。重生前**必**重跑 decide_startup_io：Some = 守护
//     还活着（或换了新守护）→ 重新附着，绝不 spawn、绝不让 spawn 路径的
//     clear_stale_web_server_port 去 kill -9 活守护；None 才清附着槽、拉
//     owned 子进程。
//
// 单飞：restart guard 与 recreate_main_window 共用，两条路径不会双 spawn。
// 退出竞态：cleanup_server 置 AppState.shutting_down，spawn 前与 store_child
// 前都再看一眼，退出中绝不把新孩子塞回槽里变孤儿。
// ============================================================================

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::resident_host::{self, DaemonPidRecord};
use crate::AppState;
use tauri::Manager;

/// backoff 序列：第 1/2/3 次尝试前各等 1s/2s/4s（任务书口径）。
pub const RESTART_BACKOFF_DELAYS_MS: [u64; 3] = [1000, 2000, 4000];
/// 连续失败尝试的上限：第 3 次失败后 GiveUp（弹对话框），不再自动拉起。
pub const MAX_CONSECUTIVE_FAILURES: u32 = 3;
/// 一代 server 健康运行满 60s → 连续失败计数清零。
pub const HEALTHY_RESET_UPTIME_MS: u64 = 60_000;
/// 附着守护 watcher 的轮询间隔。
pub const DAEMON_WATCH_POLL_INTERVAL: Duration = Duration::from_secs(2);
/// 附着守护判死的连续 miss 拍数（ps 身份或 /health 任一不满足算一拍 miss）。
pub const DAEMON_DEAD_AFTER_MISSES: u32 = 2;

pub const EVENT_RESTART_ATTEMPT: &str = "desktop-shell-webserver-restart-attempt";
/// 附着守护判死事件：与 DIAG 的 exited-unexpectedly 平行但独立（守护路径没有
/// Child 句柄，拿不到 ExitStatus，不能复用那套事件形状）。
pub const EVENT_DAEMON_UNREACHABLE: &str = "desktop-shell-webserver-daemon-unreachable";
pub const EVENT_RESTART_ATTEMPT_FAILED: &str = "desktop-shell-webserver-restart-attempt-failed";
pub const EVENT_RESTARTED: &str = "desktop-shell-webserver-restarted";
pub const EVENT_RESTART_GAVE_UP: &str = "desktop-shell-webserver-restart-gave-up";
pub const EVENT_RESTART_SKIPPED: &str = "desktop-shell-webserver-restart-skipped";

pub const GAVE_UP_DIALOG_TITLE: &str = "Agent Neo";
pub const GAVE_UP_DIALOG_MESSAGE: &str = "后台服务没能自动恢复。";
/// 「重试」占 Ok 槽（回车默认键）；「稍后」占 Cancel 槽（Esc 映射到这里）。
pub const GAVE_UP_DIALOG_RETRY_LABEL: &str = "重试";
pub const GAVE_UP_DIALOG_LATER_LABEL: &str = "稍后";

/// 死亡来源/重启路径标注（进事件，便于区分是哪条链路在拉起）。
pub const PATH_OWNED_CHILD: &str = "owned-child";
pub const PATH_ATTACHED_DAEMON: &str = "attached-daemon";
/// give-up 对话框点「重试」后开的新循环。
pub const CAUSE_DIALOG_RETRY: &str = "dialog-retry";
/// 附着守护 watcher 判死时的 cause：连续身份 miss（没有 Child 句柄，拿不到
/// 退出码/信号；身份是唯一判死信号——健康 miss 只是「忙」，不判死）。
pub const CAUSE_DAEMON_UNREACHABLE: &str = "attached-daemon-identity-gone";

pub const SKIP_SHUTTING_DOWN: &str = "shutting-down";
pub const SKIP_GUARD_HELD: &str = "restart-guard-held";
pub const SKIP_ALREADY_HEALTHY: &str = "server-already-healthy";
/// 附着守护活着只是不应答（忙）：拒绝走清端口的 spawn 路径。
pub const SKIP_DAEMON_ALIVE: &str = "attached-daemon-alive";

// ============================================================================
// 纯状态机：decide(history, now) -> Restart{delay} | GiveUp
// ============================================================================

/// 监督账本（内存态）。`consecutive_failures` 在每次尝试**调度时**悲观 +1；
/// 只有这一代健康满 60s（`healthy_since_ms` 距 now ≥ 60s）才会被 decide 视为
/// 清零——「先记失败、活满 60s 才翻案」保证 spawn 失败与早期死亡都天然计数。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SuperviseHistory {
    pub consecutive_failures: u32,
    /// 当前这一代第一次拿到健康应答的时刻（ms epoch）；None = 没有活着的健康代。
    pub healthy_since_ms: Option<u128>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuperviseDecision {
    /// 第 `attempt` 次尝试（1 起），等待 `delay_ms` 后拉起。
    Restart { attempt: u32, delay_ms: u64 },
    /// 连续 3 次尝试失败：停止自动拉起，弹对话框（重试 / 稍后）。
    GiveUp,
}

/// 当前有效的连续失败数：这一代已健康满 60s → 0（清零），否则账本原值。
pub fn effective_failures(history: &SuperviseHistory, now_ms: u128) -> u32 {
    match history.healthy_since_ms {
        Some(since) if now_ms.saturating_sub(since) >= u128::from(HEALTHY_RESET_UPTIME_MS) => 0,
        _ => history.consecutive_failures,
    }
}

pub fn decide(history: &SuperviseHistory, now_ms: u128) -> SuperviseDecision {
    let failures = effective_failures(history, now_ms);
    if failures >= MAX_CONSECUTIVE_FAILURES {
        SuperviseDecision::GiveUp
    } else {
        SuperviseDecision::Restart {
            attempt: failures + 1,
            delay_ms: RESTART_BACKOFF_DELAYS_MS[failures as usize],
        }
    }
}

/// 调度一次尝试后的账本更新：按当前有效失败数 +1（悲观记账），健康代清空
/// （server 已死，60s 翻案的前提不存在了）。
pub fn record_attempt_scheduled(history: &SuperviseHistory, now_ms: u128) -> SuperviseHistory {
    SuperviseHistory {
        consecutive_failures: effective_failures(history, now_ms) + 1,
        healthy_since_ms: None,
    }
}

/// 一次成功拉起拿到健康应答后的账本更新：从现在起计这一代的健康时钟。
pub fn record_healthy(history: &SuperviseHistory, now_ms: u128) -> SuperviseHistory {
    SuperviseHistory {
        consecutive_failures: history.consecutive_failures,
        healthy_since_ms: Some(now_ms),
    }
}

// ============================================================================
// 附着守护 watcher：纯判定 + 真线程
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonWatchTick {
    /// 身份 + 健康都在：继续轮询（身份 miss 计数清零）。
    Alive,
    /// 身份在、/health 不应答：守护**活着**，只是忙（事件循环被同步重活阻塞
    /// 6-9s 并不罕见）。绝不判死、绝不让 spawn 路径 kill -9 它——继续盯，
    /// 由调用方留痕一次「不健康」事件。
    Unhealthy,
    /// 一拍身份 miss（ps 无输出 / lstart+command 不吻合）：身份是唯一能证明
    /// 进程真没了的信号，连续累计 n 拍。
    IdentityMiss(u32),
    /// 连续 DAEMON_DEAD_AFTER_MISSES 拍身份 miss：调用方交接给监督循环。
    Dead,
}

/// 一拍判定：**只有身份 miss 计入判死**（ps 拿不到 / 不吻合 = 进程没了或 pid
/// 被复用）。健康 miss 一拍都不算——忙守护（身份在、/health 暂时超时）判死
/// 会让 spawn 路径的 clear_stale_web_server_port kill -9 活守护，正在跑的
/// 后台任务被强杀（ai-review #2746 Important）。健康不健康交给附着重判
/// （decide_startup_io 的 health_ok）决定「附着还是换人」，不决定生死。
pub fn daemon_watch_tick(previous_identity_misses: u32, identity_ok: bool, health_ok: bool) -> DaemonWatchTick {
    if !identity_ok {
        let misses = previous_identity_misses.saturating_add(1);
        if misses >= DAEMON_DEAD_AFTER_MISSES {
            return DaemonWatchTick::Dead;
        }
        return DaemonWatchTick::IdentityMiss(misses);
    }
    // 身份吻合：进程活着。健康只影响「要不要留痕」，不影响生死。
    if health_ok {
        DaemonWatchTick::Alive
    } else {
        DaemonWatchTick::Unhealthy
    }
}

/// watcher 只对「槽里仍是同一个守护记录」有报告权：槽空（supervisor 已清/
/// cleanup 已 take）或换了记录（重新附着到新守护）→ 旧 watcher 让位。
pub fn daemon_watcher_should_report(
    slot: Option<&DaemonPidRecord>,
    watched: &DaemonPidRecord,
) -> bool {
    slot == Some(watched)
}

// ============================================================================
// 重生计划：纯决策（daemon 活 → 附着，绝不 spawn / 绝不清端口）
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplacementPlan {
    /// 活守护（或换了新一代守护）在场：重新附着。**绝不** spawn、**绝不**走
    /// clear_stale_web_server_port（那条路径对端口占用者无差别 kill -9）。
    Reattach(DaemonPidRecord),
    /// 端口上已有健康应答（如 window-recreate 抢先拉起）：不再竞争 spawn。
    AlreadyHealthy,
    /// 常规路径：spawn 一个 owned 子进程（打包态先清陈旧端口）。
    SpawnOwned,
}

/// `daemon_record` 来自 spawn 前重跑的 decide_startup_io（Some = 身份 + 健康
/// 双吻合的活守护）。Some 一律 Reattach——守护活着就不许碰 spawn 链路。
pub fn plan_replacement(daemon_record: Option<DaemonPidRecord>, already_healthy: bool) -> ReplacementPlan {
    if let Some(record) = daemon_record {
        ReplacementPlan::Reattach(record)
    } else if already_healthy {
        ReplacementPlan::AlreadyHealthy
    } else {
        ReplacementPlan::SpawnOwned
    }
}

/// SpawnOwned 前的最后一道闸：附着槽里还有记录、且该记录的身份**此刻仍**
/// 吻合（ps lstart+command 对得上）= 守护活着只是不应答（忙/暂时不健康）——
/// spawn 路径会经 clear_stale_web_server_port 对端口占用者无差别 kill -9，
/// 活守护绝不能走到那。返回 false = 拒绝 spawn，按一次失败处理。
/// 槽为 None（本就是 owned 子进程路径）或身份已不吻合（真死/pid 复用）→ 放行。
pub fn spawn_owned_allowed(attached: Option<&DaemonPidRecord>, attached_identity_ok: bool) -> bool {
    match attached {
        Some(_) => !attached_identity_ok,
        None => true,
    }
}

// ============================================================================
// give-up 对话框：按钮语义（纯函数，单测钉死）
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GaveUpAction {
    /// Ok 槽「重试」：计数清零，开新一轮循环。
    Retry,
    /// Cancel 槽「稍后」（Esc 也映射到这里）/ 插件异常 None：不再自动尝试。
    Later,
}

/// 只有 Ok 槽位的「重试」文案是 Retry；其余（Cancel 槽「稍后」、Esc、插件
/// 失败的 None、未知文案）一律 Later——不确定时选择「不再自动尝试」。
pub fn gave_up_dialog_action(custom_label: Option<&str>) -> GaveUpAction {
    match custom_label {
        Some(label) if label == GAVE_UP_DIALOG_RETRY_LABEL => GaveUpAction::Retry,
        _ => GaveUpAction::Later,
    }
}

// ============================================================================
// 共享内存态：账本 + 单飞闸
// ============================================================================

fn supervise_history() -> &'static Mutex<SuperviseHistory> {
    static HISTORY: OnceLock<Mutex<SuperviseHistory>> = OnceLock::new();
    HISTORY.get_or_init(|| Mutex::new(SuperviseHistory::default()))
}

/// 清零账本：give-up 对话框点「重试」、以及 window-recreate 自愈成功后调用
/// （重开窗口必须能再拉起，不能被上一轮的 3 连败卡死）。
pub fn reset_history() {
    let mut history = match supervise_history().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    *history = SuperviseHistory::default();
}

static RESTART_GUARD: AtomicBool = AtomicBool::new(false);

/// 单飞令牌：drop 时释放。与 recreate_main_window 共用，保证死亡重启与窗口
/// 重建两条路径任意时刻只有一条在做「拉起 server」。
pub struct RestartToken;

impl Drop for RestartToken {
    fn drop(&mut self) {
        RESTART_GUARD.store(false, Ordering::SeqCst);
    }
}

pub fn acquire_restart_guard() -> Option<RestartToken> {
    RESTART_GUARD
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| RestartToken)
}

// ============================================================================
// 监督循环（闭包注入，测试不需要 AppHandle）
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartMode {
    /// spawn 了新的 owned 子进程。
    Respawn,
    /// 重新附着到活守护（没有 spawn）。
    Reattach,
    /// 端口上已有健康应答，直接认作恢复（没有 spawn）。
    AlreadyHealthy,
}

/// 一次拉起尝试的结局（由注入的 spawn_replacement 产出）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnOutcome {
    Owned { pid: u32 },
    Reattached { pid: u32 },
    AlreadyHealthy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CycleOutcome {
    /// 恢复了：新 owned pid / 附着守护 pid / 已有健康应答。
    Restarted { pid: u32, mode: RestartMode },
    /// 连续 3 次尝试失败：调用方弹 give-up 对话框。
    GaveUp,
    /// 中途发现退出已开跑（shutting_down）：不再拉起。
    Stopped,
}

/// 监督循环的全部外部世界（时钟/睡眠/探活/拉起/事件），测试全量注入。
pub trait SuperviseHooks {
    fn now_ms(&self) -> u128;
    /// 退出收尸已开跑（AppState.shutting_down）→ 停止一切拉起。
    fn should_stop(&self) -> bool;
    fn sleep(&self, delay: Duration);
    fn spawn_replacement(&self) -> Result<SpawnOutcome, String>;
    fn on_attempt(&self, attempt: u32, delay_ms: u64, cause: &str);
    fn on_attempt_failed(&self, attempt: u32, error: &str);
    fn on_restarted(&self, pid: u32, mode: RestartMode);
    fn on_gave_up(&self);
    fn on_skip(&self, reason: &'static str, detail: &str);
}

/// 核心循环：decide → 调度（悲观计数）→ backoff 睡眠 → 拉起。
/// 失败回到 decide（backoff 1s/2s/4s），满 3 连败 GiveUp，成功即返回。
/// 账本在 `history_lock` 里跨代共享：本线程返回后，下一代 watcher 报死时
/// 新循环读到同一份计数。
pub fn run_restart_cycle(
    history_lock: &Mutex<SuperviseHistory>,
    hooks: &dyn SuperviseHooks,
    cause: &str,
) -> CycleOutcome {
    loop {
        if hooks.should_stop() {
            hooks.on_skip(SKIP_SHUTTING_DOWN, &format!("cause={cause}"));
            return CycleOutcome::Stopped;
        }
        let now = hooks.now_ms();
        let decision = with_history(history_lock, |history| decide(history, now));
        let SuperviseDecision::Restart { attempt, delay_ms } = decision else {
            hooks.on_gave_up();
            return CycleOutcome::GaveUp;
        };
        set_history(
            history_lock,
            with_history(history_lock, |history| record_attempt_scheduled(history, now)),
        );
        hooks.on_attempt(attempt, delay_ms, cause);
        hooks.sleep(Duration::from_millis(delay_ms));
        if hooks.should_stop() {
            hooks.on_skip(SKIP_SHUTTING_DOWN, &format!("attempt={attempt}"));
            return CycleOutcome::Stopped;
        }
        match hooks.spawn_replacement() {
            Ok(SpawnOutcome::Owned { pid }) => {
                let healthy_at = hooks.now_ms();
                set_history(
                    history_lock,
                    with_history(history_lock, |history| record_healthy(history, healthy_at)),
                );
                hooks.on_restarted(pid, RestartMode::Respawn);
                return CycleOutcome::Restarted { pid, mode: RestartMode::Respawn };
            }
            Ok(SpawnOutcome::Reattached { pid }) => {
                let healthy_at = hooks.now_ms();
                set_history(
                    history_lock,
                    with_history(history_lock, |history| record_healthy(history, healthy_at)),
                );
                hooks.on_restarted(pid, RestartMode::Reattach);
                return CycleOutcome::Restarted { pid, mode: RestartMode::Reattach };
            }
            Ok(SpawnOutcome::AlreadyHealthy) => {
                let healthy_at = hooks.now_ms();
                set_history(
                    history_lock,
                    with_history(history_lock, |history| record_healthy(history, healthy_at)),
                );
                hooks.on_skip(SKIP_ALREADY_HEALTHY, "another healthy server owns the port");
                return CycleOutcome::Restarted { pid: 0, mode: RestartMode::AlreadyHealthy };
            }
            Err(error) => {
                // 尝试失败：健康超时或早期死亡。计数在调度时已 +1，回到 decide
                // 拿下一档 backoff；满 3 连败在那里 GiveUp。
                hooks.on_attempt_failed(attempt, &error);
            }
        }
    }
}

fn with_history<R>(history_lock: &Mutex<SuperviseHistory>, f: impl FnOnce(&SuperviseHistory) -> R) -> R {
    let guard = match history_lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    f(&guard)
}

fn set_history(history_lock: &Mutex<SuperviseHistory>, next: SuperviseHistory) {
    let mut guard = match history_lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    *guard = next;
}

// ============================================================================
// 事件（append_shell_event_payload；payload 纯构造，单测钉形状）
// ============================================================================

/// 事件信封的固定上下文（app 版本 / 包名 / 端口 / 壳 pid），纯数据可单测。
pub struct SuperviseEventCtx<'a> {
    pub app_version: Option<&'a str>,
    pub bundle_id: Option<&'a str>,
    pub web_port: u16,
    pub shell_pid: u32,
}

pub fn supervise_event_payload(
    ctx: &SuperviseEventCtx<'_>,
    level: &str,
    event: &str,
    message: &str,
    process: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "source": "tauri-shell",
        "generatedAt": crate::now_millis_string(),
        "level": level,
        "event": event,
        "appVersion": ctx.app_version,
        "bundleId": ctx.bundle_id,
        "channel": crate::desktop_shell_channel(ctx.bundle_id, cfg!(debug_assertions)),
        "pid": ctx.shell_pid,
        "webPort": ctx.web_port,
        "message": message,
        "process": process,
    })
}

fn emit_supervise_event(
    app: &tauri::AppHandle,
    level: &str,
    event: &'static str,
    message: String,
    process: serde_json::Value,
) {
    let ctx = SuperviseEventCtx {
        app_version: app.config().version.as_deref(),
        bundle_id: Some(app.config().identifier.as_str()),
        web_port: crate::web_port(),
        shell_pid: std::process::id(),
    };
    let payload = supervise_event_payload(&ctx, level, event, &message, process);
    crate::append_shell_event_payload(app, payload);
}

// ============================================================================
// 真实接线：AppHandle 版 hooks + 死亡入口 + 守护 watcher + 对话框
// ============================================================================

struct AppSuperviseHooks {
    app: tauri::AppHandle,
    path: &'static str,
}

impl AppSuperviseHooks {
    fn process_details(&self, extra: serde_json::Value) -> serde_json::Value {
        let mut process = serde_json::json!({
            "owner": "tauri-shell",
            "role": "webServer",
            "path": self.path,
        });
        if let (Some(object), Some(extras)) = (process.as_object_mut(), extra.as_object()) {
            for (key, value) in extras {
                object.insert(key.clone(), value.clone());
            }
        }
        process
    }
}

impl SuperviseHooks for AppSuperviseHooks {
    fn now_ms(&self) -> u128 {
        crate::now_millis_string().parse::<u128>().unwrap_or(0)
    }

    fn should_stop(&self) -> bool {
        self.app
            .state::<AppState>()
            .shutting_down
            .load(Ordering::SeqCst)
    }

    fn sleep(&self, delay: Duration) {
        std::thread::sleep(delay);
    }

    fn spawn_replacement(&self) -> Result<SpawnOutcome, String> {
        // 重生前必重跑附着判定（打包态）：活守护在场 → 附着，绝不 spawn、
        // 绝不给 clear_stale_web_server_port 强杀活守护的机会。
        let daemon_record = if !cfg!(debug_assertions) {
            resident_host::decide_startup_io(crate::real_data_dir().as_deref(), &crate::health_url())
        } else {
            None
        };
        match plan_replacement(daemon_record, crate::is_server_running()) {
            ReplacementPlan::Reattach(record) => {
                self.app.state::<AppState>().store_attached_daemon(record.clone());
                spawn_daemon_watcher(self.app.clone(), record.clone());
                Ok(SpawnOutcome::Reattached { pid: record.pid })
            }
            ReplacementPlan::AlreadyHealthy => Ok(SpawnOutcome::AlreadyHealthy),
            ReplacementPlan::SpawnOwned => {
                let state = self.app.state::<AppState>();
                // SpawnOwned 最后一道闸：decide_startup_io 判 None 可能只是守护
                // **忙**（身份在、/health 超时）。此刻再核一次附着记录的身份，
                // 仍吻合 = 活守护 → 拒绝 spawn（spawn 路径的 clear_stale_web_server_port
                // 会 kill -9 它，正在跑的后台任务会被强杀），按一次失败退避重试。
                let attached = match state.attached_daemon.lock() {
                    Ok(guard) => guard.clone(),
                    Err(poisoned) => poisoned.into_inner().clone(),
                };
                if let Some(record) = attached.as_ref() {
                    let identity_ok = resident_host::process_identity_matches(
                        record,
                        resident_host::ps_process_identity(record.pid).as_deref(),
                    );
                    if !spawn_owned_allowed(attached.as_ref(), identity_ok) {
                        return Err(format!(
                            "attached daemon pid {} is alive (identity matches) but unhealthy; refusing to spawn (would kill -9 a live daemon)",
                            record.pid
                        ));
                    }
                }
                // 身份已不吻合（真死 / pid 复用）或槽本就为空：清掉附着记录，
                // cleanup 不再对着死/复用的 pid 发信号。
                if let Ok(mut slot) = state.attached_daemon.lock() {
                    *slot = None;
                }
                let child = crate::start_web_server(&self.app)?;
                let Some(pid) = state.store_child(child) else {
                    // 退出竞态：cleanup 已收走旧世界，这个刚拉起的孩子已被
                    // store_child 收掉（kill + wait），绝不入槽。
                    return Err("shutting-down raced the respawn; spawned child reaped".to_string());
                };
                crate::webserver_exit::spawn_exit_watcher(self.app.clone(), pid);
                Ok(SpawnOutcome::Owned { pid })
            }
        }
    }

    fn on_attempt(&self, attempt: u32, delay_ms: u64, cause: &str) {
        emit_supervise_event(
            &self.app,
            "warning",
            EVENT_RESTART_ATTEMPT,
            format!("webServer died ({cause}); auto-restart attempt {attempt} scheduled in {delay_ms}ms"),
            self.process_details(serde_json::json!({
                "attempt": attempt,
                "delayMs": delay_ms,
                "cause": cause,
            })),
        );
    }

    fn on_attempt_failed(&self, attempt: u32, error: &str) {
        emit_supervise_event(
            &self.app,
            "warning",
            EVENT_RESTART_ATTEMPT_FAILED,
            format!("webServer restart attempt {attempt} failed: {error}"),
            self.process_details(serde_json::json!({
                "attempt": attempt,
                "error": error,
            })),
        );
    }

    fn on_restarted(&self, pid: u32, mode: RestartMode) {
        let mode_str = match mode {
            RestartMode::Respawn => "respawn",
            RestartMode::Reattach => "reattach",
            RestartMode::AlreadyHealthy => "already-healthy",
        };
        let message = match mode {
            RestartMode::Respawn => format!("webServer respawned after unexpected exit (pid {pid})"),
            RestartMode::Reattach => format!(
                "resident daemon alive, re-attached instead of respawning (pid {pid})"
            ),
            RestartMode::AlreadyHealthy =>
                "another healthy server already owns the port; treated as recovered".to_string(),
        };
        emit_supervise_event(
            &self.app,
            "info",
            EVENT_RESTARTED,
            message,
            self.process_details(serde_json::json!({
                "pid": pid,
                "mode": mode_str,
            })),
        );
    }

    fn on_gave_up(&self) {
        emit_supervise_event(
            &self.app,
            "error",
            EVENT_RESTART_GAVE_UP,
            format!(
                "webServer auto-restart gave up after {MAX_CONSECUTIVE_FAILURES} consecutive failed attempts"
            ),
            self.process_details(serde_json::json!({
                "attempts": MAX_CONSECUTIVE_FAILURES,
            })),
        );
    }

    fn on_skip(&self, reason: &'static str, detail: &str) {
        emit_supervise_event(
            &self.app,
            "warning",
            EVENT_RESTART_SKIPPED,
            format!("webServer restart skipped: {reason} ({detail})"),
            self.process_details(serde_json::json!({
                "reason": reason,
                "detail": detail,
            })),
        );
    }
}

/// 意外死亡后的监督入口（owned-child 与 attached-daemon 两条路径共用）。
/// 单飞：拿不到 guard（window-recreate 或另一条监督循环正在拉起）就带着
/// 原因退场，绝不双 spawn。恢复成功后把 main 窗口导航到全新 boot URL。
pub fn supervise_after_death(
    app: tauri::AppHandle,
    cause: &'static str,
    dead_pid: u32,
    path: &'static str,
) {
    let _ = std::thread::Builder::new()
        .name("webserver-supervise".to_string())
        .spawn(move || {
            let Some(_guard) = acquire_restart_guard() else {
                emit_supervise_event(
                    &app,
                    "warning",
                    EVENT_RESTART_SKIPPED,
                    "webServer restart skipped: restart-guard-held (another recovery in flight)".to_string(),
                    serde_json::json!({
                        "owner": "tauri-shell",
                        "role": "webServer",
                        "path": path,
                        "reason": SKIP_GUARD_HELD,
                        "deadPid": dead_pid,
                    }),
                );
                return;
            };
            let hooks = AppSuperviseHooks { app: app.clone(), path };
            match run_restart_cycle(supervise_history(), &hooks, cause) {
                CycleOutcome::Restarted { .. } => navigate_main_window(&app),
                CycleOutcome::GaveUp => show_gave_up_dialog(app.clone(), path),
                CycleOutcome::Stopped => {}
            }
        });
}

/// give-up 后的原生对话框（非阻塞 show_with_result，回调在插件线程跑）。
/// 「重试」= Ok 槽（回车默认键）；「稍后」= Cancel 槽（Esc 映射到这里）。
/// Retry：计数清零、开新循环；Later：不再自动尝试（重开窗口仍能自愈）。
fn show_gave_up_dialog(app: tauri::AppHandle, path: &'static str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

    let app_for_retry = app.clone();
    app.dialog()
        .message(GAVE_UP_DIALOG_MESSAGE)
        .title(GAVE_UP_DIALOG_TITLE)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(
            GAVE_UP_DIALOG_RETRY_LABEL.to_string(),
            GAVE_UP_DIALOG_LATER_LABEL.to_string(),
        ))
        .show_with_result(move |result| {
            let custom_label = match result {
                MessageDialogResult::Custom(label) => Some(label),
                _ => None,
            };
            match gave_up_dialog_action(custom_label.as_deref()) {
                GaveUpAction::Retry => {
                    reset_history();
                    supervise_after_death(app_for_retry.clone(), CAUSE_DIALOG_RETRY, 0, path);
                }
                GaveUpAction::Later => {
                    eprintln!("webserver-supervise: user chose Later; no more auto attempts");
                }
            }
        });
}

/// 恢复成功后把 main 窗口导航到全新 boot URL（query 唯一，绕开缓存）。
/// 窗口不存在（用户全关了）时静默跳过——重开窗口走 recreate_main_window。
fn navigate_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match crate::boot_server_url().parse::<tauri::Url>() {
        Ok(url) => {
            if let Err(error) = window.navigate(url) {
                eprintln!("webserver-supervise: navigate main window failed: {error:?}");
            }
        }
        Err(error) => eprintln!("webserver-supervise: invalid boot URL: {error}"),
    }
}

/// 附着守护的 watcher：每个 store_attached_daemon 调用点之后各启一个。
/// 判死（连续 2 拍身份或健康 miss）后交接给监督循环。
pub fn spawn_daemon_watcher(app: tauri::AppHandle, watched: DaemonPidRecord) {
    let _ = std::thread::Builder::new()
        .name("webserver-daemon-watcher".to_string())
        .spawn(move || {
            let mut identity_misses = 0u32;
            // 「不健康」留痕只在一个连续 episode 里发一次，恢复健康后重置——
            // 每 2s 一条会刷屏，但完全不记又违反「无静默分支」。
            let mut unhealthy_logged = false;
            loop {
                std::thread::sleep(DAEMON_WATCH_POLL_INTERVAL);
                let state = app.state::<AppState>();
                let slot = match state.attached_daemon.lock() {
                    Ok(guard) => guard.clone(),
                    Err(poisoned) => poisoned.into_inner().clone(),
                };
                if !daemon_watcher_should_report(slot.as_ref(), &watched) {
                    return;
                }
                let identity_ok = resident_host::process_identity_matches(
                    &watched,
                    resident_host::ps_process_identity(watched.pid).as_deref(),
                );
                let health_ok = resident_host::http_health_ok(&crate::health_url());
                match daemon_watch_tick(identity_misses, identity_ok, health_ok) {
                    DaemonWatchTick::Alive => {
                        identity_misses = 0;
                        unhealthy_logged = false;
                    }
                    // 身份在、健康不应答：守护活着，继续盯（不判死、不杀）。
                    DaemonWatchTick::Unhealthy => {
                        if !unhealthy_logged {
                            unhealthy_logged = true;
                            emit_supervise_event(
                                &app,
                                "warning",
                                EVENT_DAEMON_UNREACHABLE,
                                format!(
                                    "attached daemon webServer alive but /api/health unresponsive (pid {}); keeping it (busy, not dead)",
                                    watched.pid
                                ),
                                serde_json::json!({
                                    "owner": "resident-daemon",
                                    "role": "webServer",
                                    "path": PATH_ATTACHED_DAEMON,
                                    "pid": watched.pid,
                                    "state": "unhealthy-alive",
                                }),
                            );
                        }
                    }
                    DaemonWatchTick::IdentityMiss(n) => identity_misses = n,
                    DaemonWatchTick::Dead => {
                        report_daemon_death(&app, &watched);
                        return;
                    }
                }
            }
        });
}

/// 守护判死的交接：落一条取景事件（守护路径没有 ExitStatus，cause 固定），
/// 然后进监督循环。附着槽不清——重生计划里 SpawnOwned 分支才清它；
/// GiveUp+Later 时留着死记录也无害（cleanup 的身份核对会跳过发信号）。
fn report_daemon_death(app: &tauri::AppHandle, record: &DaemonPidRecord) {
    emit_supervise_event(
        app,
        "error",
        EVENT_DAEMON_UNREACHABLE,
        format!(
            "attached daemon webServer identity gone for {DAEMON_DEAD_AFTER_MISSES} consecutive polls (pid {})",
            record.pid
        ),
        serde_json::json!({
            "owner": "resident-daemon",
            "role": "webServer",
            "path": PATH_ATTACHED_DAEMON,
            "pid": record.pid,
            "cause": CAUSE_DAEMON_UNREACHABLE,
            "identityMisses": DAEMON_DEAD_AFTER_MISSES,
        }),
    );
    supervise_after_death(app.clone(), CAUSE_DAEMON_UNREACHABLE, record.pid, PATH_ATTACHED_DAEMON);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command};
    use std::time::Instant;

    // ── ① 纯状态机：backoff 序列 / 3 连败 GiveUp / 60s 健康清零 ────────────

    #[test]
    fn decide_backoff_sequence_is_1s_2s_4s_then_give_up() {
        let now = 10_000u128;
        let mut history = SuperviseHistory::default();
        // 第 1 次死亡：账本干净 → 尝试 1，等 1s
        assert_eq!(
            decide(&history, now),
            SuperviseDecision::Restart { attempt: 1, delay_ms: 1000 }
        );
        history = record_attempt_scheduled(&history, now);
        // 第 2 次（上次尝试的孩子 5s 就死了，健康时钟为 None）→ 尝试 2，等 2s
        assert_eq!(
            decide(&history, now + 5_000),
            SuperviseDecision::Restart { attempt: 2, delay_ms: 2000 }
        );
        history = record_attempt_scheduled(&history, now + 5_000);
        // 第 3 次 → 尝试 3，等 4s
        assert_eq!(
            decide(&history, now + 9_000),
            SuperviseDecision::Restart { attempt: 3, delay_ms: 4000 }
        );
        history = record_attempt_scheduled(&history, now + 9_000);
        // 第 3 次尝试也失败（如健康超时）→ 第 4 次决定是 GiveUp，不再自动拉起
        assert_eq!(decide(&history, now + 20_000), SuperviseDecision::GiveUp);
    }

    #[test]
    fn healthy_run_of_60s_resets_consecutive_failures() {
        let now = 100_000u128;
        // 已有 2 连败，但这代已健康 60s → 清零，回到尝试 1 / 1s
        let recovered = SuperviseHistory {
            consecutive_failures: 2,
            healthy_since_ms: Some(now - u128::from(HEALTHY_RESET_UPTIME_MS)),
        };
        assert_eq!(
            decide(&recovered, now),
            SuperviseDecision::Restart { attempt: 1, delay_ms: 1000 }
        );
        // 59s 还不算稳：维持原计数 → 尝试 3 / 4s
        let not_yet = SuperviseHistory {
            consecutive_failures: 2,
            healthy_since_ms: Some(now - (u128::from(HEALTHY_RESET_UPTIME_MS) - 1_000)),
        };
        assert_eq!(
            decide(&not_yet, now),
            SuperviseDecision::Restart { attempt: 3, delay_ms: 4000 }
        );
        // 调度记账沿「有效失败数」走：健康满 60s 的一代死掉 → 计数从 1 重新起
        let rescheduled = record_attempt_scheduled(&recovered, now);
        assert_eq!(rescheduled, SuperviseHistory { consecutive_failures: 1, healthy_since_ms: None });
        // 拿到健康应答 → 起这一代的健康时钟（计数保留，等 60s 翻案）
        let healthy = record_healthy(&rescheduled, now);
        assert_eq!(
            healthy,
            SuperviseHistory { consecutive_failures: 1, healthy_since_ms: Some(now) }
        );
    }

    // ── ① 对话框按钮语义：Retry 重置再拉起，Later 不再自动尝试 ─────────────

    #[test]
    fn give_up_dialog_retry_resets_and_restarts_later_does_not() {
        // Ok 槽「重试」→ Retry；Cancel 槽「稍后」（Esc 也映射这）→ Later；
        // 插件异常 None / 未知文案 → Later（不确定时选择不再自动尝试）
        assert_eq!(gave_up_dialog_action(Some(GAVE_UP_DIALOG_RETRY_LABEL)), GaveUpAction::Retry);
        assert_eq!(gave_up_dialog_action(Some(GAVE_UP_DIALOG_LATER_LABEL)), GaveUpAction::Later);
        assert_eq!(gave_up_dialog_action(None), GaveUpAction::Later);
        assert_eq!(gave_up_dialog_action(Some("unknown")), GaveUpAction::Later);

        // Retry 之后的账本：清零 → decide 给出尝试 1 / 1s（新一轮循环）
        let mut history = SuperviseHistory {
            consecutive_failures: MAX_CONSECUTIVE_FAILURES,
            healthy_since_ms: None,
        };
        assert_eq!(decide(&history, 0), SuperviseDecision::GiveUp);
        history = SuperviseHistory::default(); // GaveUpAction::Retry → reset_history()
        assert_eq!(
            decide(&history, 0),
            SuperviseDecision::Restart { attempt: 1, delay_ms: 1000 }
        );
        // Later：不清零，decide 依旧 GiveUp（不再自动尝试）
        let history_later = SuperviseHistory {
            consecutive_failures: MAX_CONSECUTIVE_FAILURES,
            healthy_since_ms: None,
        };
        assert_eq!(decide(&history_later, 0), SuperviseDecision::GiveUp);
    }

    // ── 循环级：注入 hooks（虚拟时钟 + 空睡眠），3 连败 GiveUp / 事件序 ────

    struct RecordingHooks {
        stop: AtomicBool,
        virtual_now_ms: Mutex<u128>,
        sleep_delays: Mutex<Vec<u64>>,
        attempts: Mutex<Vec<(u32, u64)>>,
        attempt_failures: Mutex<Vec<(u32, String)>>,
        restarts: Mutex<Vec<(u32, RestartMode)>>,
        skips: Mutex<Vec<(&'static str, String)>>,
        gave_up: Mutex<bool>,
        spawn: Box<dyn Fn() -> Result<SpawnOutcome, String> + Send + Sync>,
    }

    impl RecordingHooks {
        fn with_spawn(spawn: impl Fn() -> Result<SpawnOutcome, String> + Send + Sync + 'static) -> Self {
            RecordingHooks {
                stop: AtomicBool::new(false),
                virtual_now_ms: Mutex::new(1_000),
                sleep_delays: Mutex::new(Vec::new()),
                attempts: Mutex::new(Vec::new()),
                attempt_failures: Mutex::new(Vec::new()),
                restarts: Mutex::new(Vec::new()),
                skips: Mutex::new(Vec::new()),
                gave_up: Mutex::new(false),
                spawn: Box::new(spawn),
            }
        }
    }

    impl SuperviseHooks for RecordingHooks {
        fn now_ms(&self) -> u128 {
            *self.virtual_now_ms.lock().unwrap()
        }
        fn should_stop(&self) -> bool {
            self.stop.load(Ordering::SeqCst)
        }
        fn sleep(&self, delay: Duration) {
            self.sleep_delays.lock().unwrap().push(delay.as_millis() as u64);
            let mut now = self.virtual_now_ms.lock().unwrap();
            *now += u128::from(delay.as_millis() as u64);
        }
        fn spawn_replacement(&self) -> Result<SpawnOutcome, String> {
            (self.spawn)()
        }
        fn on_attempt(&self, attempt: u32, delay_ms: u64, _cause: &str) {
            self.attempts.lock().unwrap().push((attempt, delay_ms));
        }
        fn on_attempt_failed(&self, attempt: u32, error: &str) {
            self.attempt_failures.lock().unwrap().push((attempt, error.to_string()));
        }
        fn on_restarted(&self, pid: u32, mode: RestartMode) {
            self.restarts.lock().unwrap().push((pid, mode));
        }
        fn on_gave_up(&self) {
            *self.gave_up.lock().unwrap() = true;
        }
        fn on_skip(&self, reason: &'static str, detail: &str) {
            self.skips.lock().unwrap().push((reason, detail.to_string()));
        }
    }

    #[test]
    fn cycle_gives_up_after_three_failed_attempts_with_backoff_sequence() {
        let hooks = RecordingHooks::with_spawn(|| Err("healthcheck timed out".to_string()));
        let history = Mutex::new(SuperviseHistory::default());
        let outcome = run_restart_cycle(&history, &hooks, "killed-by-signal");
        assert_eq!(outcome, CycleOutcome::GaveUp);
        assert_eq!(
            *hooks.attempts.lock().unwrap(),
            vec![(1, 1000), (2, 2000), (3, 4000)],
            "三次尝试必须按 1s/2s/4s 退避"
        );
        assert_eq!(hooks.attempt_failures.lock().unwrap().len(), 3);
        assert!(*hooks.gave_up.lock().unwrap(), "3 连败后必须给 gave-up 信号（弹对话框）");
        assert_eq!(
            history.lock().unwrap().consecutive_failures,
            MAX_CONSECUTIVE_FAILURES
        );
        // 账本留在 3 连败：下一次死亡直接 GiveUp，直到 Retry/重开窗口清零
        assert_eq!(decide(&history.lock().unwrap(), 999_999), SuperviseDecision::GiveUp);
    }

    #[test]
    fn cycle_respawns_and_resets_after_healthy_generation() {
        // 第 1 次尝试成功（spawn 出新 pid）；那代健康跑满 60s 后再死 → 计数清零，
        // 新循环又从尝试 1 / 1s 起（不是 2 / 2s）。
        let hooks = RecordingHooks::with_spawn(|| Ok(SpawnOutcome::Owned { pid: 4321 }));
        let history = Mutex::new(SuperviseHistory::default());
        let outcome = run_restart_cycle(&history, &hooks, "killed-by-signal");
        assert_eq!(outcome, CycleOutcome::Restarted { pid: 4321, mode: RestartMode::Respawn });
        assert_eq!(*hooks.restarts.lock().unwrap(), vec![(4321, RestartMode::Respawn)]);
        // 模拟这代活了 61s 后死亡（健康时钟已由循环记录）
        let now = hooks.now_ms() + u128::from(HEALTHY_RESET_UPTIME_MS) + 1_000;
        assert_eq!(
            decide(&history.lock().unwrap(), now),
            SuperviseDecision::Restart { attempt: 1, delay_ms: 1000 },
            "健康满 60s 的一代死后必须从尝试 1 重新计数"
        );
    }

    // ── ③ 附着守护：判死节奏 / 让位判定 / 重生计划（活守护绝不 spawn）────

    #[test]
    fn daemon_watch_tick_requires_two_consecutive_identity_misses() {
        // 身份 + 健康都在 → 活着，身份 miss 计数清零
        assert_eq!(daemon_watch_tick(1, true, true), DaemonWatchTick::Alive);
        assert_eq!(daemon_watch_tick(0, true, true), DaemonWatchTick::Alive);
        // 身份在、健康不应答 → Unhealthy：守护活着（忙），继续盯，绝不判死
        assert_eq!(daemon_watch_tick(0, true, false), DaemonWatchTick::Unhealthy);
        assert_eq!(daemon_watch_tick(1, true, false), DaemonWatchTick::Unhealthy);
        assert_eq!(daemon_watch_tick(0, false, true), DaemonWatchTick::IdentityMiss(1));
        assert_eq!(daemon_watch_tick(0, false, false), DaemonWatchTick::IdentityMiss(1));
        // 连续第 2 拍身份 miss（拍数从上一拍续起）→ 判死；首拍 miss 不判死
        assert_eq!(daemon_watch_tick(1, false, true), DaemonWatchTick::Dead, "上一拍已 miss，本拍再 miss = 连续 2 拍");
    }

    // ── Rework r1：忙守护（身份在、/health 暂时不应答）绝不能被判死 ─────────
    // 根因：旧判据把健康 miss 也计入判死拍数，守护事件循环被同步重活阻塞
    // 6-9s（身份仍在）就会被判死，随后 spawn 路径的 clear_stale_web_server_port
    // 对活守护 kill -9。身份是唯一能证明进程真没了的信号。
    #[test]
    fn busy_daemon_with_identity_never_declared_dead() {
        assert_ne!(
            daemon_watch_tick(1, true, false),
            DaemonWatchTick::Dead,
            "身份在、健康 miss 一拍不能判死"
        );
        assert_ne!(
            daemon_watch_tick(5, true, false),
            DaemonWatchTick::Dead,
            "健康 miss 哪怕攒了很多拍，身份在就绝不能判死"
        );
        // 正面钉死：身份在 + 健康 miss → Unhealthy（活着，继续盯）
        assert_eq!(daemon_watch_tick(1, true, false), DaemonWatchTick::Unhealthy);
        assert_eq!(daemon_watch_tick(999, true, false), DaemonWatchTick::Unhealthy);
        // 身份 miss 仍是判死的唯一信号
        assert_eq!(daemon_watch_tick(1, false, false), DaemonWatchTick::Dead);
    }

    // ── Rework r1：SpawnOwned 闸——身份在的活守护不许走到清端口的 spawn ────
    // decide_startup_io 判 None 只说明「没能同时证明身份+健康」，守护可能只是
    // 忙；spawn_owned_allowed 是最后一道闸，身份仍吻合就必须拒绝。
    #[test]
    fn spawn_owned_gate_blocks_alive_daemon_allows_dead_or_owned_path() {
        let record = DaemonPidRecord { pid: 777, start_time: Some("Sat Oct 11 22:29:33 2026".into()) };
        // 身份在（活守护，只是不健康）→ 不许 SpawnOwned
        assert!(
            !spawn_owned_allowed(Some(&record), true),
            "身份仍吻合的守护活着：必须拒绝 spawn（否则 clear_stale_web_server_port kill -9 活守护）"
        );
        // 身份没了（真死 / pid 复用）→ 放行 spawn
        assert!(spawn_owned_allowed(Some(&record), false));
        // 槽为 None（owned-child 死亡路径）→ 放行
        assert!(spawn_owned_allowed(None, true));
        assert!(spawn_owned_allowed(None, false));
    }

    #[test]
    fn daemon_watcher_yields_when_slot_changes_or_clears() {
        let watched = DaemonPidRecord { pid: 4242, start_time: Some("Sat Oct 11 22:29:33 2026".into()) };
        assert!(daemon_watcher_should_report(Some(&watched), &watched));
        assert!(!daemon_watcher_should_report(None, &watched), "槽空（supervisor 清掉/cleanup take）→ 让位");
        let replaced = DaemonPidRecord { pid: 4242, start_time: Some("Sun Oct 12 08:00:00 2026".into()) };
        assert!(!daemon_watcher_should_report(Some(&replaced), &watched), "换了新记录 → 让位");
        let other_pid = DaemonPidRecord { pid: 9999, start_time: watched.start_time.clone() };
        assert!(!daemon_watcher_should_report(Some(&other_pid), &watched));
    }

    #[test]
    fn plan_replacement_routes_daemon_reattach_spawn_and_short_circuit() {
        let record = DaemonPidRecord { pid: 777, start_time: Some("st".into()) };
        // 活守护（decide_startup_io Some）→ 一律附着：绝无 spawn、绝无清端口
        assert_eq!(plan_replacement(Some(record.clone()), true), ReplacementPlan::Reattach(record.clone()));
        assert_eq!(plan_replacement(Some(record.clone()), false), ReplacementPlan::Reattach(record));
        // 守护没了 + 端口无人应答 → spawn owned 子进程
        assert_eq!(plan_replacement(None, false), ReplacementPlan::SpawnOwned);
        // 守护没了但端口已有健康应答（如 window-recreate 抢先）→ 不竞争 spawn
        assert_eq!(plan_replacement(None, true), ReplacementPlan::AlreadyHealthy);
    }

    // ③ 的「活守护 → 零 spawn」在循环级再钉一次：spawn 闭包按重生计划路由，
    // Reattach 分支不碰 owned-spawn 计数器（真实代码里 clear_stale_web_server_port
    // 只存在于 spawn 路径 spawn_web_server_recording 内，Reattach 计划到不了那）。
    #[test]
    fn live_daemon_recovery_spawns_nothing_owned() {
        let owned_spawns = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let reattaches = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let spawn_counter = owned_spawns.clone();
        let reattach_counter = reattaches.clone();
        let hooks = RecordingHooks::with_spawn(move || {
            // 模拟 decide_startup_io 重跑返回活守护
            let daemon = DaemonPidRecord { pid: 8888, start_time: None };
            match plan_replacement(Some(daemon), false) {
                ReplacementPlan::Reattach(record) => {
                    reattach_counter.fetch_add(1, Ordering::SeqCst);
                    Ok(SpawnOutcome::Reattached { pid: record.pid })
                }
                ReplacementPlan::AlreadyHealthy => Ok(SpawnOutcome::AlreadyHealthy),
                ReplacementPlan::SpawnOwned => {
                    spawn_counter.fetch_add(1, Ordering::SeqCst);
                    Err("must not spawn while the daemon is alive".to_string())
                }
            }
        });
        let history = Mutex::new(SuperviseHistory::default());
        let outcome = run_restart_cycle(&history, &hooks, CAUSE_DAEMON_UNREACHABLE);
        assert_eq!(
            outcome,
            CycleOutcome::Restarted { pid: 8888, mode: RestartMode::Reattach }
        );
        assert_eq!(owned_spawns.load(Ordering::SeqCst), 0, "活守护恢复路径不许 owned spawn");
        assert_eq!(reattaches.load(Ordering::SeqCst), 1);
    }

    // ── ④ 退出竞态：shutting_down 后死亡不重启、孩子不入槽 ────────────────

    #[test]
    fn death_after_cleanup_does_not_restart_or_store_child() {
        // cleanup_server 已置 shutting_down（模拟）：监督循环一拍即停，零 spawn
        let state = crate::AppState::default();
        state.shutting_down.store(true, Ordering::SeqCst);
        let spawned = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counter = spawned.clone();
        let hooks = RecordingHooks::with_spawn(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(SpawnOutcome::Owned { pid: 1 })
        });
        hooks.stop.store(true, Ordering::SeqCst);
        let history = Mutex::new(SuperviseHistory::default());
        let outcome = run_restart_cycle(&history, &hooks, "killed-by-signal");
        assert_eq!(outcome, CycleOutcome::Stopped, "退出已开跑必须停，不拉起");
        assert_eq!(spawned.load(Ordering::SeqCst), 0, "退出中绝不 spawn");
        assert_eq!(hooks.skips.lock().unwrap()[0].0, SKIP_SHUTTING_DOWN);

        // store_child 在 shutting_down 下拒绝入槽并收掉孩子（没有孤儿）
        let child = Command::new("sh").arg("-c").arg("sleep 30").spawn().expect("spawn");
        let stored = state.store_child(child);
        assert!(stored.is_none(), "退出中 store_child 必须拒绝");
        assert!(
            state.web_server.lock().unwrap().is_none(),
            "槽必须保持空：退出收尸后不进新孩子"
        );
    }

    // ── 事件形状：payload 纯构造可钉（字段名进 ndjson，消费者依赖它们）─────

    #[test]
    fn supervise_event_payload_carries_supervise_family_envelope() {
        let ctx = SuperviseEventCtx {
            app_version: Some("0.0.0-test"),
            bundle_id: Some("com.example.test"),
            web_port: 8181,
            shell_pid: 111,
        };
        let payload = supervise_event_payload(
            &ctx,
            "warning",
            EVENT_RESTART_ATTEMPT,
            "webServer died (killed-by-signal); auto-restart attempt 1 scheduled in 1000ms",
            serde_json::json!({ "attempt": 1, "delayMs": 1000, "cause": "killed-by-signal" }),
        );
        assert_eq!(payload["schemaVersion"], 1);
        assert_eq!(payload["source"], "tauri-shell");
        assert_eq!(payload["level"], "warning");
        assert_eq!(payload["event"], EVENT_RESTART_ATTEMPT);
        assert_eq!(payload["webPort"], 8181);
        assert_eq!(payload["pid"], 111);
        assert_eq!(payload["process"]["attempt"], 1);
        assert_eq!(payload["process"]["delayMs"], 1000);
        assert_eq!(payload["process"]["cause"], "killed-by-signal");
        // gave-up 与 daemon 判死事件名必须可区分（不 hijack DIAG 的事件名）
        assert_ne!(EVENT_RESTART_GAVE_UP, crate::webserver_exit::UNEXPECTED_EXIT_EVENT);
        assert_ne!(EVENT_DAEMON_UNREACHABLE, crate::webserver_exit::UNEXPECTED_EXIT_EVENT);
    }

    // ── ⑥ 反向变异锚：接线文本本身（main.rs / webserver_exit.rs）───────────

    #[test]
    fn wiring_pins_supervise_hooks_in_main_and_exit_watcher() {
        let main_rs = include_str!("main.rs");
        assert!(main_rs.contains("mod webserver_supervise;"), "main.rs 必须挂载监督模块");
        assert!(
            main_rs.contains("shutting_down\n        .store(true, std::sync::atomic::Ordering::SeqCst)"),
            "cleanup_server 必须先立停机牌再收尸"
        );
        assert!(
            main_rs.contains("webserver_supervise::acquire_restart_guard()"),
            "recreate_main_window 必须与死亡重启共用单飞闸"
        );
        assert_eq!(
            main_rs.matches("webserver_supervise::spawn_daemon_watcher").count(),
            2,
            "两个 store_attached_daemon 调用点（setup + window-recreate）都要启守护 watcher"
        );
        assert!(
            main_rs.contains("webserver_supervise::reset_history()"),
            "window-recreate 自愈后必须清零 give-up 计数"
        );
        let exit_rs = include_str!("webserver_exit.rs");
        assert!(
            exit_rs.contains("webserver_supervise::supervise_after_death"),
            "owned-child 死亡取证后必须交接给监督线程"
        );
    }

    // ── ② 真进程：node 顶替 server，SIGKILL 后第一个退避窗内新 pid 应答 200 ─

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .expect("bind ephemeral port")
            .local_addr()
            .expect("local addr")
            .port()
    }

    fn http_health_ok(url: &str) -> bool {
        resident_host::http_health_ok(url)
    }

    fn wait_for_health(url: &str, deadline: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < deadline {
            if http_health_ok(url) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// node 一行式健康 server（/api/health 恒 200），当 webServer 的替身。
    fn spawn_stand_in_server(port: u16) -> Child {
        let script = format!(
            r#"require("http").createServer((req, res) => {{
                if (req.url && req.url.startsWith("/api/health")) {{
                    res.writeHead(200, {{"content-type": "application/json"}});
                    res.end(JSON.stringify({{ status: "ok" }}));
                    return;
                }}
                res.writeHead(404); res.end();
            }}).listen({port}, "127.0.0.1");"#
        );
        Command::new("node")
            .arg("-e")
            .arg(&script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn node stand-in server")
    }

    struct RealProcessHooks {
        port: u16,
        respawned: Mutex<Option<Child>>,
        sleep_delays: Mutex<Vec<u64>>,
        attempts: Mutex<Vec<(u32, u64)>>,
        attempt_failures: Mutex<Vec<(u32, String)>>,
        restarts: Mutex<Vec<(u32, RestartMode)>>,
        skips: Mutex<Vec<(&'static str, String)>>,
        gave_up: Mutex<bool>,
        health_deadline: Duration,
    }

    impl RealProcessHooks {
        fn new(port: u16, health_deadline: Duration) -> Self {
            RealProcessHooks {
                port,
                respawned: Mutex::new(None),
                sleep_delays: Mutex::new(Vec::new()),
                attempts: Mutex::new(Vec::new()),
                attempt_failures: Mutex::new(Vec::new()),
                restarts: Mutex::new(Vec::new()),
                skips: Mutex::new(Vec::new()),
                gave_up: Mutex::new(false),
                health_deadline,
            }
        }

        fn health_url(&self) -> String {
            format!("http://127.0.0.1:{}/api/health", self.port)
        }
    }

    impl SuperviseHooks for RealProcessHooks {
        fn now_ms(&self) -> u128 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        }
        fn should_stop(&self) -> bool {
            false
        }
        fn sleep(&self, delay: Duration) {
            self.sleep_delays.lock().unwrap().push(delay.as_millis() as u64);
            std::thread::sleep(delay);
        }
        fn spawn_replacement(&self) -> Result<SpawnOutcome, String> {
            let mut child = spawn_stand_in_server(self.port);
            let pid = child.id();
            let url = self.health_url();
            if !wait_for_health(&url, self.health_deadline) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("stand-in server on port {} never became healthy", self.port));
            }
            *self.respawned.lock().unwrap() = Some(child);
            Ok(SpawnOutcome::Owned { pid })
        }
        fn on_attempt(&self, attempt: u32, delay_ms: u64, _cause: &str) {
            self.attempts.lock().unwrap().push((attempt, delay_ms));
        }
        fn on_attempt_failed(&self, attempt: u32, error: &str) {
            self.attempt_failures.lock().unwrap().push((attempt, error.to_string()));
        }
        fn on_restarted(&self, pid: u32, mode: RestartMode) {
            self.restarts.lock().unwrap().push((pid, mode));
        }
        fn on_gave_up(&self) {
            *self.gave_up.lock().unwrap() = true;
        }
        fn on_skip(&self, reason: &'static str, detail: &str) {
            self.skips.lock().unwrap().push((reason, detail.to_string()));
        }
    }

    #[test]
    fn real_process_sigkill_respawns_new_pid_within_first_backoff() {
        let port = free_port();
        let health_url = format!("http://127.0.0.1:{port}/api/health");
        let mut first = spawn_stand_in_server(port);
        assert!(
            wait_for_health(&health_url, Duration::from_secs(10)),
            "stand-in server must become healthy first"
        );
        let old_pid = first.id();
        println!("[real-process] stand-in server up: pid={old_pid} port={port}");

        // SIGKILL（unix Child::kill 即 SIGKILL）
        let _ = first.kill();
        let _ = first.wait();
        println!("[real-process] SIGKILLed pid={old_pid}");

        let hooks = RealProcessHooks::new(port, Duration::from_secs(10));
        let history = Mutex::new(SuperviseHistory::default());
        let started = Instant::now();
        let outcome = run_restart_cycle(&history, &hooks, "killed-by-signal");
        let elapsed = started.elapsed();

        let CycleOutcome::Restarted { pid: new_pid, mode: RestartMode::Respawn } = outcome else {
            panic!("first backoff window must respawn, got {outcome:?}");
        };
        println!(
            "[real-process] respawned pid={new_pid} after {elapsed:?} (attempt delay={:?})",
            hooks.sleep_delays.lock().unwrap()
        );
        assert_ne!(new_pid, old_pid, "respawn 必须是全新 pid");
        assert_eq!(*hooks.attempts.lock().unwrap(), vec![(1, 1000)], "首次重启必须等 1s");
        assert!(
            elapsed >= Duration::from_secs(1) && elapsed < Duration::from_secs(10),
            "新 pid 必须在第一个退避窗内应答：{elapsed:?}"
        );
        assert!(http_health_ok(&health_url), "新 pid 必须答 /api/health 200");

        // 收尾：不留孤儿
        let respawned = hooks.respawned.lock().unwrap().take();
        if let Some(mut child) = respawned {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    // ── ⑤ 真 webServer（dist/web/webServer.cjs，隔离数据目录 + 空闲端口）──
    // 产物是 gitignored 的构建输出：本机没跑过 build:web 就不存在，测试打印
    // 原因后跳过（证据档里如实记录为何跳过/如何补跑）。

    fn real_webserver_script() -> Option<std::path::PathBuf> {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dist")
            .join("web")
            .join("webServer.cjs");
        script.exists().then_some(script)
    }

    fn spawn_real_webserver(script: &std::path::Path, port: u16, data_dir: &std::path::Path) -> Child {
        std::fs::create_dir_all(data_dir).expect("create isolated data dir");
        Command::new("node")
            .arg(script)
            .env("WEB_PORT", port.to_string())
            .env("CODE_AGENT_WEB_PORT", port.to_string())
            .env("CODE_AGENT_DATA_DIR", data_dir)
            .env("CODE_AGENT_RENDERER_HOT_UPDATE", "false")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn real webServer")
    }

    #[test]
    fn real_webserver_sigkill_respawns_if_build_present() {
        let Some(script) = real_webserver_script() else {
            println!(
                "[real-webserver] SKIP: dist/web/webServer.cjs 不存在（本机没跑 build:web），\
                 无法对真 webServer 做 kill 复测；见证据档 ⑤ 的说明"
            );
            return;
        };
        let port = free_port();
        let health_url = format!("http://127.0.0.1:{port}/api/health");
        let data_dir = std::env::temp_dir().join(format!(
            "webserver-supervise-real-{}-{port}",
            std::process::id()
        ));
        let mut first = spawn_real_webserver(&script, port, &data_dir);
        assert!(
            wait_for_health(&health_url, Duration::from_secs(120)),
            "real webServer must become healthy first (isolated data dir {})",
            data_dir.display()
        );
        let old_pid = first.id();
        println!("[real-webserver] up: pid={old_pid} port={port} dataDir={}", data_dir.display());

        let _ = first.kill();
        let _ = first.wait();
        println!("[real-webserver] SIGKILLed pid={old_pid}");

        struct RealWebserverHooks {
            script: std::path::PathBuf,
            port: u16,
            data_dir: std::path::PathBuf,
            respawned: Mutex<Option<Child>>,
            attempts: Mutex<Vec<(u32, u64)>>,
            attempt_failures: Mutex<Vec<(u32, String)>>,
            restarts: Mutex<Vec<(u32, RestartMode)>>,
            skips: Mutex<Vec<(&'static str, String)>>,
            gave_up: Mutex<bool>,
        }
        impl SuperviseHooks for RealWebserverHooks {
            fn now_ms(&self) -> u128 {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            }
            fn should_stop(&self) -> bool {
                false
            }
            fn sleep(&self, delay: Duration) {
                std::thread::sleep(delay);
            }
            fn spawn_replacement(&self) -> Result<SpawnOutcome, String> {
                let mut child = spawn_real_webserver(&self.script, self.port, &self.data_dir);
                let pid = child.id();
                let url = format!("http://127.0.0.1:{}/api/health", self.port);
                if !wait_for_health(&url, Duration::from_secs(120)) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("real webServer respawn never became healthy".to_string());
                }
                *self.respawned.lock().unwrap() = Some(child);
                Ok(SpawnOutcome::Owned { pid })
            }
            fn on_attempt(&self, attempt: u32, delay_ms: u64, _cause: &str) {
                self.attempts.lock().unwrap().push((attempt, delay_ms));
            }
            fn on_attempt_failed(&self, attempt: u32, error: &str) {
                self.attempt_failures.lock().unwrap().push((attempt, error.to_string()));
            }
            fn on_restarted(&self, pid: u32, mode: RestartMode) {
                self.restarts.lock().unwrap().push((pid, mode));
            }
            fn on_gave_up(&self) {
                *self.gave_up.lock().unwrap() = true;
            }
            fn on_skip(&self, reason: &'static str, detail: &str) {
                self.skips.lock().unwrap().push((reason, detail.to_string()));
            }
        }

        let hooks = RealWebserverHooks {
            script,
            port,
            data_dir: data_dir.clone(),
            respawned: Mutex::new(None),
            attempts: Mutex::new(Vec::new()),
            attempt_failures: Mutex::new(Vec::new()),
            restarts: Mutex::new(Vec::new()),
            skips: Mutex::new(Vec::new()),
            gave_up: Mutex::new(false),
        };
        let history = Mutex::new(SuperviseHistory::default());
        let started = Instant::now();
        let outcome = run_restart_cycle(&history, &hooks, "killed-by-signal");
        let elapsed = started.elapsed();

        let CycleOutcome::Restarted { pid: new_pid, mode: RestartMode::Respawn } = outcome else {
            panic!("real webServer must respawn after SIGKILL, got {outcome:?}");
        };
        println!("[real-webserver] respawned pid={new_pid} after {elapsed:?}");
        assert_ne!(new_pid, old_pid);
        assert_eq!(*hooks.attempts.lock().unwrap(), vec![(1, 1000)]);
        assert!(http_health_ok(&health_url), "真 webServer 新 pid 必须答 /api/health 200");

        let respawned = hooks.respawned.lock().unwrap().take();
        if let Some(mut child) = respawned {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
