// ============================================================================
// permissionRuleNl 域词条（一句话权限规则翻译，N-PERM-NL-RULES-K1）—— zh/en 同文件相邻维护。
// 复述句/行为短语/识别不了与受保护话术的单一真源在 shared/permissionRuleTranslate.ts
// （host 返回与 renderer 展示共用），这里只放周边静态 UI 文案。
// ============================================================================

export const permissionRuleNlZh = {
  permissionRuleNl: {
    sectionTitle: '用一句话加规则',
    sectionDescription: '说一句中文，我帮你翻成一条规则；确认无误后才会保存。',
    inputPlaceholder: '比如：删文件之前先问我',
    inputLabel: '规则描述',
    translateAction: '翻译',
    translating: '翻译中…',
    cardTitle: '我理解为',
    behaviorLabel: '触发时',
    hitLabel: '会触发',
    missLabel: '不会触发',
    confirmAction: '确认保存',
    cancelAction: '取消',
    savedRulesTitle: '已保存的规则（附白话对照）',
    emptyRules: '还没有保存任何规则',
    advancedFoldTitle: '高级：直接写规则',
    advancedFoldDescription: '用 Tool(pattern) 语法逐行编辑（程序员向）',
    translateFailedPrefix: '翻译失败：',
    savedToast: '规则已保存',
    protectedBadge: '不能自动放行',
    unrecognizedBadge: '无法识别',
  },
};

export const permissionRuleNlEn: typeof permissionRuleNlZh = {
  permissionRuleNl: {
    sectionTitle: 'Add a rule in one sentence',
    sectionDescription: 'Describe the rule in one sentence; it is saved only after you confirm the restatement.',
    inputPlaceholder: 'e.g. Ask me before deleting files',
    inputLabel: 'Rule description',
    translateAction: 'Translate',
    translating: 'Translating…',
    cardTitle: 'I understood',
    behaviorLabel: 'When triggered',
    hitLabel: 'Will match',
    missLabel: 'Will not match',
    confirmAction: 'Save rule',
    cancelAction: 'Cancel',
    savedRulesTitle: 'Saved rules (with plain-language gloss)',
    emptyRules: 'No rules saved yet',
    advancedFoldTitle: 'Advanced: write rules directly',
    advancedFoldDescription: 'Edit line by line using Tool(pattern) syntax (for programmers)',
    translateFailedPrefix: 'Translation failed: ',
    savedToast: 'Rule saved',
    protectedBadge: 'No auto-allow',
    unrecognizedBadge: 'Not recognized',
  },
};
