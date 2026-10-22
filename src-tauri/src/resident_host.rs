//! 常驻宿主（ADR-083）壳侧「附着还是新拉」决策（N-RESIDENT-HOST-SHELL-RUST）。
//!
//! 上一代壳用「后台继续」退出后，webServer 以守护形态继续跑（Node 侧
//! N-RESIDENT-HOST-DAEMON 落的 `<dataDir>/daemon.pid` 单实例锁）。这一代壳
//! 启动时要在 spawn 之前判断：那个守护还活着且健康吗？活着 → 附着（不 spawn、
//! 记下 pid 供之后的 cleanup 发信号，窗口直接导航到现有服务）；否则 → 按今日
//! 路径 spawn 新的。附着没有 `Child` 句柄（进程不是这次 spawn 的），停止并退出
//! 和应用内更新只能按 pid 发 SIGTERM。
//!
//! 判据逐条镜像 `src/host/services/daemon/daemonLock.ts`：
//! - pid 记录：JSON `{pid, startTime}`，旧版纯 pid 文本按 startTime=null；
//! - 身份核对：`ps -p <pid> -o lstart=,command=` 现场读，lstart 与持锁记录相等
//!   且命令行含 node（守护是 node 进程）才算「就是写文件的那个守护」；
//! - 平台：锁只在 mac/linux 生效（isDaemonLockSupported），其余平台恒 Spawn。
//!
//! 红线（台账 10-14）：本判定必须跑在 `clear_stale_web_server_port` **之前**——
//! 那条路径对端口占用者无差别 `kill -9`，活守护会被当陈旧占用者强杀。附着
//! 判定先行，判成 Spawn 才轮得到它。
//!
//! 纯逻辑（解析/核对/决策）不碰文件系统与网络，可单测；I/O 编排集中在
//! [`decide_startup_io`]，供 setup 在 worker 语义下同步调用（含一次只读 `ps`
//! 子进程与一次 2s 超时的 HTTP GET，与 setup 里已有的健康检查同量级）。

use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// pid 文件名，与 daemonLock.ts 的 DAEMON_PID_FILE 同源（落在数据目录根下）。
pub const DAEMON_PID_FILE: &str = "daemon.pid";
/// 附着探活的 /health 超时（连接+读），与 is_server_running / quit-guard 同档。
pub const ATTACH_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

/// pid 记录：`{pid, startTime}`（旧版纯 pid 文件 / 读不出标记的平台为 None）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonPidRecord {
    pub pid: u32,
    pub start_time: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// pid 记录解析（纯，镜像 daemonLock.ts readPidFile）
// ─────────────────────────────────────────────────────────────────────────────

/// 解析 daemon.pid 内容：优先按 JSON `{pid, startTime}`（pid 为正整数、
/// startTime 为字符串或 null，多余键容忍），失败再按旧版纯 pid 文本。
/// 两者都不成形 → None（按无记录 → Spawn 处理）。
pub fn parse_daemon_pid_record(raw: &str) -> Option<DaemonPidRecord> {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(object) = value.as_object() {
            let pid = object.get("pid").and_then(json_positive_integer);
            // startTime：缺失（undefined→null）或 JSON null → None；字符串 → Some；
            // 其他类型（数字等）与 JS 一样不认，落到旧版解析（对 JSON 文本必然失败）。
            let start_time = match object.get("startTime") {
                None | Some(serde_json::Value::Null) => Some(None),
                Some(serde_json::Value::String(text)) => Some(Some(text.clone())),
                _ => None,
            };
            if let (Some(pid), Some(start_time)) = (pid, start_time) {
                return Some(DaemonPidRecord { pid, start_time });
            }
        }
    }
    parse_legacy_pid(trimmed)
}

/// 镜像 JS `typeof pid === 'number' && Number.isInteger(pid) && pid > 0`：
/// JSON 里的 `3.0` 与 `3` 都是整数；pid 还须装得进 u32（进程 pid 的真实域）。
fn json_positive_integer(value: &serde_json::Value) -> Option<u32> {
    let number = value.as_f64()?;
    if number.fract() != 0.0 || number <= 0.0 || number > u32::MAX as f64 {
        return None;
    }
    Some(number as u32)
}

/// 旧版纯 pid 文本（镜像 `Number.parseInt(trimmed, 10)` 语义：可选正负号 +
/// 前导数字，后面跟什么都忽略），但 pid 必须 > 0 且不溢出 u32（溢出按读不出
/// 处理，fail-safe → Spawn）。
fn parse_legacy_pid(trimmed: &str) -> Option<DaemonPidRecord> {
    let mut chars = trimmed.chars().peekable();
    let negative = matches!(chars.peek(), Some('-'));
    if matches!(chars.peek(), Some('+') | Some('-')) {
        chars.next();
    }
    let mut pid: u64 = 0;
    let mut digits = 0usize;
    while let Some(&current) = chars.peek() {
        let Some(digit) = current.to_digit(10) else {
            break;
        };
        pid = pid.checked_mul(10)?.checked_add(u64::from(digit))?;
        digits += 1;
        chars.next();
    }
    if digits == 0 || negative || pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    Some(DaemonPidRecord {
        pid: pid as u32,
        start_time: None,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 进程身份核对（纯，镜像 daemonLock.ts readProcessIdentity / inspectDaemonPid）
// ─────────────────────────────────────────────────────────────────────────────

/// 记录是否仍是「写这份 pid 文件的守护」：ps 输出读得出、lstart 与持锁记录
/// 相等、命令行含 node。任一不满足（含 startTime 缺失的旧版记录、ps 无输出、
/// 僵尸进程）→ false。镜像 inspectDaemonPid 的 owned 判据；这里只回答
/// 「算不算我们的守护」，发信号/删除都归 Node 侧。
pub fn process_identity_matches(record: &DaemonPidRecord, ps_output: Option<&str>) -> bool {
    let Some(start_time) = record.start_time.as_deref() else {
        return false;
    };
    let Some((actual_start, command)) = ps_output.and_then(parse_ps_identity) else {
        return false;
    };
    // 僵尸（已退出未收尸）：kill(pid,0) 仍成功，但 Linux 部分版本 ps 的 command
    // 打 `[node] <defunct>`——含 node 也不能当活守护（daemonLock.ts:168 同款）。
    if command.ends_with("<defunct>") {
        return false;
    }
    actual_start == start_time && command.contains("node")
}

/// 逐字符镜像 daemonLock.ts 的正则
/// `/^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*)$/`。
/// lstart 形如 `Sat Oct 11 22:29:33 2026`（日月不足两位时补空格）。lstart 段按
/// 原文切片保留内部空白——记录里的 startTime 是同一正则在持锁时捕获的原文，
/// 比对是字符串相等，先归一化会漏掉「双空格日」。
fn parse_ps_identity(ps_output: &str) -> Option<(String, String)> {
    let text = ps_output.trim();
    let bytes = text.as_bytes();
    let mut pos = 0usize;

    let skip_ws = |bytes: &[u8], pos: &mut usize| -> bool {
        let start = *pos;
        while *pos < bytes.len() && matches!(bytes[*pos], b' ' | b'\t' | b'\r' | b'\n') {
            *pos += 1;
        }
        *pos > start
    };
    let take_digits = |bytes: &[u8], pos: &mut usize, count: usize| -> bool {
        for _ in 0..count {
            match bytes.get(*pos) {
                Some(byte) if byte.is_ascii_digit() => *pos += 1,
                _ => return false,
            }
        }
        true
    };
    let take_word_chars = |bytes: &[u8], pos: &mut usize, count: usize| -> bool {
        for _ in 0..count {
            match bytes.get(*pos) {
                Some(byte) if byte.is_ascii_alphanumeric() || *byte == b'_' => *pos += 1,
                _ => return false,
            }
        }
        true
    };

    if !take_word_chars(bytes, &mut pos, 3) || !skip_ws(bytes, &mut pos) {
        return None; // 周几缩写
    }
    if !take_word_chars(bytes, &mut pos, 3) || !skip_ws(bytes, &mut pos) {
        return None; // 月份缩写
    }
    if !take_digits(bytes, &mut pos, 1) {
        return None;
    }
    if bytes.get(pos).is_some_and(|byte| byte.is_ascii_digit()) {
        pos += 1; // 日 1-2 位
    }
    if !skip_ws(bytes, &mut pos) {
        return None;
    }
    for _ in 0..2 {
        // HH:MM:SS = 2 位数 × 3 段，段间冒号
        if !take_digits(bytes, &mut pos, 2) || bytes.get(pos) != Some(&b':') {
            return None;
        }
        pos += 1;
    }
    if !take_digits(bytes, &mut pos, 2) || !skip_ws(bytes, &mut pos) {
        return None; // 秒段不带尾冒号
    }
    if !take_digits(bytes, &mut pos, 4) {
        return None; // 年
    }
    let lstart_end = pos;
    if !skip_ws(bytes, &mut pos) {
        return None;
    }
    match bytes.get(pos) {
        Some(byte) if !byte.is_ascii_whitespace() => {}
        _ => return None, // 命令行首字符必须非空白（\S）
    }
    let lstart = text.get(0..lstart_end)?.to_string();
    let command = text.get(pos..)?.to_string();
    Some((lstart, command))
}

// ─────────────────────────────────────────────────────────────────────────────
// 附着决策（纯）
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupDecision {
    /// 活守护在场：不 spawn。调用方必须留下 pid，cleanup 才能发信号。
    Attach,
    /// 常规路径：spawn 新 webServer（打包态会先清陈旧端口占用）。
    Spawn,
}

/// 附着判定：pid 记录在场 + 身份吻合 + /health 200，三者齐备才 Attach；
/// 任一不满足（记录缺失/陈旧/不健康）一律 Spawn（fail-safe 回到今日行为）。
pub fn decide_startup(
    record: Option<&DaemonPidRecord>,
    identity_ok: bool,
    health_ok: bool,
) -> StartupDecision {
    if record.is_some() && identity_ok && health_ok {
        StartupDecision::Attach
    } else {
        StartupDecision::Spawn
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O helpers（薄封装，判据都在上面的纯函数里）
// ─────────────────────────────────────────────────────────────────────────────

/// 锁的平台判据，镜像 daemonLock.ts isDaemonLockSupported：win32 没有进程身份
/// 源（锁整个不生效），恒走 Spawn，Windows 行为与今日一致。
pub fn is_attach_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "linux"))
}

/// 读 `<data_dir>/daemon.pid` 并解析。缺失/读不出/形状不对 → None。
/// （daemonLock 对权限异常会 throw；壳侧读不出的任何原因都归并为 Spawn，
/// 不存在「读不出文件就不敢启动」的死锁面。）
pub fn read_daemon_pid_record(data_dir: &Path) -> Option<DaemonPidRecord> {
    let raw = std::fs::read_to_string(data_dir.join(DAEMON_PID_FILE)).ok()?;
    parse_daemon_pid_record(&raw)
}

/// 现场跑 `ps -p <pid> -o lstart=,command=`（只读，绝不发信号）。失败/空输出
/// → None（身份未知，按不匹配处理）。
pub fn ps_process_identity(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart=,command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if stdout.trim().is_empty() {
        return None;
    }
    Some(stdout)
}

/// GET 健康端点（2s 超时），200 才算健康。只打 localhost，绕开系统代理
/// （与 query_quit_guard 同款 client 构造）。
pub fn http_health_ok(health_endpoint: &str) -> bool {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(ATTACH_HEALTH_TIMEOUT)
        .no_proxy()
        .build()
    else {
        return false;
    };
    matches!(
        client.get(health_endpoint).send(),
        Ok(response) if response.status().as_u16() == 200
    )
}

/// 附着判定的 I/O 编排：读 pid 记录 → ps 身份核对 → /health 探活 → 纯决策。
/// 返回 `Some(record)` = Attach（pid 供 shell event 上报），`None` = Spawn。
/// 身份不吻合时跳过探活（陈旧 pid 不值得一次 HTTP）。
/// **必须在 `clear_stale_web_server_port` 之前调用**：判成 Spawn 才允许走
/// spawn 路径的端口清扫，活守护绝不能被 `kill -9`。
pub fn decide_startup_io(data_dir: Option<&Path>, health_endpoint: &str) -> Option<DaemonPidRecord> {
    if !is_attach_supported() {
        return None;
    }
    let record = data_dir.and_then(read_daemon_pid_record)?;
    let identity_ok = process_identity_matches(&record, ps_process_identity(record.pid).as_deref());
    if !identity_ok {
        return None;
    }
    let health_ok = http_health_ok(health_endpoint);
    match decide_startup(Some(&record), identity_ok, health_ok) {
        StartupDecision::Attach => Some(record),
        StartupDecision::Spawn => None,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 附着守护的停止（停止并退出 / 更新 / 关机 / 信号）
// ─────────────────────────────────────────────────────────────────────────────

/// cleanup 对「附着到的守护」能做什么。没有 Child 时这是唯一的停止通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachedStop {
    /// 身份仍是当初那个 node 守护：SIGTERM，超时再 SIGKILL。
    Signal { pid: u32 },
    /// 没有记下 pid，或身份已对不上（进程已死 / pid 被复用）：不发信号。
    Skip,
}

/// 附着记录在场且身份仍吻合才发信号。丢了记录（附着分支没保存）→ Skip，
/// 停止并退出和更新清理就没有进程可杀，旧守护继续占端口。
pub fn decide_attached_stop(record: Option<&DaemonPidRecord>, identity_ok: bool) -> AttachedStop {
    match record {
        Some(record) if identity_ok => AttachedStop::Signal { pid: record.pid },
        _ => AttachedStop::Skip,
    }
}

/// 现场再核对一次身份，吻合才发信号。ps 失败 / 僵尸 / pid 复用 → None（不杀）。
pub fn stop_attached_daemon(
    record: &DaemonPidRecord,
    timeout: Duration,
    poll: Duration,
) -> Option<String> {
    let identity_ok = process_identity_matches(record, ps_process_identity(record.pid).as_deref());
    match decide_attached_stop(Some(record), identity_ok) {
        AttachedStop::Signal { pid } => Some(terminate_attached_daemon(pid, timeout, poll)),
        AttachedStop::Skip => None,
    }
}

/// 向不是本进程 spawn 出来的守护发 SIGTERM，超时再 SIGKILL。
/// 不能 `wait`：它的父进程已经不是我们（init/launchd 收尸）。用 `kill(pid, 0)` 探活。
#[cfg(unix)]
pub fn terminate_attached_daemon(pid: u32, timeout: Duration, poll: Duration) -> String {
    let pid = pid as i32;
    // SAFETY: pid 刚通过 process_identity_matches（lstart 原文相等且命令行含 node）。
    // SIGTERM 与 spawn 子进程的 terminate_child 是同一条「请自行退出」信号。
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return "attached-already-gone".to_string();
        }
        // SAFETY: 同上，SIGKILL 只在 SIGTERM 发不出去时兜底。
        if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 {
            return format!(
                "attached-sigterm-send-failed:{}",
                std::io::Error::last_os_error()
            );
        }
        return "forced-sigkill-sigterm-send-failed".to_string();
    }
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        // SAFETY: 信号 0 只探活，不投递。
        if unsafe { libc::kill(pid, 0) } != 0 {
            return "graceful-sigterm".to_string();
        }
        std::thread::sleep(poll);
    }
    // SAFETY: 宽限用尽，与 terminate_child 的 forced-sigkill-timeout 同口径。
    if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 {
        return format!(
            "attached-sigkill-send-failed:{}",
            std::io::Error::last_os_error()
        );
    }
    "forced-sigkill-timeout".to_string()
}

#[cfg(not(unix))]
pub fn terminate_attached_daemon(_pid: u32, _timeout: Duration, _poll: Duration) -> String {
    // 附着判定在 win32 不成立（is_attach_supported）。这里只为两边都能编译。
    "attached-stop-unsupported".to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// 退出确认框按钮组（N-RESIDENT-HOST-SHELL-RUST-FU1）
// ─────────────────────────────────────────────────────────────────────────────

/// 退出确认框用哪套按钮。Windows 没有守护 pid 锁/附着（[`is_attach_supported`]
/// = false），重启必然 Spawn 并先跑 `clear_stale_web_server_port`，把「后台继续」
/// 特意留下的守护 taskkill /F 掉——按钮承诺了兑现不了的事，就不给（owner 10-17
/// 选 B：先藏按钮；pid 锁 + attach 是单独的 WIN-ATTACH 单）。判据只看附着是否
/// 成立，不写平台分支；WIN-ATTACH 落地后 `is_attach_supported()` 翻 true，
/// 三键自动回来。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitDialogButtonSet {
    /// 取消 / 停止并退出。槽位序见 [`QuitDialogButtonSet::ok_cancel_slots`]：
    /// 「取消」必须占 cancel 槽（Esc/标题栏 X 到达的文案），回车默认键因此
    /// 指向「停止并退出」。
    Two {
        cancel: &'static str,
        quit: &'static str,
    },
    /// 取消 / 后台继续 / 停止并退出（mac/linux 现状）。
    Three {
        cancel: &'static str,
        background_continue: &'static str,
        quit: &'static str,
    },
}

impl QuitDialogButtonSet {
    /// 两键组喂给 `MessageDialogButtons::OkCancelCustom(ok, cancel)` 的槽位序。
    /// cancel 槽位必须放安全动作「取消」：Esc / 标题栏 X（rfd `Cancel`，Windows
    /// TaskDialog 的 TDF_ALLOW_DIALOG_CANCELLATION 无条件开）会被
    /// tauri-plugin-dialog 2.7.1 的 desktop.rs 无条件映射成 cancel 槽位文案的
    /// `Custom`，非按钮手势绝不能落到退出路径（ai-review #2497）。代价：回车
    /// 默认键随 ok 槽位指向「停止并退出」——rfd 0.16 没有独立于槽位选默认键的
    /// 入口（NSAlert 首按钮 / TaskDialog nDefaultButton=0），两害相权，
    /// 误按 Esc/X 退出更危险。三键组不走 OkCancelCustom，返回 None。
    pub fn ok_cancel_slots(&self) -> Option<(&'static str, &'static str)> {
        match self {
            QuitDialogButtonSet::Two { cancel, quit } => Some((*quit, *cancel)),
            QuitDialogButtonSet::Three { .. } => None,
        }
    }
}

/// 纯判据：退出框要不要提供「后台继续」。
pub fn quit_dialog_offers_background_continue(attach_supported: bool) -> bool {
    attach_supported
}

/// 纯构造：附着成立 → 三键；不成立 → 两键（槽位序见
/// [`QuitDialogButtonSet::ok_cancel_slots`]）。
pub fn quit_dialog_button_set(attach_supported: bool) -> QuitDialogButtonSet {
    if quit_dialog_offers_background_continue(attach_supported) {
        QuitDialogButtonSet::Three {
            cancel: crate::quit_guard::QUIT_DIALOG_CANCEL_BUTTON,
            background_continue: crate::quit_guard::QUIT_DIALOG_BACKGROUND_BUTTON,
            quit: crate::quit_guard::QUIT_DIALOG_QUIT_BUTTON,
        }
    } else {
        QuitDialogButtonSet::Two {
            cancel: crate::quit_guard::QUIT_DIALOG_CANCEL_BUTTON,
            quit: crate::quit_guard::QUIT_DIALOG_QUIT_BUTTON,
        }
    }
}

/// 现场用哪套按钮：唯一判据 [`is_attach_supported`]，无平台分支。
pub fn quit_dialog_button_set_current() -> QuitDialogButtonSet {
    quit_dialog_button_set(is_attach_supported())
}

/// 防御（fail-safe）：这套按钮没提供「后台继续」时，即使该标签不知何故到达
/// （插件回归/未来改动），也绝不能行动成 BackgroundContinue——按取消处理，
/// 不退壳、不清理。
pub fn dialog_answer_action_gated(
    custom_label: Option<&str>,
    button_set: QuitDialogButtonSet,
) -> crate::quit_guard::QuitAnswerAction {
    match (
        crate::quit_guard::dialog_answer_action(custom_label),
        button_set,
    ) {
        (
            crate::quit_guard::QuitAnswerAction::BackgroundContinue,
            QuitDialogButtonSet::Two { .. },
        ) => crate::quit_guard::QuitAnswerAction::StayRunning,
        (action, _) => action,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quit_guard::QuitAnswerAction;

    const LSTART: &str = "Sat Oct 11 22:29:33 2026";
    const PS_NODE_LINE: &str = concat!(
        "Sat Oct 11 22:29:33 2026 ",
        "/usr/local/bin/node /Applications/Agent Neo.app/Contents/Resources/webServer.cjs"
    );

    fn record(pid: u32, start_time: Option<&str>) -> DaemonPidRecord {
        DaemonPidRecord {
            pid,
            start_time: start_time.map(str::to_string),
        }
    }

    // ── parse_daemon_pid_record：JSON 形态 ────────────────────────────────────

    #[test]
    fn parse_accepts_json_record_with_start_time() {
        assert_eq!(
            parse_daemon_pid_record(&format!(r#"{{"pid":123,"startTime":"{LSTART}"}}"#)),
            Some(record(123, Some(LSTART)))
        );
        // 多余键容忍（JS 只读 pid/startTime）
        assert_eq!(
            parse_daemon_pid_record(&format!(
                r#"{{"pid":123,"startTime":"{LSTART}","extra":true}}"#
            )),
            Some(record(123, Some(LSTART)))
        );
        // JSON null 与缺失的 startTime 都按 null（旧版/平台读不出）
        assert_eq!(
            parse_daemon_pid_record(r#"{"pid":123,"startTime":null}"#),
            Some(record(123, None))
        );
        assert_eq!(
            parse_daemon_pid_record(r#"{"pid":123}"#),
            Some(record(123, None))
        );
        // JS Number.isInteger(3.0) === true：整值浮点也是整数
        assert_eq!(
            parse_daemon_pid_record(r#"{"pid":3.0,"startTime":null}"#),
            Some(record(3, None))
        );
    }

    #[test]
    fn parse_rejects_malformed_json_shapes() {
        for raw in [
            r#"{"pid":"123","startTime":null}"#,      // 字符串 pid
            r#"{"pid":0,"startTime":null}"#,          // 非正数
            r#"{"pid":-5,"startTime":null}"#,         // 负数
            r#"{"pid":1.5,"startTime":null}"#,        // 非整浮点
            r#"{"pid":123,"startTime":5}"#,           // startTime 非字符串非 null
            r#"{"startTime":"x"}"#,                   // 缺 pid
            r#"{"pid":123456789012345678901,"startTime":null}"#, // 超 u32
            r#"["pid"]"#,                             // 数组不是对象
            r#"null"#,                                // JSON null 不是对象
            r#"not json at all"#,                     // 非法 JSON 且非纯 pid
            r#""#,                                    // 空
            r#"   "#,                                 // 全空白
        ] {
            assert_eq!(
                parse_daemon_pid_record(raw),
                None,
                "{raw} 不应解析出记录"
            );
        }
    }

    #[test]
    fn parse_accepts_legacy_plain_pid_text() {
        assert_eq!(parse_daemon_pid_record(" 456\n"), Some(record(456, None)));
        // Number.parseInt 语义：前导数字后跟杂字符仍取前导数字
        assert_eq!(parse_daemon_pid_record("456abc"), Some(record(456, None)));
        assert_eq!(parse_daemon_pid_record("+8"), Some(record(8, None)));
        // 纯数字也是合法 JSON（非对象）→ 落到旧版解析
        assert_eq!(parse_daemon_pid_record("123"), Some(record(123, None)));
        // parseInt 在第一个非数字字符处截断：12.5 → 12
        assert_eq!(parse_daemon_pid_record("12.5"), Some(record(12, None)));
        for raw in ["-7", "0", "abc"] {
            assert_eq!(parse_daemon_pid_record(raw), None, "{raw} 不应解析出记录");
        }
    }

    // ── process_identity_matches ──────────────────────────────────────────────

    #[test]
    fn identity_matches_live_daemon() {
        assert!(process_identity_matches(
            &record(123, Some(LSTART)),
            Some(PS_NODE_LINE)
        ));
        // 命令行只要含 node（守护是 node 进程，路径任意）
        assert!(process_identity_matches(
            &record(123, Some(LSTART)),
            Some("Sat Oct 11 22:29:33 2026 node")
        ));
        // 结尾的换行/空白（execFileSync 原文）无影响
        assert!(process_identity_matches(
            &record(123, Some(LSTART)),
            Some(&format!("{PS_NODE_LINE}\n"))
        ));
    }

    #[test]
    fn identity_rejects_mismatch_or_non_node() {
        // lstart 不等（pid 被复用）
        assert!(!process_identity_matches(
            &record(123, Some("Sun Jan  1 00:00:00 2026")),
            Some(PS_NODE_LINE)
        ));
        // 命令行不含 node
        assert!(!process_identity_matches(
            &record(123, Some(LSTART)),
            Some("Sat Oct 11 22:29:33 2026 /usr/sbin/syslogd")
        ));
        // 旧版记录没有 startTime → 身份证明不了
        assert!(!process_identity_matches(&record(123, None), Some(PS_NODE_LINE)));
        // ps 无输出（进程不在/平台读不出）
        assert!(!process_identity_matches(&record(123, Some(LSTART)), None));
        // ps 输出不是 lstart+command 形状
        assert!(!process_identity_matches(
            &record(123, Some(LSTART)),
            Some("no lstart here")
        ));
    }

    #[test]
    fn identity_rejects_zombie_even_when_line_contains_node() {
        // Linux 部分版本对僵尸打 `[comm] <defunct>`：含 node 也不是活守护
        assert!(!process_identity_matches(
            &record(123, Some(LSTART)),
            Some("Sat Oct 11 22:29:33 2026 [node] <defunct>")
        ));
    }

    #[test]
    fn identity_preserves_inner_whitespace_of_lstart() {
        // 单数字日：ps 用补空格对齐（`Oct  4` 双空格），记录捕获的是原文——
        // 先归一化空白会把这条误判成不匹配。
        let ps = "Sat Oct  4 08:09:10 2026 node daemon";
        assert!(process_identity_matches(&record(123, Some("Sat Oct  4 08:09:10 2026")), Some(ps)));
        assert!(!process_identity_matches(&record(123, Some("Sat Oct 4 08:09:10 2026")), Some(ps)));
    }

    // ── decide_startup：三条件全真才 Attach ───────────────────────────────────

    #[test]
    fn decide_startup_attaches_only_on_record_identity_health() {
        let live = record(123, Some(LSTART));
        let cases: &[(Option<&DaemonPidRecord>, bool, bool, StartupDecision)] = &[
            (Some(&live), true, true, StartupDecision::Attach),
            (Some(&live), true, false, StartupDecision::Spawn), // 不健康
            (Some(&live), false, true, StartupDecision::Spawn), // 陈旧 pid
            (Some(&live), false, false, StartupDecision::Spawn),
            (None, true, true, StartupDecision::Spawn),          // 记录缺失
            (None, false, false, StartupDecision::Spawn),
        ];
        for (parsed, identity_ok, health_ok, expected) in cases {
            assert_eq!(
                decide_startup(*parsed, *identity_ok, *health_ok),
                *expected,
                "({parsed:?}, identity={identity_ok}, health={health_ok}) 应为 {expected:?}"
            );
        }
    }

    // ── 附着后的停止：记下的活 pid 必须能被 cleanup 发信号 ────────────────────

    #[test]
    fn attached_stop_signals_only_a_live_matching_daemon() {
        let live = record(4242, Some(LSTART));
        assert_eq!(
            decide_attached_stop(Some(&live), true),
            AttachedStop::Signal { pid: 4242 },
            "身份仍吻合的附着守护必须被发信号，否则停止并退出和更新都杀不掉它"
        );
        assert_eq!(
            decide_attached_stop(Some(&live), false),
            AttachedStop::Skip,
            "身份对不上（pid 复用 / 进程已死）不能发信号"
        );
        assert_eq!(
            decide_attached_stop(None, true),
            AttachedStop::Skip,
            "没留下 pid 记录时 cleanup 没有进程可杀"
        );
        assert_eq!(decide_attached_stop(None, false), AttachedStop::Skip);
    }

    #[test]
    fn attach_sites_keep_the_pid_and_quit_arms_detach_before_exit() {
        let main = include_str!("main.rs");
        let needle = "let Some(record) = attach_daemon";
        let mut rest = main;
        let mut arms = 0;
        while let Some(index) = rest.find(needle) {
            let after = &rest[index..];
            let end = after
                .find("} else {")
                .expect("附着分支后面应有 spawn 的 else");
            let body = &after[..end];
            assert!(
                body.contains("store_attached_daemon"),
                "附着分支必须留下 pid，cleanup 才杀得掉守护:\n{body}"
            );
            arms += 1;
            rest = &after[end + 1..];
        }
        assert_eq!(arms, 2, "setup 与 recreate_main_window 都要留下附着 pid");
        assert!(
            main.contains("stop_attached_daemon("),
            "cleanup 必须走到按 pid 发信号的路径"
        );

        let dialog = main
            .find("fn show_quit_confirm_dialog")
            .expect("quit dialog");
        let dialog_body = &main[dialog..];
        let arm_at = dialog_body
            .find("arm_background_continue_detach(")
            .expect("后台继续在 Windows 上必须先 arm detach");
        let exit_at = dialog_body.find("app.exit(0)").expect("dialog exits");
        assert!(
            arm_at < exit_at,
            "arm 必须发生在退壳之前，否则 EOF 先到、通知还没落地"
        );
    }

    // ── 退出确认框按钮组（N-RESIDENT-HOST-SHELL-RUST-FU1） ──────────────────────

    #[test]
    fn quit_dialog_button_set_two_buttons_when_attach_unsupported() {
        // Windows：附着不成立 → 只给 取消 / 停止并退出 两键
        assert_eq!(
            quit_dialog_button_set(false),
            QuitDialogButtonSet::Two {
                cancel: "取消",
                quit: "停止并退出",
            },
            "附着不成立时不得提供「后台继续」——重启首跑端口清扫会把它留下的守护 taskkill 掉"
        );
    }

    #[test]
    fn quit_dialog_button_set_three_buttons_when_attach_supported() {
        // mac/linux：三键照旧，顺序 取消 / 后台继续 / 停止并退出
        assert_eq!(
            quit_dialog_button_set(true),
            QuitDialogButtonSet::Three {
                cancel: "取消",
                background_continue: "后台继续",
                quit: "停止并退出",
            },
            "附着成立时按钮组必须与既有三键版完全一致"
        );
    }

    #[test]
    fn two_button_answer_mapping_never_yields_background_continue() {
        // 两键版：取消 → StayRunning，停止并退出 → Quit；
        // 「后台继续」标签即使不知何故到达（插件回归/未来改动）也绝不行动。
        let set = quit_dialog_button_set(false);
        assert_eq!(
            dialog_answer_action_gated(Some("取消"), set),
            QuitAnswerAction::StayRunning
        );
        assert_eq!(
            dialog_answer_action_gated(Some("停止并退出"), set),
            QuitAnswerAction::Quit
        );
        assert_eq!(
            dialog_answer_action_gated(Some("后台继续"), set),
            QuitAnswerAction::StayRunning,
            "没提供「后台继续」按钮时，该标签绝不能行动成 BackgroundContinue"
        );
        // 关闭对话框（None）与未知标签照旧不退出
        assert_eq!(
            dialog_answer_action_gated(None, set),
            QuitAnswerAction::StayRunning
        );
        assert_eq!(
            dialog_answer_action_gated(Some("whatever"), set),
            QuitAnswerAction::StayRunning
        );
    }

    #[test]
    fn two_button_dismiss_result_is_stay_running() {
        // ai-review #2497：Esc / 标题栏 X（Windows TaskDialog 的
        // TDF_ALLOW_DIALOG_CANCELLATION 无条件开 → rfd `Cancel`）被
        // tauri-plugin-dialog 2.7.1 无条件映射成 cancel 槽位文案的 `Custom`。
        // 两键组的 cancel 槽位（OkCancelCustom 第二参）必须放安全动作「取消」，
        // 非按钮手势才不会落到退出路径。
        let set = quit_dialog_button_set(false);
        let slots = set.ok_cancel_slots().expect("两键组必有 ok/cancel 槽位");
        // 槽位序钉死：退出动作占 ok 槽，「取消」占 cancel 槽
        assert_eq!(
            slots,
            ("停止并退出", "取消"),
            "cancel 槽位（OkCancelCustom 第二参）必须是「取消」：Esc/X 到达的就是这个文案"
        );
        // dismiss 到达应用侧的 payload = cancel 槽位文案，走闭包同一条 gated 映射
        assert_eq!(
            dialog_answer_action_gated(Some(slots.1), set),
            QuitAnswerAction::StayRunning,
            "非按钮手势（Esc/标题栏 X）绝不能退出"
        );
    }

    #[test]
    fn three_button_answer_mapping_unchanged() {
        // 三键版（mac/linux）：逐标签与既有 dialog_answer_action 一致，行为不变
        let set = quit_dialog_button_set(true);
        assert_eq!(
            dialog_answer_action_gated(Some("取消"), set),
            QuitAnswerAction::StayRunning
        );
        assert_eq!(
            dialog_answer_action_gated(Some("后台继续"), set),
            QuitAnswerAction::BackgroundContinue
        );
        assert_eq!(
            dialog_answer_action_gated(Some("停止并退出"), set),
            QuitAnswerAction::Quit
        );
        assert_eq!(
            dialog_answer_action_gated(None, set),
            QuitAnswerAction::StayRunning
        );
    }
}
