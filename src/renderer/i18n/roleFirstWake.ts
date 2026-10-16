// 新专家首次醒来卡片。独立词条，避免塞进 zh.ts / chatInput.ts 顶格。

export const roleFirstWakeZh = {
  roleFirstWake: {
    running: '{name} 正在熟悉你已连接的数据…',
    skip: '跳过',
    connect: '去连接',
    connectHint: '连上数据源后我能帮你更多',
    goToThread: '去 TA 的会话',
    failedTitle: '这次没能完成自我介绍',
    close: '关闭',
    introFallback: '自我介绍还没写下来。',
  },
};

export const roleFirstWakeEn: typeof roleFirstWakeZh = {
  roleFirstWake: {
    running: '{name} is getting familiar with your connected data…',
    skip: 'Skip',
    connect: 'Connect a source',
    connectHint: 'Connect a data source and there is more I can help with.',
    goToThread: 'Open their chat',
    failedTitle: 'This introduction did not finish',
    close: 'Close',
    introFallback: 'The introduction was not written down.',
  },
};
