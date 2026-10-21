// ============================================================================
// Unified permission ledger copy
// ============================================================================

export const permissionGrantsZh = {
  title: '你授权过的权限',
  description: '你交给 Neo 的每一项「允许」都在这里，每一行都可以单独撤销；撤销后下一次同类操作会重新询问。',
  empty: '你还没有给过任何长期允许。',
  kind: { app: '电脑操作', toolTarget: '外部动作', toolSession: '会话内放行', toolTimed: '限时放行' },
  scope: {
    always: '始终',
    conversation: '本次对话',
    automation: '自动化「{title}」',
    run: '本次任务',
    hours24: '24 小时内',
  },
  targetLabel: '对象：{target}',
  grantedOn: '授权于 {date}',
  expiresOn: '有效期至 {date}',
  remainingHours: '剩余 {n} 小时',
  remainingMinutes: '剩余 {n} 分钟',
  revoke: '撤销',
};

export const permissionGrantsEn = {
  title: 'Permissions you have granted',
  description: 'Every "allow" you have given Neo is listed here, revocable row by row; the next identical action asks again after a revoke.',
  empty: 'You have not granted any standing permissions yet.',
  kind: { app: 'Computer use', toolTarget: 'External action', toolSession: 'Conversation allow', toolTimed: 'Time-boxed allow' },
  scope: {
    always: 'Always',
    conversation: 'This conversation',
    automation: 'Automation "{title}"',
    run: 'This task',
    hours24: '24 hours',
  },
  targetLabel: 'Target: {target}',
  grantedOn: 'Granted {date}',
  expiresOn: 'Valid until {date}',
  remainingHours: '{n} h left',
  remainingMinutes: '{n} min left',
  revoke: 'Revoke',
};
