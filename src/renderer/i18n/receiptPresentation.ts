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
        tmeet: '腾讯会议',
      },
      tools: {
        webFetch: '网页抓取',
        webSearch: '联网搜索',
        readFile: '读取文件',
        memorySearch: '记忆检索',
      },
      unknownTool: '工具',
    },
    roleCapabilityLabels: {
      readAndFindFiles: '读取和查找文件',
      writeAndEditFiles: '写入和编辑文件',
      runCommands: '运行命令',
      searchTheWeb: '联网搜索',
      openWebPages: '打开网页',
      rememberAndRecall: '记住和回想',
      otherAbility: '其他 {count} 项能力',
      otherAbilities: '其他 {count} 项能力',
      separator: '、',
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
        tmeet: 'Tencent Meeting',
      },
      tools: {
        webFetch: 'Web fetch',
        webSearch: 'Web search',
        readFile: 'Read file',
        memorySearch: 'Memory search',
      },
      unknownTool: 'Tool',
    },
    roleCapabilityLabels: {
      readAndFindFiles: 'Read and find files',
      writeAndEditFiles: 'Write and edit files',
      runCommands: 'Run commands',
      searchTheWeb: 'Search the web',
      openWebPages: 'Open web pages',
      rememberAndRecall: 'Remember and recall',
      otherAbility: '{count} other ability',
      otherAbilities: '{count} other abilities',
      separator: ', ',
    },
  },
};
