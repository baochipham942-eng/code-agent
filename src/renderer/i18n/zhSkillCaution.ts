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
  ruleHint: '每条提醒左侧的编号是内置检查规则的名称，右侧摘录的是命中的原文；鼠标悬停可查看完整内容。',
  acknowledgeExplanation: '这个技能已从官方市场装好。装前检查发现以下值得留意的内容——它们没有严重到拦截安装，但你有权在装完后知道。',
  confirmExplanation: '这个技能来自未签名来源，装前检查发现以下内容。确认安装后才会真正装进本机；取消则不会安装任何东西。',
  confirmInstall: '确认安装',
  confirming: '安装中…',
  okButton: '我知道了',
  notInstalledPrefix: '未安装：',
};
