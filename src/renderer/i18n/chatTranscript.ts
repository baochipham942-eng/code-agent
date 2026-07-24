// ============================================================================
// Chat 转录域词条（ChatSearchBar / TurnBasedTraceView / ToolStepGroup /
// statusLabels / TurnDiffSummary / 相对时间）—— zh/en 同文件相邻维护。
// 拆出独立文件是为了让 zh.ts/en.ts 不撞 max-lines 棘轮（同 sessionReplay.ts 先例）。
// ============================================================================

export const chatTranscriptZh = {
chat: {
  thinking: '正在思考…',
  waitingModel: '正在等待模型响应…',
  waitingSubagent: '正在等待子任务…',
  thinkingDigest: '思考',
  thinkingSegments: ' · {count} 段',
  expandThinking: '展开思考',
  collapseThinking: '收起思考',
  unknownTool: '未知工具',
  compactionSummary: '已压缩 {count} 条消息',
  compactionTokensSaved: '节省 {count} tokens',
  compactionCountBadge: '已压缩 {count} 次',
  dropFilesHere: '拖放文件或文件夹到这里',
  configureModelKeyFirst: '当前主任务模型未配置 API Key，请切换到已配置的模型后再发送。',
  configureModelFirst: '先配置一个模型后再发送。',
  rewindWhileRunning: '会话还在运行，先停止后再回退。',
  rewindSuccess: '已回到这条提示词，恢复 {count} 个文件。',
  rewindConfirmTitle: '回到这条提示词？',
  rewindConfirmLine1: '会恢复工作区文件到这轮之前，并隐藏这条提示词及之后的对话。',
  rewindConfirmLine2: '原提示词会放回输入框，下一轮只会基于回退后的 active 对话继续。',
  rewindConfirmAction: '确认回退',
  rewindInProgress: '回退中…',
  streamInterruptedTitle: '上次回复在流式输出中断',
  streamInterruptedToolCalls: '{count} 个 tool call 只保留为恢复快照，未执行：{names}',
  streamInterruptedText: '部分文本已保留为恢复快照。',
  retryTurn: '重试该轮',
  retryTurnInProgress: '重试中…',
  welcomeTitle: '想完成什么？',
  welcomeSubtitle: '选一个示例，或者直接输入你想完成的事。',
  blankSession: '空白会话',
  projectSession: '项目会话 · {name}',
  inheritedWorkspace: '继承工作区：{path}',
  inheritedPrefix: '继承：{parts}',
  recentTools: '最近工具 {names}',
  suggestions: {
    game: {
      title: '做个能玩的小游戏',
      description: '霓虹贪吃蛇，键盘直接开玩',
      prompt: '用单个 HTML 文件做一个能直接玩的霓虹风《贪吃蛇》：方向键控制、实时计分与最高分、随长度逐渐加速、撞墙或咬到自己结束并可按键重开；深色背景、霓虹描边、流畅动画。直接给出完整可运行的单文件，不要问我任何问题。',
    },
    chart: {
      title: '出一张可交互数据图表',
      description: '聊天里直接渲染，可切换可悬停',
      prompt: '在聊天里直接渲染一张折线图，不要写 HTML 文件、不要调用任何工具。直接在回复里输出一个代码块（语言标记用 chart 或 json 均可），内容是图表 JSON，schema：{"type":"line","title":"编程语言流行度趋势 (2015–2024)","xKey":"year","series":[{"key":"Python"},{"key":"JavaScript"},{"key":"TypeScript"},{"key":"Rust"},{"key":"Go"}],"data":[{"year":2015,"Python":64,"JavaScript":90,"TypeScript":20,"Rust":8,"Go":18}, … 每年一条直到 2024]}。流行度取 0–100、用你掌握的合理近似。只输出这个代码块加一句话说明，不要问我任何问题。',
    },
    briefing: {
      title: '搜一份最新行业简报',
      description: '联网汇总近一周 AI 要闻',
      prompt: '联网搜索过去一周 AI 行业最值得关注的 5 件事：每条给标题、一句话摘要、为什么重要、来源链接，最后用一句话总结整体趋势。直接联网开始，不要问我任何问题。',
    },
    disk: {
      title: '梳理磁盘空间占用',
      description: '找出最占地的目录，给清理建议',
      prompt: '帮我梳理这台 Mac 的磁盘占用：用命令找出主目录下最占空间的前 15 个目录/文件并按大小排序，识别其中可安全清理的缓存、临时文件和重复构建产物，给出每项预计可释放的空间和具体清理命令（先列出，不要直接执行删除）。直接开始，不要问我任何问题。',
    },
  },
},
// 会话内/跨会话搜索（ChatSearchBar）
chatSearch: {
  placeholderCurrent: '搜索当前会话…',
  placeholderCross: '搜索所有会话…',
  tabCurrent: '当前',
  tabCross: '跨会话',
  zeroResults: '0 结果',
  crossSummary: '{matches} 条 / {sessions} 会话',
  searching: '搜索中…',
  prevMatch: '上一个 (Shift+Enter)',
  nextMatch: '下一个 (Enter)',
  close: '关闭 (Esc)',
  noMatches: '未找到匹配结果',
  roleUser: '用户',
  roleAssistant: '助手',
  roleSystem: '系统',
  turnNumber: '第 {n} 轮',
},

// 相对时间（utils/i18nTime.ts）
time: {
  justNow: '刚刚',
  minutesAgo: '{n}分钟前',
  hoursAgo: '{n}小时前',
  daysAgo: '{n}天前',
  monthsAgo: '{n}个月前',
},

// 转录滚动视图（TurnBasedTraceView）
traceView: {
  loadingOlder: '加载更早的消息…',
  scrollToLoadMore: '↑ 滚动加载更多',
  conversationLog: '对话消息',
  jumpToBottom: '回到底部',
},

// 工具步骤组（ToolStepGroup）
toolGroup: {
  statusRunning: '运行中',
  statusPartial: '部分失败',
  statusFailed: '失败',
  statusCompleted: '已完成',
  recovered: '已恢复',
  recoveredTitle: '这次失败后已自动恢复',
  outputCount: '{count} 个产物',
  summaryFailed: '{count} 失败',
  summaryEmpty: '{count} 空结果',
  summaryCompleted: '{count} 完成',
  completedSteps: '已完成 {count} 步',
},

// 工具步骤人话化（humanizeToolStep.ts）——把工具名+参数合成一句中文步骤文案，
// 消费方 ToolStepGroup 的步骤行；原工具名/参数仍在展开详情（ToolHeader/ToolDetails）里，不删信息。
toolStepHumanize: {
  read: '读取了 {target}',
  readFallback: '读取了一个文件',
  write: '写入了 {target}',
  writeFallback: '写入了一个文件',
  edit: '编辑了 {target}',
  editFallback: '编辑了一个文件',
  bash: '运行了命令 {command}',
  bashFallback: '运行了一条命令',
  search: '搜索了 {query}',
  searchFallback: '搜索了内容',
  listDir: '查看了 {target} 目录',
  listDirFallback: '查看了目录',
  webSearch: '搜索了网页 {query}',
  webSearchFallback: '搜索了网页',
  webFetch: '打开了 {target}',
  webFetchFallback: '打开了一个网页',
  mcpTool: '调用了 {server} 的 {tool}',
  channelMessage: '在{channel}发了一条消息',
  channelNames: { lark: '飞书', feishu: '飞书', slack: 'Slack', telegram: 'Telegram' } as Record<string, string>,
  subagentSpawn: '启动了子任务 — {description}',
  subagentSpawnFallback: '启动了一个子任务',
  subagentMessage: '给子任务发了条消息',
  todo: '更新了待办清单',
  planUpdate: '更新了计划',
  planRead: '查看了计划',
  skill: '执行了技能 {skill}',
  skillFallback: '执行了一个技能',
  screenshot: '截了一张图',
  computerUse: '电脑操作',
  browserAction: '浏览器',
  askUser: '向你提了一个问题',
  memoryStore: '记住了一条信息',
  memorySearch: '搜索了记忆',
  fallback: '使用了 {name}',
  group: {
    explored: '查看了 {count} 次内容',
    ran: '运行了 {count} 条命令',
    searchedWeb: '联网查了 {count} 次',
    mcp: '调用了 {count} 次工具',
    subagent: '派发了 {count} 次子任务',
    used: '使用了 {count} 次工具',
  },
},

// 单工具状态词表（statusLabels.ts 整表）
toolStatus: {
  default: { preparing: '准备中…', running: '执行中…', completed: '已完成', error: '执行失败' },
  mcp: { preparing: '准备调用…', running: '调用工具…', completed: '调用完成', error: '调用失败' },
  interrupted: '已中断',
  writeValidationFailed: '已写入，验收失败',
  bashExitCode: '已执行（退出码 {code}）',
  grepMatches: '找到 {count} 处匹配',
  grepNoMatches: '无匹配',
  globFiles: '找到 {count} 个文件',
  readLines: '已读取 {count} 行',
  tools: {
    Bash: { preparing: '生成命令…', running: '执行中…', completed: '已执行', error: '执行失败' },
    Read: { preparing: '定位文件…', running: '读取中…', completed: '已读取', error: '读取失败' },
    Write: { preparing: '准备内容…', running: '写入中…', completed: '已创建', error: '写入失败' },
    Edit: { preparing: '准备修改…', running: '编辑中…', completed: '已编辑', error: '编辑失败' },
    Glob: { preparing: '准备搜索…', running: '搜索文件…', completed: '搜索完成', error: '搜索失败' },
    Grep: { preparing: '准备搜索…', running: '搜索内容…', completed: '搜索完成', error: '搜索失败' },
    list_directory: { preparing: '准备浏览…', running: '浏览目录…', completed: '已列出', error: '浏览失败' },
    WebSearch: { preparing: '准备搜索…', running: '搜索网络…', completed: '搜索完成', error: '搜索失败' },
    web_fetch: { preparing: '准备抓取…', running: '抓取网页…', completed: '已抓取', error: '抓取失败' },
    task: { preparing: '准备任务…', running: '执行任务…', completed: '任务完成', error: '任务失败' },
    todo_write: { preparing: '更新待办…', running: '更新待办…', completed: '已更新', error: '更新失败' },
    plan_update: { preparing: '更新计划…', running: '更新计划…', completed: '已更新', error: '更新失败' },
    plan_read: { preparing: '读取计划…', running: '读取计划…', completed: '已读取', error: '读取失败' },
    AskUserQuestion: { preparing: '准备提问…', running: '等待回答…', completed: '已回答', error: '提问失败' },
    skill: { preparing: '加载技能…', running: '执行技能…', completed: '技能完成', error: '技能失败' },
    read_pdf: { preparing: '加载 PDF…', running: '读取 PDF…', completed: '已读取', error: '读取失败' },
    ppt_generate: { preparing: '准备生成…', running: '生成 PPT…', completed: '已生成', error: '生成失败' },
    image_generate: { preparing: '准备生成…', running: '生成图片…', completed: '已生成', error: '生成失败' },
    memory_store: { preparing: '准备存储…', running: '存储记忆…', completed: '已存储', error: '存储失败' },
    memory_search: { preparing: '准备搜索…', running: '搜索记忆…', completed: '已搜索', error: '搜索失败' },
    code_index: { preparing: '准备索引…', running: '建立索引…', completed: '已索引', error: '索引失败' },
    screenshot: { preparing: '准备截图…', running: '截图中…', completed: '已截图', error: '截图失败' },
    computer_use: { preparing: '准备操作…', running: '操作桌面…', completed: '操作完成', error: '操作失败' },
    browser_action: { preparing: '准备操作…', running: '操作浏览器…', completed: '操作完成', error: '操作失败' },
    spawn_agent: { preparing: '准备启动…', running: '启动 Agent…', completed: '已启动', error: '启动失败' },
    agent_message: { preparing: '准备发送…', running: '发送消息…', completed: '已发送', error: '发送失败' },
    findings_write: { preparing: '记录发现…', running: '写入发现…', completed: '已记录', error: '记录失败' },
  },
},

// 回合级文件变更卡（TurnDiffSummary）
turnDiff: {
  filesChangedOne: '1 个文件已修改',
  filesChangedMany: '{count} 个文件已修改',
  undo: '撤销',
  undone: '已撤销',
  undoFailed: '撤销失败',
  undoAllTitle: '撤销本轮所有文件变更',
  sessionRunning: '会话进行中',
  noCheckpoint: '无可用 checkpoint',
  undoToastFailed: '撤销文件变更失败：{message}',
  confirmTitle: '撤销本轮文件变更？',
  confirmMessage: '将回滚本轮对 {count} 个文件的全部修改，当前内容会被 checkpoint 覆盖。',
  confirmAction: '撤销变更',
  newFileBadge: '新建',
},

// 回合运行状态（TurnCard 顶部状态条 + 流式状态横幅）——两处消费同一套键，别建两套
turnRun: {
  status: {
    cancelling: '正在停止',
    resumable: '已中断，可继续',
    stale: '连接已断开',
    waitingTool: '等待工具',
    usingTools: '正在使用工具',
    running: '进行中',
    blocked: '遇到问题',
    cancelled: '已取消',
    completed: '已完成',
  },
  detail: {
    cancelling: '正在清理本轮流式输出和未完成工具',
    blocked: '本轮运行遇到错误，等待恢复或重新执行',
    resumable: '上次流式输出未完成，可从会话操作里继续',
    cancelled: '本轮流式输出已停止，未保留半截内容',
    waitingTool: '工具调用仍在返回结果',
    usingTools: '工具调用已开始，结果会并入当前回复',
    running: '内容正在流式写入当前回复',
    stale: '保留现场但不重复播放旧内容',
  },
  cleanupBadge: '清理中',
  resumeBadge: '可继续',
  outputsSignal: '{count} 个产出',
  toolsSignal: '{count} 次工具调用',
},

// 系统错误节点兜底文案（TraceNodeRenderer 的 node.subtype === 'error'）——
// 分类错误走 humanizeToolError 已有文案，这里只兜分不出类别的情况 + 折叠按钮。
systemError: {
  fallbackSummary: '执行时出了问题',
  fallbackDetail: '可以重试一次，或换个说法再试试。',
  viewDetails: '查看详情',
  hideDetails: '收起',
},

// 工具报错人话化（toolExecutionPresentation.ts 的 humanizeToolError，7 类）——
// 判别顺序有意为之，额度/余额排最前，避免上游把额度错误裹成 401 被误判成鉴权。
toolErrors: {
  quota: {
    summary: '额度/余额不足：当前服务的用量或余额已耗尽',
    detail: '请充值，或在设置里换一个还有额度的 key。',
    sourcesSummary: '联网搜索额度不足：{sources} 的 API 套餐用量已耗尽',
    sourcesDetail: '要恢复这些源请充值，或换一个还有额度的 key。',
  },
  rateLimit: {
    summary: '请求过于频繁，被限流',
    detail: '稍等片刻会自动重试；如持续可降低并发或稍后再试。',
  },
  auth: {
    summary: '鉴权失败：API Key 无效或无权限',
    detail: '去「设置 > Service API Keys」检查对应服务的 Key。',
  },
  overloaded: {
    summary: '服务过载或暂时不可用',
    detail: '稍后会自动重试。',
  },
  timeout: {
    summary: '请求超时',
    detail: '稍后重试，或检查网络 / 代理。',
  },
  network: {
    summary: '网络异常，连接失败',
    detail: '检查网络或代理后重试。',
  },
  autoLoaded: {
    summary: '工具已自动加载，正在用正确参数重试',
  },
},

// 工具恢复提示（ToolCallDisplay 的 getToolRecoveryHint，仅失败/中断/已产出场景展示）
toolRecoveryHint: {
  pending: '等待结果',
  interrupted: '可重新运行',
  errorWithOutcome: '可重试：{outcome}',
  errorGeneric: '可以重试或换个工具',
  outputRecorded: '产物已记录',
  resultRecorded: '结果已记录',
},

// 实时预览诊断条（LivePreviewFrame）——frameError 原文 + CSP snippet 折叠在
// systemError 的查看详情/收起键后面，这里只放固定的人话摘要+建议。
livePreview: {
  loadFailedSummary: '预览没加载出来',
  loadFailedSuggestion: '试试刷新页面，或让 agent 重新生成一次预览。',
  cspLabel: '生效 CSP',
}
};

export const chatTranscriptEn: typeof chatTranscriptZh = {
chat: {
  thinking: 'Thinking…',
  waitingModel: 'Waiting for the model…',
  waitingSubagent: 'Waiting on a subtask…',
  thinkingDigest: 'Thinking',
  thinkingSegments: ' · {count} segments',
  expandThinking: 'Expand thinking',
  collapseThinking: 'Collapse thinking',
  unknownTool: 'Unknown tool',
  compactionSummary: '{count} messages compacted',
  compactionTokensSaved: 'Saved {count} tokens',
  compactionCountBadge: 'Compacted {count} times',
  dropFilesHere: 'Drop files or folders here',
  configureModelKeyFirst: 'The main task model has no API key configured. Switch to a configured model before sending.',
  configureModelFirst: 'Configure a model before sending.',
  rewindWhileRunning: 'The session is still running. Stop it before rewinding.',
  rewindSuccess: 'Rewound to this prompt and restored {count} files.',
  rewindConfirmTitle: 'Rewind to this prompt?',
  rewindConfirmLine1: 'Workspace files will be restored to before this turn, and this prompt plus everything after it will be hidden.',
  rewindConfirmLine2: 'The original prompt goes back into the input box; the next turn continues from the rewound conversation only.',
  rewindConfirmAction: 'Rewind',
  rewindInProgress: 'Rewinding…',
  streamInterruptedTitle: 'The last reply was interrupted mid-stream',
  streamInterruptedToolCalls: '{count} tool calls were kept as a recovery snapshot and not executed: {names}',
  streamInterruptedText: 'Partial text was kept as a recovery snapshot.',
  retryTurn: 'Retry this turn',
  retryTurnInProgress: 'Retrying…',
  welcomeTitle: 'What do you want to get done?',
  welcomeSubtitle: 'Pick an example, or just type what you want to do.',
  blankSession: 'Blank session',
  projectSession: 'Project session · {name}',
  inheritedWorkspace: 'Inherited workspace: {path}',
  inheritedPrefix: 'Inherited: {parts}',
  recentTools: 'Recent tools {names}',
  suggestions: {
    game: {
      title: 'Build a playable mini game',
      description: 'Neon Snake, playable with your keyboard',
      prompt: 'Build a playable neon-style Snake game in a single HTML file: arrow-key controls, live score and high score, speed that ramps up as the snake grows, game over on wall or self collision with a key to restart; dark background, neon strokes, smooth animation. Give me the complete runnable single file directly, without asking me any questions.',
    },
    chart: {
      title: 'Render an interactive data chart',
      description: 'Rendered right in the chat, switchable and hoverable',
      prompt: 'Render a line chart directly in the chat. Do not write an HTML file or call any tools. Reply with a single code block (language tag chart or json) containing chart JSON with this schema: {"type":"line","title":"Programming language popularity (2015–2024)","xKey":"year","series":[{"key":"Python"},{"key":"JavaScript"},{"key":"TypeScript"},{"key":"Rust"},{"key":"Go"}],"data":[{"year":2015,"Python":64,"JavaScript":90,"TypeScript":20,"Rust":8,"Go":18}, … one entry per year through 2024]}. Use popularity values from 0–100 based on your reasonable estimates. Output only that code block plus one sentence of explanation, without asking me any questions.',
    },
    briefing: {
      title: 'Compile a fresh industry brief',
      description: 'Summarize this week’s AI news from the web',
      prompt: 'Search the web for the 5 most noteworthy things in the AI industry from the past week: for each, give a title, a one-sentence summary, why it matters, and a source link, then close with one sentence on the overall trend. Start searching right away, without asking me any questions.',
    },
    disk: {
      title: 'Map my disk usage',
      description: 'Find the biggest directories and suggest cleanup',
      prompt: 'Help me map disk usage on this Mac: use commands to find the top 15 largest directories/files under my home directory sorted by size, identify caches, temp files, and duplicate build artifacts that are safe to clean, and give the estimated space freed plus the exact cleanup command for each (list them first, do not run any deletion). Start right away, without asking me any questions.',
    },
  },
},
// In-session / cross-session search (ChatSearchBar)
chatSearch: {
  placeholderCurrent: 'Search this session…',
  placeholderCross: 'Search all sessions…',
  tabCurrent: 'Current',
  tabCross: 'All sessions',
  zeroResults: '0 results',
  crossSummary: '{matches} matches / {sessions} sessions',
  searching: 'Searching…',
  prevMatch: 'Previous (Shift+Enter)',
  nextMatch: 'Next (Enter)',
  close: 'Close (Esc)',
  noMatches: 'No matches found',
  roleUser: 'User',
  roleAssistant: 'Assistant',
  roleSystem: 'System',
  turnNumber: 'Turn {n}',
},

// Relative time (utils/i18nTime.ts)
time: {
  justNow: 'just now',
  minutesAgo: '{n}m ago',
  hoursAgo: '{n}h ago',
  daysAgo: '{n}d ago',
  monthsAgo: '{n}mo ago',
},

// Transcript scroll view (TurnBasedTraceView)
traceView: {
  loadingOlder: 'Loading earlier messages…',
  scrollToLoadMore: '↑ Scroll to load more',
  conversationLog: 'Conversation messages',
  jumpToBottom: 'Jump to bottom',
},

// Tool step group (ToolStepGroup)
toolGroup: {
  statusRunning: 'running',
  statusPartial: 'partial',
  statusFailed: 'failed',
  statusCompleted: 'completed',
  recovered: 'Recovered',
  recoveredTitle: 'This failure was automatically recovered',
  outputCount: '{count} outputs',
  summaryFailed: '{count} failed',
  summaryEmpty: '{count} empty',
  summaryCompleted: '{count} completed',
  completedSteps: '{count} steps completed',
},

// Tool step humanization (humanizeToolStep.ts) — synthesizes a one-line, plain-language
// summary of a tool call from its name + args; consumed by ToolStepGroup's step row.
// The raw tool name/args still show in the expanded detail (ToolHeader/ToolDetails).
toolStepHumanize: {
  read: 'Read {target}',
  readFallback: 'Read a file',
  write: 'Wrote {target}',
  writeFallback: 'Wrote a file',
  edit: 'Edited {target}',
  editFallback: 'Edited a file',
  bash: 'Ran command {command}',
  bashFallback: 'Ran a command',
  search: 'Searched for {query}',
  searchFallback: 'Searched',
  listDir: 'Viewed the {target} directory',
  listDirFallback: 'Viewed a directory',
  webSearch: 'Searched the web for {query}',
  webSearchFallback: 'Searched the web',
  webFetch: 'Opened {target}',
  webFetchFallback: 'Opened a web page',
  mcpTool: 'Called {tool} on {server}',
  channelMessage: 'Sent a message in {channel}',
  channelNames: { lark: 'Lark', feishu: 'Feishu', slack: 'Slack', telegram: 'Telegram' } as Record<string, string>,
  subagentSpawn: 'Started a subtask — {description}',
  subagentSpawnFallback: 'Started a subtask',
  subagentMessage: 'Sent a message to a subtask',
  todo: 'Updated the to-do list',
  planUpdate: 'Updated the plan',
  planRead: 'Viewed the plan',
  skill: 'Ran the {skill} skill',
  skillFallback: 'Ran a skill',
  screenshot: 'Took a screenshot',
  computerUse: 'Computer',
  browserAction: 'Browser',
  askUser: 'Asked you a question',
  memoryStore: 'Saved a memory',
  memorySearch: 'Searched memory',
  fallback: 'Used {name}',
  group: {
    explored: 'Looked at content {count} times',
    ran: 'Ran {count} commands',
    searchedWeb: 'Searched the web {count} times',
    mcp: 'Called tools {count} times',
    subagent: 'Dispatched {count} subtasks',
    used: 'Used tools {count} times',
  },
},

// Per-tool status labels (statusLabels.ts)
toolStatus: {
  default: { preparing: 'Preparing…', running: 'Running…', completed: 'Completed', error: 'Failed' },
  mcp: { preparing: 'Preparing call…', running: 'Calling tool…', completed: 'Call completed', error: 'Call failed' },
  interrupted: 'Interrupted',
  writeValidationFailed: 'Written, validation failed',
  bashExitCode: 'Executed (exit code {code})',
  grepMatches: 'Found {count} matches',
  grepNoMatches: 'No matches',
  globFiles: 'Found {count} files',
  readLines: 'Read {count} lines',
  tools: {
    Bash: { preparing: 'Composing command…', running: 'Running…', completed: 'Executed', error: 'Execution failed' },
    Read: { preparing: 'Locating file…', running: 'Reading…', completed: 'Read', error: 'Read failed' },
    Write: { preparing: 'Preparing content…', running: 'Writing…', completed: 'Created', error: 'Write failed' },
    Edit: { preparing: 'Preparing edit…', running: 'Editing…', completed: 'Edited', error: 'Edit failed' },
    Glob: { preparing: 'Preparing search…', running: 'Searching files…', completed: 'Search done', error: 'Search failed' },
    Grep: { preparing: 'Preparing search…', running: 'Searching content…', completed: 'Search done', error: 'Search failed' },
    list_directory: { preparing: 'Preparing…', running: 'Listing directory…', completed: 'Listed', error: 'Listing failed' },
    WebSearch: { preparing: 'Preparing search…', running: 'Searching the web…', completed: 'Search done', error: 'Search failed' },
    web_fetch: { preparing: 'Preparing fetch…', running: 'Fetching page…', completed: 'Fetched', error: 'Fetch failed' },
    task: { preparing: 'Preparing task…', running: 'Running task…', completed: 'Task done', error: 'Task failed' },
    todo_write: { preparing: 'Updating todos…', running: 'Updating todos…', completed: 'Updated', error: 'Update failed' },
    plan_update: { preparing: 'Updating plan…', running: 'Updating plan…', completed: 'Updated', error: 'Update failed' },
    plan_read: { preparing: 'Reading plan…', running: 'Reading plan…', completed: 'Read', error: 'Read failed' },
    AskUserQuestion: { preparing: 'Preparing question…', running: 'Waiting for answer…', completed: 'Answered', error: 'Question failed' },
    skill: { preparing: 'Loading skill…', running: 'Running skill…', completed: 'Skill done', error: 'Skill failed' },
    read_pdf: { preparing: 'Loading PDF…', running: 'Reading PDF…', completed: 'Read', error: 'Read failed' },
    ppt_generate: { preparing: 'Preparing…', running: 'Generating slides…', completed: 'Generated', error: 'Generation failed' },
    image_generate: { preparing: 'Preparing…', running: 'Generating image…', completed: 'Generated', error: 'Generation failed' },
    memory_store: { preparing: 'Preparing…', running: 'Storing memory…', completed: 'Stored', error: 'Store failed' },
    memory_search: { preparing: 'Preparing…', running: 'Searching memory…', completed: 'Searched', error: 'Search failed' },
    code_index: { preparing: 'Preparing…', running: 'Building index…', completed: 'Indexed', error: 'Indexing failed' },
    screenshot: { preparing: 'Preparing…', running: 'Taking screenshot…', completed: 'Captured', error: 'Screenshot failed' },
    computer_use: { preparing: 'Preparing…', running: 'Controlling desktop…', completed: 'Done', error: 'Operation failed' },
    browser_action: { preparing: 'Preparing…', running: 'Controlling browser…', completed: 'Done', error: 'Operation failed' },
    spawn_agent: { preparing: 'Preparing…', running: 'Starting agent…', completed: 'Started', error: 'Start failed' },
    agent_message: { preparing: 'Preparing…', running: 'Sending message…', completed: 'Sent', error: 'Send failed' },
    findings_write: { preparing: 'Recording…', running: 'Writing findings…', completed: 'Recorded', error: 'Recording failed' },
  },
},

// Turn-level file change card (TurnDiffSummary)
turnDiff: {
  filesChangedOne: '1 file changed',
  filesChangedMany: '{count} files changed',
  undo: 'Undo',
  undone: 'Undone',
  undoFailed: 'Undo failed',
  undoAllTitle: 'Undo all file changes from this turn',
  sessionRunning: 'Session in progress',
  noCheckpoint: 'No checkpoint available',
  undoToastFailed: 'Failed to undo file changes: {message}',
  confirmTitle: 'Undo this turn’s file changes?',
  confirmMessage: 'This rolls back all changes to {count} files from this turn; current contents will be overwritten by the checkpoint.',
  confirmAction: 'Undo changes',
  newFileBadge: 'new',
},

// Turn run status (TurnCard header chip + streaming state banner) — shared key set
turnRun: {
  status: {
    cancelling: 'Stopping…',
    resumable: 'Interrupted — resumable',
    stale: 'Connection lost',
    waitingTool: 'Waiting for tool',
    usingTools: 'Using tools',
    running: 'In progress',
    blocked: 'Ran into a problem',
    cancelled: 'Cancelled',
    completed: 'Completed',
  },
  detail: {
    cancelling: 'Cleaning up this turn’s streaming output and unfinished tools',
    blocked: 'This turn ran into an error. Waiting to resume or retry.',
    resumable: 'The last stream was left unfinished. You can continue it from the session actions.',
    cancelled: 'This turn’s stream was stopped; no partial content was kept.',
    waitingTool: 'The tool call is still returning a result.',
    usingTools: 'A tool call has started; its result will be folded into the current reply.',
    running: 'Content is streaming into the current reply.',
    stale: 'Keeping the state without replaying old content.',
  },
  cleanupBadge: 'cleanup',
  resumeBadge: 'resume',
  outputsSignal: '{count} outputs',
  toolsSignal: '{count} tool calls',
},

// System error node fallback copy (TraceNodeRenderer node.subtype === 'error') —
// classified errors use humanizeToolError's existing copy; this only covers
// the unclassified fallback + the collapse toggle.
systemError: {
  fallbackSummary: 'Something went wrong while running this',
  fallbackDetail: 'Try again, or rephrase your request.',
  viewDetails: 'View details',
  hideDetails: 'Hide',
},

// Tool error humanization (toolExecutionPresentation.ts's humanizeToolError, 7 kinds) —
// order is intentional: quota/balance is checked first since upstream often wraps quota
// errors as HTTP 401, which would otherwise be misread as an auth failure.
toolErrors: {
  quota: {
    summary: 'Quota or balance exhausted for this service',
    detail: 'Top up, or switch to a key with remaining quota in settings.',
    sourcesSummary: 'Search quota exhausted: usage for {sources} is used up',
    sourcesDetail: 'Top up these sources, or switch to a key with remaining quota.',
  },
  rateLimit: {
    summary: 'Rate limited: too many requests',
    detail: 'This will retry automatically shortly; lower concurrency or try again later if it persists.',
  },
  auth: {
    summary: 'Authentication failed: invalid API key or no permission',
    detail: 'Check the key for this service under Settings > Service API Keys.',
  },
  overloaded: {
    summary: 'Service overloaded or temporarily unavailable',
    detail: 'This will retry automatically shortly.',
  },
  timeout: {
    summary: 'Request timed out',
    detail: 'Retry later, or check your network / proxy.',
  },
  network: {
    summary: 'Network error: connection failed',
    detail: 'Check your network or proxy, then retry.',
  },
  autoLoaded: {
    summary: 'Tool was auto-loaded and is retrying with the correct arguments',
  },
},

// Tool recovery hint (ToolCallDisplay's getToolRecoveryHint, shown only for
// failed/interrupted/output-produced states)
toolRecoveryHint: {
  pending: 'Waiting for result',
  interrupted: 'Can be re-run',
  errorWithOutcome: 'Retry: {outcome}',
  errorGeneric: 'Retry, or try another tool',
  outputRecorded: 'Output recorded',
  resultRecorded: 'Result recorded',
},

// Live preview diagnostic strip (LivePreviewFrame) — frameError text + CSP
// snippet collapse behind systemError's view/hide keys; this only holds the
// fixed human summary + suggestion.
livePreview: {
  loadFailedSummary: "The preview didn't load",
  loadFailedSuggestion: 'Try refreshing the page, or ask the agent to regenerate the preview.',
  cspLabel: 'Effective CSP',
}
};
