// 点踩后的就地追问。由 chatInput 词条模块聚合，避免贴线的 zh.ts / en.ts / chatTranscript.ts 增行。

export const turnFeedbackWhyZh = {
  turnFeedbackWhy: {
    placeholder: '哪里不对？一句话就行',
    send: '发送',
    skip: '跳过',
    received: '已收到',
    includeAnswer: '附上这段回答（会一起上传）',
    uploadNotice: '这段话会随反馈上传给团队。关闭「共享使用数据」后，本设备不再向云端上报使用情况。',
  },
};

export const turnFeedbackWhyEn: typeof turnFeedbackWhyZh = {
  turnFeedbackWhy: {
    placeholder: 'What went wrong? One sentence is enough',
    send: 'Send',
    skip: 'Skip',
    received: 'Thanks, received',
    includeAnswer: 'Include this answer (it will be uploaded too)',
    uploadNotice: 'This note is uploaded to the team with your feedback. Turn off “Share usage data” to stop this device from reporting usage to the cloud.',
  },
};
