// ============================================================================
// Settings > skills > caution 规则白话句（en）——skill 安装 caution 披露弹窗专用
// ============================================================================
// Mirror of zhSkillCautionRules: one consequence sentence per rule id
// ("what it does + when it is normal"). Key-set parity with the zh leaf is
// enforced by tests/renderer/i18n/skillCautionRulesCoverage.test.ts — the
// en.ts `satisfies` lock cannot see inside the Record<string, string> maps.

/** rules 用索引签名而非字面键型：弹窗按运行时 ruleId 查句，键集完整性由覆盖测试锁 */
export const enSkillCautionRules: { rules: Record<string, string>; embeddedSecret: string; fallback: string } = {
  rules: {
    // —— posix danger rules (commandSafety.ts BLOCKED_PATTERNS + DANGEROUS_PATTERNS) ——
    root_delete: "Deletes the root of the entire disk, so the system stops working immediately — no legitimate skill ever needs this",
    fork_bomb: 'Endlessly copies its own process until the whole machine runs out of resources within seconds',
    disk_wipe: 'Wipes all data on the entire disk',
    recursive_delete_targeted: 'Deletes a specific folder and everything inside it (common when cleaning build output or caches; the wrong target cannot be recovered)',
    home_delete: 'Deletes your entire home folder — all personal files go with it',
    system_dir_delete: 'Deletes a system directory, so the operating system stops working',
    container_dir_delete: 'Deletes an entire top-level directory such as /Applications or /Users',
    wildcard_delete: 'Bulk-deletes by wildcard, so you cannot see in advance which files it removes',
    current_dir_delete: 'Deletes the entire directory you are currently in',
    disk_overwrite: 'Writes straight to the disk device, bypassing the file system and overwriting what is there',
    format_disk: 'Formats the disk, erasing everything on it',
    dd_to_device: 'Writes to raw disk devices with dd, destroying existing data',
    git_force_push: 'Force-push rewrites the remote repository history; other people’s committed work can be lost',
    git_hard_reset: 'Throws away all uncommitted changes and drags the workspace back to an older version',
    git_clean: 'Deletes every file not yet tracked by version control — unsubmitted work disappears',
    chmod_777: 'Makes a file readable, writable and executable by anyone on this machine',
    recursive_chmod: 'Changes permissions across an entire directory tree',
    recursive_chown: 'Changes file ownership across an entire directory tree',
    sudo_rm: 'Recursively deletes with administrator rights, reaching system-protected files',
    sudo_chmod: 'Changes file permissions with administrator rights',
    pipe_to_shell: 'Pipes a script downloaded from the internet straight into the shell without any review (the normal way is to download, read it, then run it)',
    kill_all: 'Force-kills every process on the system',
    killall: 'Force-kills processes by name, which can take down normal apps too',
    system_shutdown: 'Shuts down or restarts this computer',
    history_clear: 'Clears the command history so what was just done leaves no trace',
    path_override: 'Rewrites the PATH variable, so later commands can be impersonated by same-named programs elsewhere',
    shadow_access: 'Reads the system password file, which holds every account’s password hashes',
    ssh_key_export: 'Exports a public key from an SSH private key, touching your login credentials',
    // —— literals pushed directly inside validateCommand ——
    env_access: 'Reads environment variables that look like secrets (such as API keys); the value can end up stored in the skill or sent out',
    egress_private_host: 'Sends network requests to private-network, loopback or cloud-metadata addresses (reaching a public service never needs this)',
    egress_unresolvable_target: "The network request's destination cannot be confirmed from the command text, so where it goes is unclear",
    // —— Windows rule pack (shellRules/windowsRules.ts) ——
    win_root_delete: 'Deletes protected Windows locations (drive roots, user profile, system directories)',
    win_format_disk: 'Formats a disk (the Windows format command)',
    win_shadow_delete: 'Deletes volume shadow copies — the signature move ransomware uses to remove recovery options',
    win_boot_tamper: 'Modifies the boot configuration; a mistake can leave the machine unbootable',
    win_diskpart: 'Runs the disk partitioning tool, which can rewrite the partition table',
    win_encoded_command: 'Runs a whole Base64-encoded command, hiding what it actually does',
    win_execpolicy_bypass: 'Permanently turns off the PowerShell script execution policy',
    win_reg_delete_hklm: 'Deletes machine-level registry entries, affecting software configuration system-wide',
    win_system_shutdown: 'Shuts down or restarts (Windows command)',
    win_remote_exec: 'Downloads a remote script and executes it immediately, without review',
    win_recursive_delete: 'Recursively or forcefully deletes the target path (the Windows delete command)',
    win_scheduled_task: 'Creates a scheduled task so a program runs on a timer or at boot (a common way malware persists)',
    win_netsh: 'Changes network or firewall configuration',
    win_acl_grant: 'Widens file access permissions so more accounts can touch it',
    win_takeown: 'Takes ownership of a file',
    win_reg_write: 'Writes to the registry, where many app settings and startup entries live',
    win_service_install: 'Installs a system service, giving a program a permanent background presence',
    win_defender_tamper: 'Changes Windows Defender settings — a common way to switch protection off',
    win_kill_force: 'Force-kills processes (Windows command)',
    win_cipher_wipe: "Wipes the disk's free space — slow and irreversible",
    win_execpolicy_bypass_arg: 'Starts PowerShell with the execution policy bypassed',
  },
  /** Shared sentence when ruleId starts with embedded_secret_medium: (medium-confidence embedded secret) */
  embeddedSecret: 'The skill file appears to contain a plaintext secret (such as an API key or private key); once installed it sits on this machine in plain text',
  /** Fallback for unknown rule ids; {rule} is replaced with the raw rule name */
  fallback: 'Matched a built-in safety check (rule {rule})',
};
