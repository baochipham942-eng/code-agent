//! 常驻宿主附着的 Windows 半边（N-RESIDENT-HOST-SHELL-WIN-ATTACH · LOGIC half）。
//!
//! 壳侧附着判据的镜像见 [`crate::resident_host`]；本模块补 Windows 的进程身份
//! 源与停止通道，判据逐条镜像 `src/host/services/daemon/daemonLock.ts` 的
//! win32 分支：
//! - 身份探针：`powershell -NoProfile -NonInteractive -Command` 跑
//!   [`windows_identity_probe_script`]（与 daemonLock.ts 的
//!   windowsIdentityProbeScript 是同一字符串，改就两边一起改），stdout 形如
//!   `2026-10-23T08:15:42.1234567Z C:\...\node.exe ...`——CreationDate 转 UTC
//!   按 ISO-8601 round-trip（'o'）输出，空格后跟 CommandLine；
//! - 身份吻合：creation time 与持锁记录相等 + 命令行含 node（win32 镜像名
//!   大小写不固定，node.exe / NODE.EXE 按小写比对）；
//! - 停止：`taskkill /PID <pid> /T`（请求关闭）→ 轮询 tasklist → 宽限用尽
//!   再 `/T /F` 强杀，镜像 unix 侧 SIGTERM → poll → SIGKILL 的节奏。
//!
//! **开关保持关闭**（[`WINDOWS_ATTACH_ENABLED`] = false）：探针输出形状是文档
//! 口径的夹具，还没在真 Windows 机上验过。WIN-ATTACH-REALDEVICE 单独翻开关
//! 并做三项真机检查（探针实输出、taskkill 优雅停覆盖面、CRLF/编码）。关闭
//! 期间 [`crate::resident_host::is_attach_supported`] 在 Windows 恒 false，
//! 启动恒 Spawn、退出框恒两键，行为与开关落地前一致。
//!
//! 纯逻辑（脚本构造/解析/判别/参数构造）不碰进程，全平台编译、在 macOS CI
//! 上单测；探针与 taskkill 的薄 runner 也全平台编译（`windows_command_no_window`
//! 的 CREATE_NO_WINDOW 才是 cfg 门控），只在 Windows 上被调用——运行时入口都
//! 隔着 `cfg!(windows)` 平台分支或 [`WINDOWS_ATTACH_ENABLED`]。

use crate::resident_host::DaemonPidRecord;
use std::process::Command;
use std::time::Duration;

/// Windows 附着开关。true = 身份源与附着判定在 Windows 生效（REALDEVICE 翻）；
/// false = Windows 行为与今日一致（恒 Spawn、两键退出框、无锁）。
pub const WINDOWS_ATTACH_ENABLED: bool = false;

/// 附着平台判据（纯，镜像 daemonLock.ts isDaemonLockSupported 的
/// WEB_DAEMON.WINDOWS_LOCK_ENABLED 分支）。unix 恒真；windows 看开关；两者皆非
/// （不存在的目标）恒假。`is_attach_supported()` 用真实 cfg 值调它，测试用
/// `windows_enabled=true` 调它钉 Windows 分支。
pub fn attach_supported_on(is_unix: bool, is_windows: bool, windows_enabled: bool) -> bool {
    if is_unix {
        return true;
    }
    is_windows && windows_enabled
}

// ─────────────────────────────────────────────────────────────────────────────
// 身份探针（纯构造 + 薄 runner）
// ─────────────────────────────────────────────────────────────────────────────

/// win32 身份探针脚本（与 daemonLock.ts windowsIdentityProbeScript 同一字符串）。
/// pid 不存在时 `if ($p)` 不成立、输出为空；CommandLine 为 null 时只有时间戳。
pub fn windows_identity_probe_script(pid: u32) -> String {
    format!(
        "$p = Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\"; \
         if ($p) {{ $p.CreationDate.ToUniversalTime().ToString('o') + ' ' + $p.CommandLine }}"
    )
}

/// 解析探针 stdout（纯，镜像 daemonLock.ts parseWindowsIdentityOutput）：
/// `<ISO-8601 时间戳><空白><非空命令行>` → `(startTime, command)`；形状不对 /
/// 空 / 只有时间戳（CommandLine 为 null）→ None（身份未知，fail-closed）。
/// 时间戳档位：'o' round-trip 固定 7 位小数，这里容忍 0-7 位变体。
pub fn parse_windows_identity(output: &str) -> Option<(String, String)> {
    let text = output.trim();
    let bytes = text.as_bytes();
    let mut pos = 0usize;

    let take_digits = |bytes: &[u8], pos: &mut usize, count: usize| -> bool {
        for _ in 0..count {
            match bytes.get(*pos) {
                Some(byte) if byte.is_ascii_digit() => *pos += 1,
                _ => return false,
            }
        }
        true
    };
    let take_byte = |bytes: &[u8], pos: &mut usize, expected: u8| -> bool {
        if bytes.get(*pos) == Some(&expected) {
            *pos += 1;
            true
        } else {
            false
        }
    };
    // 镜像 TS 正则的 `\s+` 分隔（trim 后实际是单个空格，防御性全收）
    let skip_ws = |bytes: &[u8], pos: &mut usize| -> bool {
        let start = *pos;
        while matches!(
            bytes.get(*pos),
            Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
        ) {
            *pos += 1;
        }
        *pos > start
    };

    // 日期段 YYYY-MM-DDT
    if !take_digits(bytes, &mut pos, 4) || !take_byte(bytes, &mut pos, b'-') {
        return None;
    }
    if !take_digits(bytes, &mut pos, 2) || !take_byte(bytes, &mut pos, b'-') {
        return None;
    }
    if !take_digits(bytes, &mut pos, 2) || !take_byte(bytes, &mut pos, b'T') {
        return None;
    }
    // 时间段 HH:MM:SS（第三段不带尾冒号）
    for _ in 0..2 {
        if !take_digits(bytes, &mut pos, 2) || !take_byte(bytes, &mut pos, b':') {
            return None;
        }
    }
    if !take_digits(bytes, &mut pos, 2) {
        return None;
    }
    // 可选小数段：'.' 后至少 1 位、至多 7 位
    if take_byte(bytes, &mut pos, b'.') {
        let start = pos;
        while matches!(bytes.get(pos), Some(byte) if byte.is_ascii_digit()) {
            pos += 1;
        }
        if pos == start || pos - start > 7 {
            return None;
        }
    }
    if !take_byte(bytes, &mut pos, b'Z') {
        return None;
    }
    let start_time_end = pos;
    if !skip_ws(bytes, &mut pos) {
        return None; // 没有命令段：CommandLine 为 null / 只有时间戳
    }
    if pos >= bytes.len() {
        return None; // 命令段非空（\S）
    }
    let start_time = text.get(0..start_time_end)?.to_string();
    let command = text.get(pos..)?.to_string();
    Some((start_time, command))
}

/// Windows 身份吻合判据（镜像 daemonLock.ts 的 win32 分支 + resident_host.rs
/// process_identity_matches 的结构）：creation time 与持锁记录相等且命令行含
/// node（大小写不敏感）。任一不满足（含 startTime 缺失、探针无输出、CommandLine
/// 为 null）→ false。
pub fn windows_identity_matches(record: &DaemonPidRecord, probe_output: Option<&str>) -> bool {
    let Some(start_time) = record.start_time.as_deref() else {
        return false;
    };
    let Some((actual_start, command)) = probe_output.and_then(parse_windows_identity) else {
        return false;
    };
    actual_start == start_time && command.to_ascii_lowercase().contains("node")
}

/// 跑身份探针（只读，绝不发信号）。失败 / 空输出 → None（身份未知）。
/// 全平台编译；运行时入口（`ps_process_identity` 的 cfg!(windows) 分支）只在
/// Windows 上走到。
pub fn windows_process_identity(pid: u32) -> Option<String> {
    let output = windows_command_no_window("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &windows_identity_probe_script(pid),
        ])
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

// ─────────────────────────────────────────────────────────────────────────────
// 附着守护的停止（taskkill：优雅 → 轮询 → 强杀）
// ─────────────────────────────────────────────────────────────────────────────

/// taskkill 参数构造（纯）：优雅档 `/PID <pid> /T`，强杀档再加 `/F`。
/// `/T` 连树杀（webServer 的子孙），镜像 unix 侧对守护本体发信号、宽限后
/// SIGKILL 的两段节奏。
pub fn windows_taskkill_args(pid: u32, force: bool) -> Vec<String> {
    let mut args = vec!["/PID".to_string(), pid.to_string(), "/T".to_string()];
    if force {
        args.push("/F".to_string());
    }
    args
}

/// 解析 `tasklist /FI "PID eq N" /FO CSV /NH` 输出，判 pid 是否仍被列出
/// （纯）。在场行形如 `"node.exe","1234","Console","1","1,234 K"`（按 `","`
/// 切字段，工作集自带逗号所以不能整行 split(',')）；无匹配时 tasklist 打一行
/// 无引号的 INFO:，切不出第二字段 → 不在场。
fn tasklist_reports_pid(output: &str, expected_pid: u32) -> bool {
    for line in output.lines() {
        let mut fields = line.trim().split("\",\"");
        let _image_name = fields.next();
        let Some(pid_field) = fields.next() else {
            continue;
        };
        if pid_field.trim_matches('"').parse::<u32>() == Ok(expected_pid) {
            return true;
        }
    }
    false
}

/// pid 是否仍活着（薄 runner，只读）。tasklist 查询失败按不在场处理（身份在
/// 调用前已核对过，误判的后果只是提前进入强杀，与 unix 侧 kill(pid,0) 失败
/// 同款）。
fn windows_process_is_alive(pid: u32) -> bool {
    let Ok(output) = windows_command_no_window("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    tasklist_reports_pid(&String::from_utf8_lossy(&output.stdout), pid)
}

/// Windows 版 terminate：`taskkill /PID <pid> /T` 请求关闭 → 轮询 tasklist →
/// 宽限用尽再 `/T /F` 强杀（镜像 unix 侧 SIGTERM → poll → SIGKILL）。退出码
/// 语义对齐 unix 版：attached-already-gone / graceful-* / forced-*。
/// 注意：taskkill 不带 /F 是给有窗口的进程投 WM_CLOSE，无窗口的 node 守护可能
/// 直接失败——失败即走强杀兜底（unix 侧 SIGTERM 发不出去也立即 SIGKILL），
/// 优雅停（排空）在 Windows 上的真实覆盖面归 REALDEVICE 验证。
pub fn terminate_attached_daemon_windows(pid: u32, timeout: Duration, poll: Duration) -> String {
    if !windows_process_is_alive(pid) {
        return "attached-already-gone".to_string();
    }
    if !run_taskkill(pid, false) {
        // 优雅档发不出去（无窗口进程 / 权限）：立即强杀兜底
        return if run_taskkill(pid, true) {
            "forced-taskkill-graceful-send-failed".to_string()
        } else {
            "attached-taskkill-send-failed".to_string()
        };
    }
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !windows_process_is_alive(pid) {
            return "graceful-taskkill".to_string();
        }
        std::thread::sleep(poll);
    }
    if run_taskkill(pid, true) {
        "forced-taskkill-timeout".to_string()
    } else {
        "forced-taskkill-send-failed".to_string()
    }
}

fn run_taskkill(pid: u32, force: bool) -> bool {
    windows_command_no_window("taskkill")
        .args(windows_taskkill_args(pid, force))
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Windows GUI 壳拉起 console 子进程（powershell/taskkill/tasklist）默认弹黑窗，
/// CREATE_NO_WINDOW 抑制（main.rs 同款判据，那边是私有函数不共享）。非 Windows
/// 编译目标上退化为裸 Command——不可达（调用链隔着 cfg!(windows) 分支或开关），
/// 只为让纯逻辑与 runner 在 macOS CI 上编译 + lint。
fn windows_command_no_window(program: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(program)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resident_host::{
        decide_startup, is_attach_supported, quit_dialog_button_set, DaemonPidRecord,
        QuitDialogButtonSet, StartupDecision,
    };

    const WIN_TS: &str = "2026-10-23T08:15:42.1234567Z";
    const WIN_NODE_LINE: &str = concat!(
        "2026-10-23T08:15:42.1234567Z ",
        r#""C:\Program Files\Agent Neo\resources\node.exe" C:\Users\x\AppData\Local\com.linchen.code-agent\resources\webServer.cjs"#
    );

    fn record(pid: u32, start_time: Option<&str>) -> DaemonPidRecord {
        DaemonPidRecord {
            pid,
            start_time: start_time.map(str::to_string),
        }
    }

    // ── 探针脚本：与 daemonLock.ts 同一字符串 ────────────────────────────────

    #[test]
    fn probe_script_matches_daemon_lock_ts() {
        assert_eq!(
            windows_identity_probe_script(4242),
            "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=4242\"; if ($p) { \
             $p.CreationDate.ToUniversalTime().ToString('o') + ' ' + $p.CommandLine }"
        );
    }

    // ── parse_windows_identity：文档口径夹具（非真机抓取，REALDEVICE 验） ────

    #[test]
    fn parse_accepts_documented_probe_shape() {
        assert_eq!(
            parse_windows_identity(WIN_NODE_LINE),
            Some((
                WIN_TS.to_string(),
                r#""C:\Program Files\Agent Neo\resources\node.exe" C:\Users\x\AppData\Local\com.linchen.code-agent\resources\webServer.cjs"#.to_string()
            ))
        );
        // 结尾 CRLF（PowerShell 换行）无影响
        assert_eq!(
            parse_windows_identity(&format!("{WIN_NODE_LINE}\r\n")),
            parse_windows_identity(WIN_NODE_LINE)
        );
        // 小数位变体：'o' 档固定 7 位，容忍 0-7 位
        for fraction in ["", ".1", ".123", ".1234567"] {
            let line = format!("2026-10-23T08:15:42{fraction}Z node.exe webServer.cjs");
            assert_eq!(
                parse_windows_identity(&line),
                Some((
                    format!("2026-10-23T08:15:42{fraction}Z"),
                    "node.exe webServer.cjs".to_string()
                )),
                "小数位 {fraction:?} 应可解析"
            );
        }
    }

    #[test]
    fn parse_rejects_empty_null_commandline_and_garbled_shapes() {
        // 空输出（pid 不存在：if ($p) 不成立）
        assert_eq!(parse_windows_identity(""), None);
        assert_eq!(parse_windows_identity("   \r\n"), None);
        // CommandLine 为 null：'时间戳 + 空格' 拼接 null 折叠成空串，只剩时间戳
        assert_eq!(parse_windows_identity(&format!("{WIN_TS} ")), None);
        assert_eq!(parse_windows_identity(WIN_TS), None);
        // 时间戳不成形状：空格代替 T、丢 Z、8 位小数、月份乱写
        assert_eq!(parse_windows_identity("2026-10-23 08:15:42.1234567Z node.exe"), None);
        assert_eq!(parse_windows_identity("2026-10-23T08:15:42.1234567 node.exe"), None);
        assert_eq!(
            parse_windows_identity("2026-13-23T08:15:42Z node.exe"),
            Some(("2026-13-23T08:15:42Z".to_string(), "node.exe".to_string())),
            "日历合法性不在形状判据内（比对是字符串相等，乱月份两头一致才可能吻合）"
        );
        assert_eq!(
            parse_windows_identity("2026-10-23T08:15:42.12345678Z node.exe"),
            None
        );
        // PowerShell 报错文本 / 非 ISO 前缀
        assert_eq!(parse_windows_identity("Get-CimInstance : 拒绝访问。"), None);
        assert_eq!(parse_windows_identity("node.exe 但没有时间戳"), None);
    }

    // ── windows_identity_matches：owned 判据的 win32 镜像 ────────────────────

    #[test]
    fn identity_matches_live_windows_node_daemon() {
        assert!(windows_identity_matches(
            &record(4242, Some(WIN_TS)),
            Some(WIN_NODE_LINE)
        ));
        // 镜像名大小写不固定（node.exe / NODE.EXE），按小写比对
        assert!(windows_identity_matches(
            &record(4242, Some(WIN_TS)),
            Some(&format!(
                "{WIN_TS} C:\\Tools\\NODE.EXE webServer.cjs"
            ))
        ));
        // 结尾换行（Command::output 原文）无影响
        assert!(windows_identity_matches(
            &record(4242, Some(WIN_TS)),
            Some(&format!("{WIN_NODE_LINE}\r\n"))
        ));
    }

    #[test]
    fn identity_rejects_reuse_non_node_or_missing_identity() {
        // creation time 不同（pid 已被复用）
        assert!(!windows_identity_matches(
            &record(4242, Some("2020-01-02T03:04:05.0000000Z")),
            Some(WIN_NODE_LINE)
        ));
        // 非 node 镜像（pid 归了别的进程）
        assert!(!windows_identity_matches(
            &record(4242, Some(WIN_TS)),
            Some(&format!(
                "{WIN_TS} C:\\Windows\\System32\\msedgewebview2.exe --type=renderer"
            ))
        ));
        // 旧版记录没有 startTime / 探针无输出（CommandLine 为 null 折叠后解析不出）
        assert!(!windows_identity_matches(&record(4242, None), Some(WIN_NODE_LINE)));
        assert!(!windows_identity_matches(&record(4242, Some(WIN_TS)), None));
        assert!(!windows_identity_matches(&record(4242, Some(WIN_TS)), Some(&format!("{WIN_TS} "))));
    }

    // ── attach_supported_on：开关关闭 = Windows 行为不变 ─────────────────────

    #[test]
    fn attach_supported_truth_table() {
        // unix 恒真（现状 mac/linux）
        assert!(attach_supported_on(true, false, false));
        assert!(attach_supported_on(true, true, true));
        // windows 看开关
        assert!(!attach_supported_on(false, true, false), "开关关闭：Windows 附着不成立");
        assert!(attach_supported_on(false, true, true), "REALDEVICE 翻开关后成立");
        // 两者皆非（不存在的目标）恒假
        assert!(!attach_supported_on(false, false, true));
    }

    #[test]
    fn is_attach_supported_delegates_to_pure_predicate_with_real_cfg() {
        assert_eq!(
            is_attach_supported(),
            attach_supported_on(
                cfg!(any(target_os = "macos", target_os = "linux")),
                cfg!(target_os = "windows"),
                WINDOWS_ATTACH_ENABLED
            )
        );
        // 本测试运行在 macOS CI 上：unix 侧开关未动，行为与落地前一致
        assert!(is_attach_supported());
    }

    // ①（验收）开关 OFF：Windows 启动恒 Spawn、退出框两键 —— 零行为变化
    #[test]
    fn windows_flag_off_keeps_spawn_and_two_button_dialog() {
        let windows_attach = attach_supported_on(false, true, WINDOWS_ATTACH_ENABLED);
        assert!(!windows_attach);
        // decide_startup_io 的第一道闸是 is_attach_supported()：false → None（Spawn）
        assert_eq!(
            decide_startup_io_gate(windows_attach, Some(&record(4242, Some(WIN_TS)))),
            StartupDecision::Spawn
        );
        // 退出框按钮组唯一判据是附着是否成立：两键（取消 / 停止并退出）
        assert_eq!(
            quit_dialog_button_set(windows_attach),
            QuitDialogButtonSet::Two {
                cancel: crate::quit_guard::QUIT_DIALOG_CANCEL_BUTTON,
                quit: crate::quit_guard::QUIT_DIALOG_QUIT_BUTTON,
            }
        );
    }

    // ②（验收）开关 ON（纯函数翻转）：记录 + 身份 + 健康三者齐备才 Attach
    #[test]
    fn windows_flag_on_attaches_only_on_record_identity_health() {
        assert!(attach_supported_on(false, true, true));
        let live = record(4242, Some(WIN_TS));
        let identity_ok = windows_identity_matches(&live, Some(WIN_NODE_LINE));
        assert!(identity_ok, "Windows 夹具上身份吻合必须成立（Attach 的前提）");
        let cases: &[(bool, bool, StartupDecision)] = &[
            (true, true, StartupDecision::Attach),
            (true, false, StartupDecision::Spawn), // 不健康 → Spawn（接管/新拉）
            (false, true, StartupDecision::Spawn), // 记录缺失/身份不符 → Spawn
            (false, false, StartupDecision::Spawn),
        ];
        for &(identity, health, expected) in cases {
            assert_eq!(
                decide_startup(Some(&live), identity, health),
                expected,
                "identity={identity} health={health} 应为 {expected:?}"
            );
        }
        // 身份不符的两个具体形状：creation time 不同（pid 复用）/ 非 node 镜像
        assert!(!windows_identity_matches(
            &record(4242, Some("2020-01-02T03:04:05.0000000Z")),
            Some(WIN_NODE_LINE)
        ));
        assert!(!windows_identity_matches(
            &live,
            Some("2026-10-23T08:15:42.1234567Z C:\\Windows\\System32\\svchost.exe")
        ));
    }

    /// decide_startup_io 的第一道闸（is_attach_supported）单独拎出来验：false 时
    /// 无论记录多好看都 Spawn——与 decide_startup_io 的短路结构一致（那里
    /// `if !is_attach_supported() { return None }` 在读文件之前）。
    fn decide_startup_io_gate(
        attach_supported: bool,
        record: Option<&DaemonPidRecord>,
    ) -> StartupDecision {
        if !attach_supported {
            return StartupDecision::Spawn;
        }
        decide_startup(record, true, true)
    }

    // ── taskkill 参数与 tasklist 解析 ─────────────────────────────────────────

    #[test]
    fn taskkill_args_grace_then_force() {
        assert_eq!(
            windows_taskkill_args(4242, false),
            vec!["/PID", "4242", "/T"],
            "优雅档：请求关闭（树杀，无 /F）"
        );
        assert_eq!(
            windows_taskkill_args(4242, true),
            vec!["/PID", "4242", "/T", "/F"],
            "强杀档：宽限用尽后的兜底"
        );
    }

    #[test]
    fn tasklist_reports_pid_only_for_the_queried_pid() {
        let output = "\"node.exe\",\"4242\",\"Console\",\"1\",\"12,345 K\"\r\n";
        assert!(tasklist_reports_pid(output, 4242));
        // 无匹配：tasklist 打 INFO 行（无引号字段），不在场
        assert!(!tasklist_reports_pid(
            "INFO: No tasks are running which match the specified criteria.",
            4242
        ));
        // 在场但 pid 不是要找的那个
        assert!(!tasklist_reports_pid(output, 9999));
        // 空输出
        assert!(!tasklist_reports_pid("", 4242));
    }
}
