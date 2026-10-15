// ============================================================================
// Settings > skills > caution 规则白话句（zh）——skill 安装 caution 披露弹窗专用
// ============================================================================
// ruleId 全集 = commandSafety.ts / shellRules/windowsRules.ts 的 flag 字面量 +
// validateCommand 里 push 进 securityFlags 的字面量。此处一句「它会做什么 + 何时算正常」，
// 供非程序员在装技能前读懂风险；id 与句子的逐条对齐由
// tests/renderer/i18n/skillCautionRulesCoverage.test.ts 钉死（漏一条即红）。
// 拆成叶子模块：zhSettingsModels/enSettingsModels 已贴着 max-lines 棘轮。
// 结构与 en 版逐叶子对齐（键集一致性由上述测试锁，en.ts 的 satisfies 锁不住 Record 键集）。

/** rules 用索引签名而非字面键型：弹窗按运行时 ruleId 查句，键集完整性由覆盖测试锁 */
export const zhSkillCautionRules: { rules: Record<string, string>; embeddedSecret: string; fallback: string } = {
  rules: {
    // —— posix 危险命令（commandSafety.ts BLOCKED_PATTERNS + DANGEROUS_PATTERNS）——
    root_delete: '删除整个磁盘的根目录，系统会立刻无法运行——正常技能绝不会需要这样做',
    fork_bomb: '无限复制自身进程，几秒内耗尽整台电脑的资源',
    disk_wipe: '直接抹掉整块磁盘上的全部数据',
    recursive_delete_targeted: '删除指定文件夹和里面的所有内容（清理构建产物、缓存时常见，删错目标无法恢复）',
    home_delete: '删除你的整个用户主目录，个人文件会全部消失',
    system_dir_delete: '删除系统目录，操作系统会无法正常运行',
    container_dir_delete: '删除整个顶级目录（如 /Applications、/Users 下的全部内容）',
    wildcard_delete: '按通配符批量递归删除，事先看不清会删掉哪些文件',
    current_dir_delete: '删除当前所在的整个目录',
    disk_overwrite: '绕过文件系统直接写磁盘设备，覆盖原有数据',
    format_disk: '格式化磁盘，盘上数据全部清空',
    dd_to_device: '用 dd 直接写裸磁盘设备，会破坏现有数据',
    git_force_push: '强制推送会改写远端仓库历史，别人已提交的改动可能丢失',
    git_hard_reset: '丢弃所有未提交的改动，把工作区拉回历史某个版本',
    git_clean: '删除所有未纳入版本管理的新文件，没提交过的成果会直接消失',
    chmod_777: '把权限改成任何人可读写执行，同机其他用户和程序都能改它',
    recursive_chmod: '递归修改整棵目录树的权限设置',
    recursive_chown: '递归修改整棵目录树的文件归属',
    sudo_rm: '以管理员权限递归删除，能删掉受系统保护的文件',
    sudo_chmod: '以管理员权限修改文件权限',
    pipe_to_shell: '把网上下载的脚本直接交给命令行执行，内容没有经过任何检查（正常做法是先下载、看过再运行）',
    kill_all: '强制结束系统里所有进程',
    killall: '按名字批量强制结束进程，可能连带杀死正常应用',
    system_shutdown: '关机或重启这台电脑',
    history_clear: '清除命令执行历史，让刚才做过的事不留痕迹',
    path_override: '改写 PATH 环境变量，之后执行的命令可能被别处的同名程序冒充',
    shadow_access: '读取系统密码存储文件，里面有各账户口令的散列',
    ssh_key_export: '从 SSH 私钥导出公钥，直接接触你的登录凭据',
    // —— validateCommand 内直接 push 的字面量 ——
    env_access: '读取疑似密钥的环境变量（如 API Key），值可能被记进技能或发送出去',
    egress_private_host: '向内网地址、本机回环或云元数据地址发起网络请求（访问公开服务不需要这么做）',
    egress_unresolvable_target: '网络请求的目标地址无法从命令文本确认，去向不明',
    // —— Windows 规则包（shellRules/windowsRules.ts）——
    win_root_delete: '删除 Windows 的保护位置（盘根、用户主目录、系统目录）',
    win_format_disk: '格式化磁盘（Windows 的 format 命令）',
    win_shadow_delete: '删除卷影副本——这是勒索软件清掉恢复途径的标志性动作',
    win_boot_tamper: '修改系统引导配置，出错电脑会开不了机',
    win_diskpart: '运行磁盘分区工具，可以直接改动分区表',
    win_encoded_command: '执行整段 Base64 编码的命令，外面看不到它到底要做什么',
    win_execpolicy_bypass: '永久关闭 PowerShell 的脚本执行限制',
    win_reg_delete_hklm: '删除系统级注册表项，影响整机软件配置',
    win_system_shutdown: '关机或重启（Windows 命令）',
    win_remote_exec: '下载远程脚本并立即执行，内容没有经过检查',
    win_recursive_delete: '递归或强制删除目标路径（Windows 的删除命令）',
    win_scheduled_task: '创建计划任务，让某个程序定时或开机自动运行（恶意软件常用的驻留手法）',
    win_netsh: '修改网络或防火墙配置',
    win_acl_grant: '放宽文件的访问授权，让更多账户可以动它',
    win_takeown: '夺取文件的所有权',
    win_reg_write: '写入注册表——很多软件设置和开机自启动都存在这里',
    win_service_install: '安装系统服务，让程序获得后台常驻能力',
    win_defender_tamper: '修改 Windows Defender 配置，是关闭防护的常见手法',
    win_kill_force: '强制结束进程（Windows 命令）',
    win_cipher_wipe: '擦除磁盘剩余空间，耗时长且不可逆',
    win_execpolicy_bypass_arg: '以绕过执行限制的方式启动 PowerShell',
  },
  /** ruleId 以 embedded_secret_medium: 开头（medium 置信嵌入密钥）时的共用句 */
  embeddedSecret: '技能文件里疑似写入了明文密钥（如 API Key、私钥），装好后它就在本机明文存放',
  /** 未知 ruleId 的兜底句，{rule} 会被替换成原始规则名 */
  fallback: '内置安全检查命中（规则 {rule}）',
};
