// workbench「浏览器」tab = Agent 正在操作的那扇窗（B1）。
// 独立域文件避免 zh.ts/en.ts 撞 max-lines 棘轮（同 localOps.ts / workbenchTabs.ts 先例）。

export const browserAgentWindowZh = {
  browserAgentWindow: {
    modeManaged: '隔离托管浏览器',
    modeDesktop: '我的 Chrome',
    modeNone: '未启动',
    running: '运行中',
    stopped: '未启动',
    tabCount: '{count} 个标签页',
    activeTabEmpty: '还没有打开页面',
    liveTitle: '实时现场',
    liveDetailIdle: '等 Neo 开始操作网页',
    timelineTitle: '操作记录',
    notReadyTitle: '浏览器还没准备好',
    idleTitle: 'Neo 还没开始操作网页',
    idleHint: 'Neo 开始浏览网页时，这里会实时显示它点了什么、看了什么。',
    foreignSessionTitle: '这个浏览器现场属于另一个会话',
    foreignSessionHint: '当前会话只能看状态，操作请回到启动它的那个会话。',
    openLocalOps: '高级设置',
  },
};

export const browserAgentWindowEn: typeof browserAgentWindowZh = {
  browserAgentWindow: {
    modeManaged: 'Isolated managed browser',
    modeDesktop: 'My Chrome',
    modeNone: 'Not started',
    running: 'Running',
    stopped: 'Not started',
    tabCount: '{count} tabs',
    activeTabEmpty: 'No page open yet',
    liveTitle: 'Live view',
    liveDetailIdle: 'Waiting for Neo to start browsing',
    timelineTitle: 'Activity',
    notReadyTitle: 'Browser is not ready',
    idleTitle: 'Neo has not started browsing',
    idleHint: 'Once Neo starts browsing, you will see what it clicks and reads here in real time.',
    foreignSessionTitle: 'This browser belongs to another conversation',
    foreignSessionHint: 'This conversation can only watch its status. Go back to the conversation that started it to act on it.',
    openLocalOps: 'Advanced settings',
  },
};
