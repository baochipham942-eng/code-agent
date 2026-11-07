// Appshots 左右 Cmd 热键的「装 / 不装」决策 —— 纯函数，不碰 FFI（FFI 在 appshots.rs 的
// dual_command_hotkey 里）。为什么要有这道门（FB-457）：启动直接 CGEventTapCreate 会在
// 未授权时弹系统「Keystroke Receiving」框，且每个新 Dev 槽（新 bundle id）都会再弹一遍。
// 决策：启动只 preflight（静默）；未授权不装不问；Dev 通道启动一律不装；只有设置页的
// 「开启快捷键」按钮（explicit_request=true）才允许触发系统询问。

/// `decide_hotkey_install` 的输出；调用方（appshots.rs）按分支落日志 / 装 tap。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyInstallDecision {
    /// 已授权（或显式请求后已授权）→ 现在（幂等）安装 tap。
    Install,
    /// 未授权且非显式请求 → 不装 tap、不弹框，只打一行可区分日志。
    SkipNoPermission,
    /// Dev 通道（`.dev[N]` bundle id）启动路径 → 一律不装（自动化反复启动不打扰）。
    SkipDevChannel,
    /// 显式请求但尚未授权 → 先 CGRequestListenEventAccess（每进程至多一次），授权了再装。
    RequestThenInstallIfGranted,
}

/// 纯决策：三个布尔进，一个动作出。启动路径传 `explicit_request=false`；设置页
/// 「开启快捷键」按钮传 `true`（Dev 通道的显式请求仍然放行，给真要在该槽测热键的人
/// 一个入口——跳过只发生在启动路径）。
pub fn decide_hotkey_install(
    preflight_granted: bool,
    dev_channel: bool,
    explicit_request: bool,
) -> HotkeyInstallDecision {
    if dev_channel && !explicit_request {
        return HotkeyInstallDecision::SkipDevChannel;
    }
    if preflight_granted {
        return HotkeyInstallDecision::Install;
    }
    if explicit_request {
        return HotkeyInstallDecision::RequestThenInstallIfGranted;
    }
    HotkeyInstallDecision::SkipNoPermission
}

#[cfg(test)]
mod tests {
    use super::*;
    use HotkeyInstallDecision::*;

    #[test]
    fn appshots_hotkey_not_granted_startup_skips_without_asking() {
        assert_eq!(decide_hotkey_install(false, false, false), SkipNoPermission);
    }

    #[test]
    fn appshots_hotkey_granted_non_dev_startup_installs() {
        assert_eq!(decide_hotkey_install(true, false, false), Install);
    }

    #[test]
    fn appshots_hotkey_dev_channel_startup_skips_even_when_granted() {
        assert_eq!(decide_hotkey_install(true, true, false), SkipDevChannel);
        assert_eq!(decide_hotkey_install(false, true, false), SkipDevChannel);
    }

    #[test]
    fn appshots_hotkey_explicit_request_asks_then_installs_only_if_granted() {
        assert_eq!(
            decide_hotkey_install(false, false, true),
            RequestThenInstallIfGranted
        );
        // 显式请求时已授权 → 直接装，不再弹系统框。
        assert_eq!(decide_hotkey_install(true, false, true), Install);
        // Dev 通道显式请求放行（入口在设置页）。
        assert_eq!(
            decide_hotkey_install(false, true, true),
            RequestThenInstallIfGranted
        );
        assert_eq!(decide_hotkey_install(true, true, true), Install);
    }
}
