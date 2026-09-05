// 「文件夹带了自动化配置，要启用吗？」弹窗文案（N-FIRSTRUN-SKIP 从 zh/en.ts 拆出：两份都卡在 max-lines）。
//
// 用户语言，不是工程语言（N-FOLDERTRUST-RISKTIER，爸 2026-09-05 拍板）：每一项都说清「会发生什么」，
// 不出现 hook / MCP / Agent 这类只有开发者认得的词。items 按 DangerousConfigKind 取，
// {count} 由 host 的 item.count 填。
export const folderTrustZh = {
  folderTrust: {
    title: '这个文件夹带了自动化配置，要启用吗？',
    intro: '这个文件夹里带了会自动生效的配置。它们是文件夹本来就有的，不是你或 Neo 放进去的——如果文件夹来自别人，先确认你清楚它的来源。',
    directory: '文件夹',
    realpath: '真实路径',
    detected: '会自动生效的东西',
    identityChanged: '这个文件夹之前启用过，但内容身份变了，需要重新确认。',
    contentChanged: '你之前启用过这个文件夹，之后它又多了会自动运行的东西，需要再确认一次。',
    emptyDangerNote: '没有发现需要逐项确认的配置，但这个文件夹还没启用过（或启用已失效）。启用后才会加载文件夹里的配置。',
    costNote: '不启用也能正常用，只是上面这些不会生效。',
    trust: '启用',
    block: '先不启用',
    openSettings: '打开设置',
    saving: '保存中…',
    saveFailed: '保存失败，决定没有生效',
    risks: {
      execution: '会自动运行',
      mcp: '会连外部工具',
      prompt: '只是文字',
      policy: '会改安全规则',
      preference: '偏好设置',
      diagnostic: '其他配置',
    },
    items: {
      'project-hooks': '{count} 个会自动运行的脚本：开始任务、使用工具这些时候，Neo 会照着它们跑',
      'project-mcp': '{count} 个外部工具连接：会在你的电脑上启动后台程序',
      'project-mcp-local': '{count} 个外部工具连接（只在这台电脑上的那份）：会在你的电脑上启动后台程序',
      'project-agents': '{count} 份专家设定，里面带着能运行的脚本：用到时会在你的电脑上执行',
      'project-skills': '{count} 个技能包，里面带着能运行的脚本：用到时会在你的电脑上执行',
      'project-policy': '一份安全规则文件：会改变 Neo 在这个文件夹里能做什么、哪些事不用先问你',
      'project-skill-preferences': '技能的开关偏好：只决定哪些技能默认打开',
      'project-commands': '{count} 条自定义快捷指令：只是写好的文字，不会自己运行',
      'project-profile': '一份角色设定：只是写好的文字，不会自己运行',
      'agent-instructions': '一份写给 Neo 的说明文件：只会被读到，不会自己运行',
      'other-project-config': '其他配置文件',
    },
  },
};

export const folderTrustEn = {
  folderTrust: {
    title: 'This folder comes with automation config. Enable it?',
    intro: 'This folder carries config that takes effect on its own. It came with the folder — neither you nor Neo put it there. If the folder came from someone else, make sure you know where it is from.',
    directory: 'Folder',
    realpath: 'Real path',
    detected: 'What would start working on its own',
    identityChanged: 'This folder was enabled before, but its identity changed. Confirm again.',
    contentChanged: 'You enabled this folder before. Since then it gained things that run on their own, so please confirm once more.',
    emptyDangerNote: 'No config needs item-by-item review, but this folder is not enabled yet (or that expired). Its config loads only after you enable it.',
    costNote: 'You can keep working without enabling it; the items above just stay off.',
    trust: 'Enable',
    block: 'Not now',
    openSettings: 'Open settings',
    saving: 'Saving...',
    saveFailed: 'Could not save your decision',
    risks: {
      execution: 'Runs on its own',
      mcp: 'Connects an outside tool',
      prompt: 'Text only',
      policy: 'Changes safety rules',
      preference: 'Preferences',
      diagnostic: 'Other config',
    },
    items: {
      'project-hooks': '{count} scripts that run by themselves: Neo runs them when a task starts, when a tool is used, and so on',
      'project-mcp': '{count} connections to outside tools: they start background programs on your computer',
      'project-mcp-local': '{count} connections to outside tools (the copy kept only on this computer): they start background programs on your computer',
      'project-agents': '{count} expert profiles that ship with runnable scripts: those run on your computer when used',
      'project-skills': '{count} skill packs that ship with runnable scripts: those run on your computer when used',
      'project-policy': 'A safety-rules file: it changes what Neo may do in this folder and what it may do without asking you first',
      'project-skill-preferences': 'Skill on/off preferences: they only decide which skills start out enabled',
      'project-commands': '{count} custom shortcuts: written text only, nothing runs by itself',
      'project-profile': 'A role description: written text only, nothing runs by itself',
      'agent-instructions': 'A notes file written for Neo: it only gets read, nothing runs by itself',
      'other-project-config': 'Other config files',
    },
  },
};
