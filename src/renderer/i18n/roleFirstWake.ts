// 新专家首次醒来卡片。独立词条，避免塞进 zh.ts / chatInput.ts 顶格。
// 2026-11-05 owner 返修：用户刚在确认卡看过名字与职责——卡片可见文案不再出现
// 展示名、职责复述、「自我介绍」与「TA」字样（zh/en 同步）。

export const roleFirstWakeZh = {
  roleFirstWake: {
    running: '正在熟悉你已连接的数据…',
    skip: '先不用',
    connect: '去连接',
    connectHint: '连上数据源后我能帮你更多',
    goToThread: '进入会话',
    failedReady: '建好了，现在就可以让我做事。',
    failedLook: '刚才没能看{scope}：{reason}。',
    failedLookGeneric: '刚才没能看{scope}。',
    reasons: {
      auth: '模型账号没通过授权',
      insufficient_balance: '模型额度用完了',
      usage_limit: '模型额度用完了',
      network: '网络连不上',
    },
    scopeCalendar: '你的日历',
    scopeData: '你的数据',
    retryLook: '重新查看',
    switchModel: '换个模型再看',
    checkAccount: '检查账号',
    introFallback: '还没写下要说的内容。',
  },
};

export const roleFirstWakeEn: typeof roleFirstWakeZh = {
  roleFirstWake: {
    running: 'Getting familiar with your connected data…',
    skip: 'Not now',
    connect: 'Connect a source',
    connectHint: 'Connect a data source and there is more I can help with.',
    goToThread: 'Open the session',
    failedReady: 'Ready — you can give me work right away.',
    failedLook: 'Could not look at {scope} just now: {reason}.',
    failedLookGeneric: 'Could not look at {scope} just now.',
    reasons: {
      auth: 'the model account was not authorized',
      insufficient_balance: 'the model quota is used up',
      usage_limit: 'the model quota is used up',
      network: 'could not connect to the network',
    },
    scopeCalendar: 'your calendar',
    scopeData: 'your data',
    retryLook: 'Look again',
    switchModel: 'Switch model and look again',
    checkAccount: 'Check account',
    introFallback: 'Nothing was written down yet.',
  },
};
