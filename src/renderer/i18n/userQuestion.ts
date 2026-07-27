// ============================================================================
// UserQuestionCard 专属词条（ask_user_question 工具的打断式选项卡 + 消息流 Q&A 记录）
// —— 独立文件避免 zh.ts/en.ts 撞 max-lines(1000) 门。
// ============================================================================

export const userQuestionZh = {
  userQuestion: {
    title: '需要你的回答',
    submit: '提交回答',
    skip: '跳过',
    multiSelectHint: '可多选',
    other: '其他',
    otherPlaceholder: '输入你的答案…',
    declineReasonLabel: '跳过原因（可选）',
    declineReasonPlaceholder: '如需说明为何暂不回答，可在此填写',
    declinedRecord: '已跳过（未回答）',
  },
};

export const userQuestionEn: typeof userQuestionZh = {
  userQuestion: {
    title: 'Answer needed',
    submit: 'Submit answer',
    skip: 'Skip',
    multiSelectHint: 'Multiple answers allowed',
    other: 'Other',
    otherPlaceholder: 'Type your answer…',
    declineReasonLabel: 'Reason for skipping (optional)',
    declineReasonPlaceholder: 'Let the agent know why you’re not answering right now',
    declinedRecord: 'Skipped (not answered)',
  },
};
