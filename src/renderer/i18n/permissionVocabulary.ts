// ============================================================================
// 权限档词汇 —— 会话档与专家档共用的唯一真源
// ============================================================================
// 此前是两套并存：会话档（底栏）叫「安全模式 / 只读探索 / 自动编辑 / YOLO 模式」，
// 专家档（安全页 + 装包摘要卡）叫「严格 / 标准 / 放手」。同一个概念两种叫法，
// 用户要学两遍；「YOLO 模式」还用玩笑词命名了风险最高的那一档。
//
// 现在两边都 import 这里。作用域说明（「这次对话」vs「这个专家」）各自保留在
// 对应的 description/hint 里，但**主标签只有一套**——结构上不可能再分叉。
//
// 词汇取业界通行叫法（Cursor / Claude Code / Codex 用户已经见过），不自造词。
// ============================================================================

export const permissionVocabularyZh = {
  /** 动手前都先问你 —— 会话档 default / 专家档 strict */
  ask: '请求批准',
  /** 只看不动 —— 会话档 readOnly（专家档没有这一档） */
  readOnly: '只读',
  /** 常规操作自己来，风险操作才问你 —— 会话档 acceptEdits / 专家档 development */
  autoApprove: '替我审批',
  /** 不受限制 —— 会话档 bypassPermissions / 专家档 ci。危险档，UI 上必须有警示色 */
  fullAccess: '完全访问权限',
};

export const permissionVocabularyEn: typeof permissionVocabularyZh = {
  ask: 'Request approval',
  readOnly: 'Read only',
  autoApprove: 'Approve for me',
  fullAccess: 'Full access',
};
