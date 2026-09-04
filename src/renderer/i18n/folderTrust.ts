// 「文件夹带了自动化配置，要启用吗？」弹窗文案（N-FIRSTRUN-SKIP 从 zh/en.ts 拆出：两份都卡在 max-lines）。
export const folderTrustZh = {
  folderTrust: {
    title: '这个文件夹带了自动化配置，要启用吗？',
    intro: '启用后，Neo 会按这些配置在这个文件夹里执行命令、连接服务或加载技能。文件夹如果来自别人，先确认你清楚它的来源。不启用也能正常对话，只是这些配置不生效。',
    directory: '文件夹',
    realpath: '真实路径',
    detected: '发现的配置',
    identityChanged: '这个文件夹之前启用过，但内容身份变了，需要重新确认。',
    emptyDangerNote: '没有发现需要逐项确认的配置，但这个文件夹还没启用过（或启用已失效）。启用后才会加载文件夹里的配置。',
    trust: '启用',
    block: '先不启用',
    openSettings: '打开设置',
    saving: '保存中…',
    saveFailed: '保存失败，决定没有生效',
    risks: {
      execution: '命令执行',
      mcp: 'MCP 服务',
      agent: 'Agent 定义',
      skill: 'Skill 定义',
      prompt: '提示词',
      policy: '安全策略',
      preference: '偏好设置',
      diagnostic: '其他配置',
    },
  },
};

export const folderTrustEn = {
  folderTrust: {
    title: 'This folder comes with automation config. Enable it?',
    intro: 'Once enabled, Neo will run commands, connect services, or load skills as this config says. If the folder came from someone else, make sure you know where it is from. You can still chat without enabling it; the config just stays off.',
    directory: 'Folder',
    realpath: 'Real path',
    detected: 'Config found',
    identityChanged: 'This folder was enabled before, but its identity changed. Confirm again.',
    emptyDangerNote: 'No config needs item-by-item review, but this folder is not enabled yet (or that expired). Its config loads only after you enable it.',
    trust: 'Enable',
    block: 'Not now',
    openSettings: 'Open settings',
    saving: 'Saving...',
    saveFailed: 'Could not save your decision',
    risks: {
      execution: 'Command execution',
      mcp: 'MCP servers',
      agent: 'Agent definitions',
      skill: 'Skill definitions',
      prompt: 'Prompts',
      policy: 'Security policy',
      preference: 'Preferences',
      diagnostic: 'Other config',
    },
  },
};
