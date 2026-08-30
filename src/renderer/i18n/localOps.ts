// 「本机操作」合并页词条（features/localOps/LocalOpsPage）—— zh/en 同文件相邻维护。
// 独立文件避免 zh.ts/en.ts 撞 max-lines 棘轮（同 capabilityHub.ts / sidebar.ts 先例）。

export const localOpsZh = {
  localOps: {
    title: '本机操作',
    description: 'Neo 操作本机：桌面操作 · 浏览器',
    descriptionBrowserOnly: 'Neo 操作浏览器页面',
    tabDesktop: '桌面',
    tabBrowser: '浏览器',
  },
};

export const localOpsEn = {
  localOps: {
    title: 'Local Ops',
    description: 'Neo operates this machine: desktop · browser',
    descriptionBrowserOnly: 'Neo operates browser pages',
    tabDesktop: 'Desktop',
    tabBrowser: 'Browser',
  },
};
