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
  // Runtime approval truth (verified against code and by running the classifier; see evidence item 3):
  // default mode asks every time; rm/git-reset carry forceConfirm which survives "always allow"
  // memory and autoApprove; env_access is a read-only safe command and never asks; pipe_to_shell
  // is hard-refused; bypassPermissions auto-approves execute-level asks.
  runtimeApprovalLine: 'After install, when Neo actually runs a command like these: by default it asks you first every time, and delete/reset commands are hard confirmations that even an “Always allow” memory cannot override. Reading environment variables is a read-only operation and runs without asking; download-and-execute commands are refused outright. Only a session switched to skip-permissions mode (or with execute-level auto-approve turned on) runs them without asking.',
  hitCount: '{count} hits',
  detailsShow: 'Show details (file · rule · raw text)',
  detailsHide: 'Hide details',
  acknowledgeExplanation: 'This Skill is already installed from the official marketplace. The pre-install check found the items below worth knowing about — they were not serious enough to block the install, but you get to see them now that it is in.',
  confirmExplanation: 'This Skill comes from an unsigned source and the pre-install check found the items below. Nothing is installed until you confirm; cancelling installs nothing.',
  confirmInstall: 'Confirm install',
  confirming: 'Installing…',
  okButton: 'Got it',
};
