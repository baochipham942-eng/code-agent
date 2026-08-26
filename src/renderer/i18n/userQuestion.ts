// ============================================================================
// UserQuestionCard 专属词条（ask_user_question 工具的打断式选项卡 + 消息流 Q&A 记录）
// —— 独立文件避免 zh.ts/en.ts 撞 max-lines(1000) 门。
// ============================================================================

export const userQuestionZh = {
  userQuestion: {
    title: '需要你的回答',
    stepOf: (current: number, total: number) => `第 ${current}/${total} 步`,
    back: '上一步',
    next: '下一步',
    submit: '回答 · 允许',
    skip: '回答 · 拒绝',
    multiSelectHint: '可多选',
    other: '其他',
    otherPlaceholder: '输入你的答案…',
    declineReasonLabel: '跳过原因（可选）',
    declineReasonPlaceholder: '如需说明为何暂不回答，可在此填写',
    declinedRecord: '回答 · 已拒绝（未回答）',
    answeredSummary: (count: number) => `${count} 个问题已回答`,
    expandRecord: '展开查看',
    collapseRecord: '收起',
  },
};

export const userQuestionEn: typeof userQuestionZh = {
  userQuestion: {
    title: 'Answer needed',
    stepOf: (current: number, total: number) => `Step ${current} of ${total}`,
    back: 'Back',
    next: 'Next',
    submit: 'Answer · Allow',
    skip: 'Answer · Deny',
    multiSelectHint: 'Multiple answers allowed',
    other: 'Other',
    otherPlaceholder: 'Type your answer…',
    declineReasonLabel: 'Reason for skipping (optional)',
    declineReasonPlaceholder: 'Let the agent know why you’re not answering right now',
    declinedRecord: 'Answer · Denied (not answered)',
    answeredSummary: (count: number) => `${count} questions answered`,
    expandRecord: 'Expand to view',
    collapseRecord: 'Collapse',
  },
};
