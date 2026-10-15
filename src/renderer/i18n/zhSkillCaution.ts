// ============================================================================
// Settings > skills > caution 文案（zh）——skill 安装 caution 披露弹窗专用
// ============================================================================
// 拆成叶子模块：zhSettingsModels/enSettingsModels 已贴着 max-lines=1000 棘轮，
// 内嵌块会把两个装配文件顶过线。结构与 en 版逐叶子对齐（en.ts satisfies 锁）。

export const zhSkillCaution = {
  title: '安装检查提醒',
  sourceLabels: {
    'official-registry': '官方市场',
    'unsigned-github-archive': 'GitHub 归档（未签名）',
    'local-marketplace': '本地来源',
    builtin: '内置',
  },
  hitsCount: '共 {count} 条提醒',
  // 运行时审批真相（本单已逐条核过代码与真实跑过分类器，见证据档第③条）：
  // 默认档逐次询问；rm/git reset 类带 forceConfirm，压得住「总是允许」记忆与 autoApprove；
  // env_access 是只读安全命令不问；pipe_to_shell 被硬拒；bypassPermissions 免执行确认。
  runtimeApprovalLine: '装好后 Neo 真要执行这类命令时：默认每次都会先征求你的确认，删除/重置类是强确认，连「总是允许」的记忆也压不住；读取环境变量属只读操作、不会询问；「下载即执行」类会被直接拒绝；只有把会话切到跳过权限确认档（或开启过执行类自动批准）才会不问直接跑。',
  hitCount: '{count} 处',
  detailsShow: '展开命中明细（文件 · 规则 · 原文）',
  detailsHide: '收起命中明细',
  acknowledgeExplanation: '这个技能已从官方市场装好。装前检查发现以下值得留意的内容——它们没有严重到拦截安装，但你有权在装完后知道。',
  confirmExplanation: '这个技能来自未签名来源，装前检查发现以下内容。确认安装后才会真正装进本机；取消则不会安装任何东西。',
  confirmInstall: '确认安装',
  confirming: '安装中…',
  okButton: '我知道了',
};
