// ============================================================================
// UserQuestionModal 专属词条（ask_user_question 工具的自由文本 "其他" 选项 + 取消原因）
// —— 独立文件避免 zh.ts/en.ts 撞 max-lines(1000) 门。
// ============================================================================

export const userQuestionZh = {
  userQuestion: {
    other: '其他',
    otherPlaceholder: '输入你的答案…',
    declineReasonLabel: '取消原因（可选）',
    declineReasonPlaceholder: '如需说明为何暂不回答，可在此填写',
  },
};

export const userQuestionEn: typeof userQuestionZh = {
  userQuestion: {
    other: 'Other',
    otherPlaceholder: 'Type your answer…',
    declineReasonLabel: 'Reason for declining (optional)',
    declineReasonPlaceholder: 'Let the agent know why you’re not answering right now',
  },
};
