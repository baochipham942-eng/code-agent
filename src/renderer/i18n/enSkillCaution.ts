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
  hitsCount: { one: '{count} finding', other: '{count} findings' },
  // Runtime approval truth (default strict, autoApprove.execute off; classifier run in evidence item 3):
  // rm -rf / git reset --hard set forceConfirm: every mode asks except Full access;
  // Always allow and execute-level auto-approve cannot skip them. git clean / private-network
  // requests do not set forceConfirm: they ask by default, but Always allow, execute-level
  // auto-approve, and Full access do not. Reading a secret env var is a known-safe command
  // and does not ask by default; Read only mode still asks. curl|sh is a command-policy hard
  // deny in every mode, including Full access.
  // Each sentence renders only when the current scan hit a rule in its tier (the modal
  // picks tiers per scan, see SkillCautionDisclosureModal); wording is verbatim-equivalent
  // to the single line this was split from. The tier mapping covers every rule id the host
  // write points can emit (forcedConfirm = command families matching confirmationGate
  // HIGH_RISK_PATTERNS; askByDefault = other non-allowlisted commands; readOnly =
  // allowlisted reads; hardDeny = curl|sh and the critical/block-tier rules); command
  // names inside each sentence are illustrative, not exhaustive.
  runtimeApproval: {
    lead: 'After install, when Neo actually runs a command like these: by default it asks you every time.',
    forcedConfirm: 'Deleting a folder and a hard reset are hard confirmations that neither “Always allow” nor execute-level auto-approve can skip, and only switching this conversation to “Full access” runs them without asking.',
    askByDefault: 'Cleaning untracked files and reaching a private-network address also ask by default, but they run without asking after “Always allow”, with execute-level auto-approve on, or on “Full access”.',
    readOnly: 'Reading environment variables is treated as read-only and does not ask in the default mode, while “Read only” mode still asks.',
    hardDeny: 'Piping a downloaded script straight into the shell is refused in every permission mode.',
  },
  hitCount: { one: '{count} hit', other: '{count} hits' },
  detailsShow: 'Show details (file · rule · raw text)',
  detailsHide: 'Hide details',
  acknowledgeExplanation: 'This Skill is already installed from the official marketplace. The pre-install check found the items below worth knowing about — they were not serious enough to block the install, but you get to see them now that it is in.',
  confirmExplanation: 'This Skill comes from an unsigned source and the pre-install check found the items below. Nothing is installed until you confirm; cancelling installs nothing.',
  confirmInstall: 'Confirm install',
  confirming: 'Installing…',
  okButton: 'Got it',
};
