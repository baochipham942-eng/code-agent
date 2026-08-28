import type { ToolStepLabelKey, ToolStepStatus } from '@shared/contract';

type DeclaredVerbForms = Record<ToolStepLabelKey, string>;

interface ToolStepVerbSet {
  declared: DeclaredVerbForms;
  read: string;
  readFallback: string;
  write: string;
  writeFallback: string;
  edit: string;
  editFallback: string;
  bash: string;
  bashFallback: string;
  search: string;
  searchFallback: string;
  listDir: string;
  listDirFallback: string;
  webSearch: string;
  webSearchFallback: string;
  webFetch: string;
  webFetchFallback: string;
  mcpTool: string;
  channelMessage: string;
  subagentSpawn: string;
  subagentSpawnFallback: string;
  subagentMessage: string;
  agentConversation: string;
  agentConversationFallback: string;
  delegateTask: string;
  delegateTaskFallback: string;
  taskStatus: string;
  steerTask: string;
  cancelTask: string;
  todo: string;
  planUpdate: string;
  planRead: string;
  taskManager: string;
  skill: string;
  skillFallback: string;
  screenshot: string;
  askUser: string;
  memoryStore: string;
  memorySearch: string;
  toolSearch: string;
  fallbackNeutral: string;
  connectorFallbackAction: {
    queryStatus: string;
    queryCollections: string;
    queryItems: string;
    query: string;
    create: string;
    update: string;
    delete: string;
  };
  group: {
    explored: string;
    ran: string;
    searchedWeb: string;
    mcp: string;
    subagent: string;
    planned: string;
    skill: string;
    used: string;
  };
}

type NonCompletedToolStepStatus = Exclude<ToolStepStatus, 'completed'>;

interface DomainActionSet {
  query: string;
  create: string;
  update: string;
  delete: string;
  operate: string;
}

interface ToolStepVerbBundle {
  statusForms: Record<NonCompletedToolStepStatus, ToolStepVerbSet>;
  domainActions: Record<ToolStepStatus, {
    browser: DomainActionSet;
    computer: DomainActionSet;
    mcp: DomainActionSet;
    tool: DomainActionSet;
  }>;
  intentWrap: Record<NonCompletedToolStepStatus, string>;
  pendingApprovalStatus: string;
  failureCode: string;
  failureReasonMissing: string;
}

export const toolStepVerbsZh: ToolStepVerbBundle = {
  statusForms: {
    'pending-approval': {
      declared: { tmeetMeetingListUpcoming: '请求查询待开始/进行中的会议', tmeetMeetingListEnded: '请求查询近 30 天已结束的会议', tmeetMeetingCreate: '请求创建会议', tmeetMeetingSearch: '请求搜索会议' },
      read: '请求读取 {target}', readFallback: '请求读取一个文件', write: '请求写入 {target}', writeFallback: '请求写入一个文件',
      edit: '请求编辑 {target}', editFallback: '请求编辑一个文件', bash: '请求运行命令 {command}', bashFallback: '请求运行一条命令',
      search: '请求搜索 {query}', searchFallback: '请求搜索内容', listDir: '请求查看 {target} 目录', listDirFallback: '请求查看目录',
      webSearch: '请求联网搜索 {query}', webSearchFallback: '请求联网搜索', webFetch: '请求打开 {target}', webFetchFallback: '请求打开网页',
      mcpTool: '请求调用 {server}', channelMessage: '请求在{channel}发消息', subagentSpawn: '请求启动代理 — {description}', subagentSpawnFallback: '请求启动代理',
      subagentMessage: '请求给代理发消息', agentConversation: '请求联系 {name}', agentConversationFallback: '请求联系代理', delegateTask: '请求派出后台任务：{description}', delegateTaskFallback: '请求派出后台任务',
      taskStatus: '请求查看后台任务进度', steerTask: '请求调整后台任务', cancelTask: '请求取消后台任务', todo: '请求更新待办清单', planUpdate: '请求更新计划', planRead: '请求查看计划', taskManager: '请求更新任务',
      skill: '请求使用技能 {skill}', skillFallback: '请求使用技能', screenshot: '请求截图', askUser: '请求向你提问', memoryStore: '请求保存一条记忆', memorySearch: '请求搜索记忆', toolSearch: '请求查找可用工具', fallbackNeutral: '请求执行工具操作',
      connectorFallbackAction: { queryStatus: '请求查询连接状态', queryCollections: '请求查询可用列表', queryItems: '请求查询日程', query: '请求查询信息', create: '请求创建内容', update: '请求更新内容', delete: '请求删除内容' },
      group: { explored: '请求查看 {count} 次内容', ran: '请求运行 {count} 条命令', searchedWeb: '请求联网查询 {count} 次', mcp: '请求调用 {count} 次工具', subagent: '请求派发 {count} 次代理任务', planned: '请求更新 {count} 次任务', skill: '请求使用 {count} 次技能', used: '请求执行 {count} 个步骤' },
    },
    running: {
      declared: { tmeetMeetingListUpcoming: '正在查询待开始/进行中的会议', tmeetMeetingListEnded: '正在查询近 30 天已结束的会议', tmeetMeetingCreate: '正在创建会议', tmeetMeetingSearch: '正在搜索会议' },
      read: '正在读取 {target}', readFallback: '正在读取文件', write: '正在写入 {target}', writeFallback: '正在写入文件',
      edit: '正在编辑 {target}', editFallback: '正在编辑文件', bash: '正在运行命令 {command}', bashFallback: '正在运行命令',
      search: '正在搜索 {query}', searchFallback: '正在搜索内容', listDir: '正在查看 {target} 目录', listDirFallback: '正在查看目录',
      webSearch: '正在联网搜索 {query}', webSearchFallback: '正在联网搜索', webFetch: '正在打开 {target}', webFetchFallback: '正在打开网页',
      mcpTool: '正在调用 {server}', channelMessage: '正在{channel}发消息', subagentSpawn: '正在启动代理 — {description}', subagentSpawnFallback: '正在启动代理',
      subagentMessage: '正在给代理发消息', agentConversation: '正在跟 {name} 说话', agentConversationFallback: '正在跟代理说话', delegateTask: '正在派出后台任务：{description}', delegateTaskFallback: '正在派出后台任务',
      taskStatus: '正在查看后台任务进度', steerTask: '正在调整后台任务', cancelTask: '正在取消后台任务', todo: '正在更新待办清单', planUpdate: '正在更新计划', planRead: '正在查看计划', taskManager: '正在更新任务',
      skill: '正在使用技能 {skill}', skillFallback: '正在使用技能', screenshot: '正在截图', askUser: '正在等待你的回答', memoryStore: '正在保存一条记忆', memorySearch: '正在搜索记忆', toolSearch: '正在查找可用工具', fallbackNeutral: '正在执行工具操作',
      connectorFallbackAction: { queryStatus: '正在查询连接状态', queryCollections: '正在查询可用列表', queryItems: '正在查询日程', query: '正在查询信息', create: '正在创建内容', update: '正在更新内容', delete: '正在删除内容' },
      group: { explored: '正在查看 {count} 次内容', ran: '正在运行 {count} 条命令', searchedWeb: '正在联网查询 {count} 次', mcp: '正在调用 {count} 次工具', subagent: '正在派发 {count} 次代理任务', planned: '正在更新 {count} 次任务', skill: '正在使用 {count} 次技能', used: '正在执行 {count} 个步骤' },
    },
    failed: {
      declared: { tmeetMeetingListUpcoming: '查询待开始/进行中的会议未成功', tmeetMeetingListEnded: '查询近 30 天已结束的会议未成功', tmeetMeetingCreate: '创建会议未成功', tmeetMeetingSearch: '搜索会议未成功' },
      read: '读取 {target} 未成功', readFallback: '读取文件未成功', write: '写入 {target} 未成功', writeFallback: '写入文件未成功',
      edit: '编辑 {target} 未成功', editFallback: '编辑文件未成功', bash: '运行命令 {command} 未成功', bashFallback: '运行命令未成功',
      search: '搜索 {query} 未成功', searchFallback: '搜索内容未成功', listDir: '查看 {target} 目录未成功', listDirFallback: '查看目录未成功',
      webSearch: '联网搜索 {query} 未成功', webSearchFallback: '联网搜索未成功', webFetch: '打开 {target} 未成功', webFetchFallback: '打开网页未成功',
      mcpTool: '调用 {server} 未成功', channelMessage: '在{channel}发消息未成功', subagentSpawn: '启动代理未成功 — {description}', subagentSpawnFallback: '启动代理未成功',
      subagentMessage: '给代理发消息未成功', agentConversation: '联系 {name} 未成功', agentConversationFallback: '联系代理未成功', delegateTask: '派出后台任务未成功：{description}', delegateTaskFallback: '派出后台任务未成功',
      taskStatus: '查看后台任务进度未成功', steerTask: '调整后台任务未成功', cancelTask: '取消后台任务未成功', todo: '更新待办清单未成功', planUpdate: '更新计划未成功', planRead: '查看计划未成功', taskManager: '更新任务未成功',
      skill: '使用技能 {skill} 未成功', skillFallback: '使用技能未成功', screenshot: '截图未成功', askUser: '向你提问未成功', memoryStore: '保存记忆未成功', memorySearch: '搜索记忆未成功', toolSearch: '查找可用工具未成功', fallbackNeutral: '执行工具操作未成功',
      connectorFallbackAction: { queryStatus: '查询连接状态未成功', queryCollections: '查询可用列表未成功', queryItems: '查询日程未成功', query: '查询信息未成功', create: '创建内容未成功', update: '更新内容未成功', delete: '删除内容未成功' },
      group: { explored: '查看 {count} 次内容未成功', ran: '运行 {count} 条命令未成功', searchedWeb: '联网查询 {count} 次未成功', mcp: '调用 {count} 次工具未成功', subagent: '派发 {count} 次代理任务未成功', planned: '更新 {count} 次任务未成功', skill: '使用 {count} 次技能未成功', used: '执行 {count} 个步骤未成功' },
    },
  },
  domainActions: {
    'pending-approval': {
      browser: { query: '请求查看浏览器信息', create: '请求在浏览器中创建内容', update: '请求更新浏览器内容', delete: '请求清理浏览器数据', operate: '请求操作浏览器' },
      computer: { query: '请求查看电脑状态', create: '请求在电脑上创建内容', update: '请求更新电脑内容', delete: '请求清理电脑内容', operate: '请求操作电脑' },
      mcp: { query: '请求通过 {domain} 查询信息', create: '请求通过 {domain} 创建内容', update: '请求通过 {domain} 更新内容', delete: '请求通过 {domain} 删除内容', operate: '请求调用 {domain}' },
      tool: { query: '请求查询工具信息', create: '请求创建内容', update: '请求更新内容', delete: '请求删除内容', operate: '请求执行工具操作' },
    },
    running: {
      browser: { query: '正在查看浏览器信息', create: '正在浏览器中创建内容', update: '正在更新浏览器内容', delete: '正在清理浏览器数据', operate: '正在操作浏览器' },
      computer: { query: '正在查看电脑状态', create: '正在电脑上创建内容', update: '正在更新电脑内容', delete: '正在清理电脑内容', operate: '正在操作电脑' },
      mcp: { query: '正在通过 {domain} 查询信息', create: '正在通过 {domain} 创建内容', update: '正在通过 {domain} 更新内容', delete: '正在通过 {domain} 删除内容', operate: '正在调用 {domain}' },
      tool: { query: '正在查询工具信息', create: '正在创建内容', update: '正在更新内容', delete: '正在删除内容', operate: '正在执行工具操作' },
    },
    completed: {
      browser: { query: '查看了浏览器信息', create: '在浏览器中创建了内容', update: '更新了浏览器内容', delete: '清理了浏览器数据', operate: '操作了浏览器' },
      computer: { query: '查看了电脑状态', create: '在电脑上创建了内容', update: '更新了电脑内容', delete: '清理了电脑内容', operate: '操作了电脑' },
      mcp: { query: '通过 {domain} 查询了信息', create: '通过 {domain} 创建了内容', update: '通过 {domain} 更新了内容', delete: '通过 {domain} 删除了内容', operate: '调用了 {domain}' },
      tool: { query: '查询了工具信息', create: '创建了内容', update: '更新了内容', delete: '删除了内容', operate: '执行了工具操作' },
    },
    failed: {
      browser: { query: '查看浏览器信息未成功', create: '在浏览器中创建内容未成功', update: '更新浏览器内容未成功', delete: '清理浏览器数据未成功', operate: '操作浏览器未成功' },
      computer: { query: '查看电脑状态未成功', create: '在电脑上创建内容未成功', update: '更新电脑内容未成功', delete: '清理电脑内容未成功', operate: '操作电脑未成功' },
      mcp: { query: '通过 {domain} 查询信息未成功', create: '通过 {domain} 创建内容未成功', update: '通过 {domain} 更新内容未成功', delete: '通过 {domain} 删除内容未成功', operate: '调用 {domain} 未成功' },
      tool: { query: '查询工具信息未成功', create: '创建内容未成功', update: '更新内容未成功', delete: '删除内容未成功', operate: '执行工具操作未成功' },
    },
  },
  intentWrap: { 'pending-approval': '请求{action}', running: '正在{action}', failed: '{action}未成功' },
  pendingApprovalStatus: '待确认',
  failureCode: '错误码 {code}',
  failureReasonMissing: '工具未返回可读的失败原因',
};

export const toolStepVerbsEn: ToolStepVerbBundle = {
  statusForms: {
    'pending-approval': {
      declared: { tmeetMeetingListUpcoming: 'Request to check upcoming/in-progress meetings', tmeetMeetingListEnded: 'Request to check meetings ended in the last 30 days', tmeetMeetingCreate: 'Request to create a meeting', tmeetMeetingSearch: 'Request to search meetings' },
      read: 'Request to read {target}', readFallback: 'Request to read a file', write: 'Request to write {target}', writeFallback: 'Request to write a file', edit: 'Request to edit {target}', editFallback: 'Request to edit a file', bash: 'Request to run command {command}', bashFallback: 'Request to run a command', search: 'Request to search for {query}', searchFallback: 'Request to search content', listDir: 'Request to view the {target} directory', listDirFallback: 'Request to view a directory', webSearch: 'Request to search the web for {query}', webSearchFallback: 'Request to search the web', webFetch: 'Request to open {target}', webFetchFallback: 'Request to open a web page', mcpTool: 'Request to call {server}', channelMessage: 'Request to send a message in {channel}', subagentSpawn: 'Request to start an agent — {description}', subagentSpawnFallback: 'Request to start an agent', subagentMessage: 'Request to message an agent', agentConversation: 'Request to contact {name}', agentConversationFallback: 'Request to contact an agent', delegateTask: 'Request to start background task: {description}', delegateTaskFallback: 'Request to start a background task', taskStatus: 'Request to check background task progress', steerTask: 'Request to adjust a background task', cancelTask: 'Request to cancel a background task', todo: 'Request to update the to-do list', planUpdate: 'Request to update the plan', planRead: 'Request to view the plan', taskManager: 'Request to update tasks', skill: 'Request to use the {skill} skill', skillFallback: 'Request to use a skill', screenshot: 'Request to take a screenshot', askUser: 'Request to ask you a question', memoryStore: 'Request to save a memory', memorySearch: 'Request to search memory', toolSearch: 'Request to look up available tools', fallbackNeutral: 'Request to run a tool operation', connectorFallbackAction: { queryStatus: 'Request to check connection status', queryCollections: 'Request to list available collections', queryItems: 'Request to query items', query: 'Request to query information', create: 'Request to create content', update: 'Request to update content', delete: 'Request to delete content' }, group: { explored: 'Request to inspect content {count} times', ran: 'Request to run {count} commands', searchedWeb: 'Request to search the web {count} times', mcp: 'Request to call tools {count} times', subagent: 'Request to dispatch {count} agent tasks', planned: 'Request to update tasks {count} times', skill: 'Request to use skills {count} times', used: 'Request to run {count} steps' },
    },
    running: {
      declared: { tmeetMeetingListUpcoming: 'Checking upcoming/in-progress meetings', tmeetMeetingListEnded: 'Checking meetings ended in the last 30 days', tmeetMeetingCreate: 'Creating a meeting', tmeetMeetingSearch: 'Searching meetings' },
      read: 'Reading {target}', readFallback: 'Reading a file', write: 'Writing {target}', writeFallback: 'Writing a file', edit: 'Editing {target}', editFallback: 'Editing a file', bash: 'Running command {command}', bashFallback: 'Running a command', search: 'Searching for {query}', searchFallback: 'Searching content', listDir: 'Viewing the {target} directory', listDirFallback: 'Viewing a directory', webSearch: 'Searching the web for {query}', webSearchFallback: 'Searching the web', webFetch: 'Opening {target}', webFetchFallback: 'Opening a web page', mcpTool: 'Calling {server}', channelMessage: 'Sending a message in {channel}', subagentSpawn: 'Starting an agent — {description}', subagentSpawnFallback: 'Starting an agent', subagentMessage: 'Messaging an agent', agentConversation: 'Talking to {name}', agentConversationFallback: 'Talking to an agent', delegateTask: 'Starting background task: {description}', delegateTaskFallback: 'Starting a background task', taskStatus: 'Checking background task progress', steerTask: 'Adjusting a background task', cancelTask: 'Cancelling a background task', todo: 'Updating the to-do list', planUpdate: 'Updating the plan', planRead: 'Viewing the plan', taskManager: 'Updating tasks', skill: 'Using the {skill} skill', skillFallback: 'Using a skill', screenshot: 'Taking a screenshot', askUser: 'Waiting for your answer', memoryStore: 'Saving a memory', memorySearch: 'Searching memory', toolSearch: 'Looking up available tools', fallbackNeutral: 'Running a tool operation', connectorFallbackAction: { queryStatus: 'Checking connection status', queryCollections: 'Listing available collections', queryItems: 'Querying items', query: 'Querying information', create: 'Creating content', update: 'Updating content', delete: 'Deleting content' }, group: { explored: 'Inspecting content {count} times', ran: 'Running {count} commands', searchedWeb: 'Searching the web {count} times', mcp: 'Calling tools {count} times', subagent: 'Dispatching {count} agent tasks', planned: 'Updating tasks {count} times', skill: 'Using skills {count} times', used: 'Running {count} steps' },
    },
    failed: {
      declared: { tmeetMeetingListUpcoming: 'Could not check upcoming/in-progress meetings', tmeetMeetingListEnded: 'Could not check meetings ended in the last 30 days', tmeetMeetingCreate: 'Could not create a meeting', tmeetMeetingSearch: 'Could not search meetings' },
      read: 'Could not read {target}', readFallback: 'Could not read a file', write: 'Could not write {target}', writeFallback: 'Could not write a file', edit: 'Could not edit {target}', editFallback: 'Could not edit a file', bash: 'Could not run command {command}', bashFallback: 'Could not run a command', search: 'Could not search for {query}', searchFallback: 'Could not search content', listDir: 'Could not view the {target} directory', listDirFallback: 'Could not view a directory', webSearch: 'Could not search the web for {query}', webSearchFallback: 'Could not search the web', webFetch: 'Could not open {target}', webFetchFallback: 'Could not open a web page', mcpTool: 'Could not call {server}', channelMessage: 'Could not send a message in {channel}', subagentSpawn: 'Could not start an agent — {description}', subagentSpawnFallback: 'Could not start an agent', subagentMessage: 'Could not message an agent', agentConversation: 'Could not contact {name}', agentConversationFallback: 'Could not contact an agent', delegateTask: 'Could not start background task: {description}', delegateTaskFallback: 'Could not start a background task', taskStatus: 'Could not check background task progress', steerTask: 'Could not adjust a background task', cancelTask: 'Could not cancel a background task', todo: 'Could not update the to-do list', planUpdate: 'Could not update the plan', planRead: 'Could not view the plan', taskManager: 'Could not update tasks', skill: 'Could not use the {skill} skill', skillFallback: 'Could not use a skill', screenshot: 'Could not take a screenshot', askUser: 'Could not ask you a question', memoryStore: 'Could not save a memory', memorySearch: 'Could not search memory', toolSearch: 'Could not look up available tools', fallbackNeutral: 'Could not run the tool operation', connectorFallbackAction: { queryStatus: 'Could not check connection status', queryCollections: 'Could not list available collections', queryItems: 'Could not query items', query: 'Could not query information', create: 'Could not create content', update: 'Could not update content', delete: 'Could not delete content' }, group: { explored: 'Could not inspect content {count} times', ran: 'Could not run {count} commands', searchedWeb: 'Could not search the web {count} times', mcp: 'Could not call tools {count} times', subagent: 'Could not dispatch {count} agent tasks', planned: 'Could not update tasks {count} times', skill: 'Could not use skills {count} times', used: 'Could not run {count} steps' },
    },
  },
  domainActions: {
    'pending-approval': { browser: { query: 'Request to inspect browser information', create: 'Request to create browser content', update: 'Request to update browser content', delete: 'Request to clear browser data', operate: 'Request to control the browser' }, computer: { query: 'Request to inspect computer state', create: 'Request to create computer content', update: 'Request to update computer content', delete: 'Request to clear computer content', operate: 'Request to control the computer' }, mcp: { query: 'Request to query information through {domain}', create: 'Request to create content through {domain}', update: 'Request to update content through {domain}', delete: 'Request to delete content through {domain}', operate: 'Request to call {domain}' }, tool: { query: 'Request to query tool information', create: 'Request to create content', update: 'Request to update content', delete: 'Request to delete content', operate: 'Request to run a tool operation' } },
    running: { browser: { query: 'Inspecting browser information', create: 'Creating browser content', update: 'Updating browser content', delete: 'Clearing browser data', operate: 'Controlling the browser' }, computer: { query: 'Inspecting computer state', create: 'Creating computer content', update: 'Updating computer content', delete: 'Clearing computer content', operate: 'Controlling the computer' }, mcp: { query: 'Querying information through {domain}', create: 'Creating content through {domain}', update: 'Updating content through {domain}', delete: 'Deleting content through {domain}', operate: 'Calling {domain}' }, tool: { query: 'Querying tool information', create: 'Creating content', update: 'Updating content', delete: 'Deleting content', operate: 'Running a tool operation' } },
    completed: { browser: { query: 'Inspected browser information', create: 'Created browser content', update: 'Updated browser content', delete: 'Cleared browser data', operate: 'Controlled the browser' }, computer: { query: 'Inspected computer state', create: 'Created computer content', update: 'Updated computer content', delete: 'Cleared computer content', operate: 'Controlled the computer' }, mcp: { query: 'Queried information through {domain}', create: 'Created content through {domain}', update: 'Updated content through {domain}', delete: 'Deleted content through {domain}', operate: 'Called {domain}' }, tool: { query: 'Queried tool information', create: 'Created content', update: 'Updated content', delete: 'Deleted content', operate: 'Ran a tool operation' } },
    failed: { browser: { query: 'Could not inspect browser information', create: 'Could not create browser content', update: 'Could not update browser content', delete: 'Could not clear browser data', operate: 'Could not control the browser' }, computer: { query: 'Could not inspect computer state', create: 'Could not create computer content', update: 'Could not update computer content', delete: 'Could not clear computer content', operate: 'Could not control the computer' }, mcp: { query: 'Could not query information through {domain}', create: 'Could not create content through {domain}', update: 'Could not update content through {domain}', delete: 'Could not delete content through {domain}', operate: 'Could not call {domain}' }, tool: { query: 'Could not query tool information', create: 'Could not create content', update: 'Could not update content', delete: 'Could not delete content', operate: 'Could not run the tool operation' } },
  },
  intentWrap: { 'pending-approval': 'Request to {action}', running: '{action} in progress', failed: 'Could not {action}' },
  pendingApprovalStatus: 'Approval needed',
  failureCode: 'Error code {code}',
  failureReasonMissing: 'The tool did not return a readable failure reason',
};
