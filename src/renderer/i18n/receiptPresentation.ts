export const receiptPresentationZh = {
  receiptPresentation: {
    succeeded: '成功',
    failed: '失败',
    showDetails: '展开执行详情',
    hideDetails: '收起执行详情',
    recipientSingle: '发给 {first}',
    recipientMultiple: '发给 {first} 等 {count} 人',
    humanToolLabels: {
      connectors: {
        mail: '邮件',
        calendar: '日历',
        reminders: '提醒事项',
      },
      tools: {
        webFetch: '网页抓取',
        webSearch: '联网搜索',
        readFile: '读取文件',
        memorySearch: '记忆检索',
      },
      unknownTool: '工具',
    },
  },
};

export const receiptPresentationEn: typeof receiptPresentationZh = {
  receiptPresentation: {
    succeeded: 'Succeeded',
    failed: 'Failed',
    showDetails: 'Show execution details',
    hideDetails: 'Hide execution details',
    recipientSingle: 'Sent to {first}',
    recipientMultiple: 'Sent to {first} and others ({count} recipients)',
    humanToolLabels: {
      connectors: {
        mail: 'Mail',
        calendar: 'Calendar',
        reminders: 'Reminders',
      },
      tools: {
        webFetch: 'Web fetch',
        webSearch: 'Web search',
        readFile: 'Read file',
        memorySearch: 'Memory search',
      },
      unknownTool: 'Tool',
    },
  },
};
