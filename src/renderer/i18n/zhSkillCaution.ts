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
  // 运行时审批真相（默认 strict，autoApprove.execute 默认关；分类器实跑见证据档③）：
  // rm -rf / git reset --hard 带 forceConfirm：各档都问，只有「完全访问权限」不问；
  // 「始终允许」和执行类自动批准都压不住。git clean / 内网请求无 forceConfirm：
  // 默认也问，但「始终允许」、执行类自动批准、「完全访问权限」不问。
  // 读密钥环境变量默认是已知安全命令、不问；「只读」档仍问。
  // curl|sh 被命令策略硬拒，任何权限档（含完全访问）都不放行。
  runtimeApprovalLine: '装好后 Neo 真要执行这类命令时：默认每次都会先问你；删除目录和硬重置是强确认，连「始终允许」和执行类自动批准都压不住，只有把这次对话切到「完全访问权限」才不问直接跑；清理未跟踪文件和访问内网在默认档也会问，但点过「始终允许」、开了执行类自动批准，或切到「完全访问权限」就不会再问；读取环境变量在默认档属于只读、不会询问，切到「只读」仍会问；把网上下载的脚本直接送进命令行执行会被直接拒绝，任何权限档都不放行。',
  hitCount: '{count} 处',
  detailsShow: '展开命中明细（文件 · 规则 · 原文）',
  detailsHide: '收起命中明细',
  acknowledgeExplanation: '这个技能已从官方市场装好。装前检查发现以下值得留意的内容——它们没有严重到拦截安装，但你有权在装完后知道。',
  confirmExplanation: '这个技能来自未签名来源，装前检查发现以下内容。确认安装后才会真正装进本机；取消则不会安装任何东西。',
  confirmInstall: '确认安装',
  confirming: '安装中…',
  okButton: '我知道了',
};
