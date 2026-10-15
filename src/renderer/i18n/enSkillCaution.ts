// ============================================================================
// Settings > skills > caution 文案（en）——skill 安装 caution 披露弹窗专用
// ============================================================================
// 拆成叶子模块：zhSettingsModels/enSettingsModels 已贴着 max-lines=1000 棘轮，
// 内嵌块会把两个装配文件顶过线。结构与 zh 版逐叶子对齐（en.ts satisfies 锁）。

export const enSkillCaution = {
  title: 'Install check notice',
  sourceLabels: {
    'official-registry': 'Official marketplace',
    'unsigned-github-archive': 'GitHub archive (unsigned)',
    'local-marketplace': 'Local source',
    builtin: 'Built-in',
  },
  hitsCount: '{count} findings',
  ruleHint: 'The label on the left of each finding is the name of a built-in check rule; the text on the right quotes what it matched. Hover to see the full content.',
  acknowledgeExplanation: 'This Skill is already installed from the official marketplace. The pre-install check found the items below worth knowing about — they were not serious enough to block the install, but you get to see them now that it is in.',
  confirmExplanation: 'This Skill comes from an unsigned source and the pre-install check found the items below. Nothing is installed until you confirm; cancelling installs nothing.',
  confirmInstall: 'Confirm install',
  confirming: 'Installing…',
  okButton: 'Got it',
};
