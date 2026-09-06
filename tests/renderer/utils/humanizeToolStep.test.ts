import { describe, expect, it } from 'vitest';
import {
  humanizeToolStep,
  humanizeToolGroupLabel,
  isInternalStreamTool,
  getToolFilePath,
} from '../../../src/renderer/utils/humanizeToolStep';
import { humanizeInterruptedToolAction } from '../../../src/renderer/utils/streamInterruptionPresentation';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

describe('humanizeToolStep — per-category snapshots (zh)', () => {
  it('read: file path shortened', () => {
    expect(humanizeToolStep('Read', { file_path: '/Users/me/project/docs/报告.md' }, zh))
      .toBe('读取了 …/docs/报告.md');
  });

  it('read: fallback with no path', () => {
    expect(humanizeToolStep('Read', {}, zh)).toBe('读取了一个文件');
  });

  it('write', () => {
    expect(humanizeToolStep('Write', { file_path: 'notes.md' }, zh)).toBe('写入了 notes.md');
  });

  it('edit', () => {
    expect(humanizeToolStep('Edit', { file_path: 'src/index.ts' }, zh)).toBe('编辑了 src/index.ts');
  });

  it('bash: uses command preview when no shortDescription', () => {
    expect(humanizeToolStep('Bash', { command: 'ls src/' }, zh)).toBe('运行了命令 ls src/');
  });

  it('bash: shortDescription wins over command', () => {
    expect(humanizeToolStep('Bash', { command: 'ls src/' }, zh, '列出源码目录')).toBe('列出源码目录');
  });

  it('bash: schema description becomes the user-facing narration', () => {
    expect(humanizeToolStep('Bash', { command: 'ls src/', description: '列出源码目录' }, zh))
      .toBe('列出源码目录');
  });

  // 「注入对用户可见」红线在会话侧的一半：Neo 往用户终端敲了什么，聊天里要读得出来，
  // 不能只显示一句「使用了 terminal_write」。
  it('terminal_write: shows what was typed into the user terminal', () => {
    expect(humanizeToolStep('terminal_write', { input: 'grok ask "hi"' }, zh))
      .toBe('运行了命令 grok ask "hi"');
  });

  it('search: Grep pattern', () => {
    expect(humanizeToolStep('Grep', { pattern: 'TODO' }, zh)).toBe('搜索了 TODO');
  });

  it('search: Glob pattern', () => {
    expect(humanizeToolStep('Glob', { pattern: '**/*.ts' }, zh)).toBe('搜索了 **/*.ts');
  });

  it('listDir', () => {
    expect(humanizeToolStep('list_directory', { path: '/Users/me/project/src/renderer' }, zh))
      .toBe('查看了 …/src/renderer 目录');
  });

  it('webSearch', () => {
    expect(humanizeToolStep('WebSearch', { query: '飞书 MCP' }, zh)).toBe('搜索了网页 飞书 MCP');
  });

  it('webFetch', () => {
    expect(humanizeToolStep('WebFetch', { url: 'https://example.com/docs' }, zh))
      .toBe('打开了 https://example.com/docs');
  });

  it('mcp: generic server/tool', () => {
    expect(humanizeToolStep('mcp__github__create_issue', {}, zh))
      .toBe('通过 github 创建了内容');
  });

  it('mcp: legacy single-underscore naming', () => {
    expect(humanizeToolStep('mcp_exa_search', {}, zh)).toBe('通过 exa 查询了信息');
  });

  it('mcp channel: lark message send', () => {
    expect(humanizeToolStep('mcp__lark__im_v1_message_create', {}, zh))
      .toBe('在飞书发了一条消息');
  });

  it('mcp channel: non-messaging lark tool stays generic', () => {
    expect(humanizeToolStep('mcp__lark__calendar_v4_event_list', {}, zh))
      .toBe('通过 lark 查询了信息');
  });

  it('subagent spawn: with description', () => {
    expect(humanizeToolStep('spawn_agent', { description: '核对发版清单' }, zh))
      .toBe('启动了代理 — 核对发版清单');
  });

  it('subagent spawn: fallback with no description', () => {
    expect(humanizeToolStep('Task', {}, zh)).toBe('启动了一个代理');
  });

  it('subagent message', () => {
    expect(humanizeToolStep('agent_message', {}, zh)).toBe('正在跟代理说话');
  });

  it('agent conversation uses the peer name from caller-provided arguments', () => {
    expect(humanizeToolStep('teammate', { name: '研究代理' }, zh)).toBe('正在跟 研究代理 说话');
    expect(humanizeToolStep('send_input', { agentId: '审阅代理' }, zh)).toBe('正在跟 审阅代理 说话');
  });

  it('delegate_task: uses args.description when present', () => {
    expect(humanizeToolStep('delegate_task', { description: '统计三个配置文件行数' }, zh))
      .toBe('派出后台任务：统计三个配置文件行数');
  });

  it('delegate_task: falls back without args.description', () => {
    expect(humanizeToolStep('delegate_task', {}, zh)).toBe('派出后台任务');
  });

  it('delegate_task: uses the current schema title when description is absent', () => {
    expect(humanizeToolStep('delegate_task', { title: '统计配置文件' }, zh))
      .toBe('派出后台任务：统计配置文件');
  });

  it('task_status: has a stable progress template', () => {
    expect(humanizeToolStep('task_status', {}, zh)).toBe('查看后台任务进度');
  });

  it('todo', () => {
    expect(humanizeToolStep('todo_write', { todos: [] }, zh)).toBe('更新了待办清单');
  });

  it('plan update', () => {
    expect(humanizeToolStep('plan_update', {}, zh)).toBe('更新了计划');
  });

  it('plan read', () => {
    expect(humanizeToolStep('plan_read', {}, zh)).toBe('查看了计划');
  });

  it('skill (lowercase): uses skill name', () => {
    expect(humanizeToolStep('skill', { skill: 'lark-doc' }, zh)).toBe('使用了技能 lark-doc');
  });

  it('Skill (PascalCase schema name): reads command arg', () => {
    expect(humanizeToolStep('Skill', { command: 'frontend-slides' }, zh))
      .toBe('使用了技能 frontend-slides');
  });

  it('TaskManager: human verb, never the internal tool name on the main line', () => {
    const line = humanizeToolStep('TaskManager', { action: 'update', taskId: '1' }, zh);
    expect(line).toBe('更新了任务');
    expect(line).not.toMatch(/TaskManager/i);
  });

  it('ToolSearch: detail wording only; never leaks ToolSearch as "使用了 …"', () => {
    const line = humanizeToolStep('ToolSearch', { query: 'browser' }, zh);
    expect(line).toBe('查找了可用工具');
    expect(line).not.toMatch(/ToolSearch/i);
    expect(line).not.toMatch(/使用了/);
  });

  it('screenshot', () => {
    expect(humanizeToolStep('screenshot', {}, zh)).toBe('截了一张图');
  });

  it('askUser', () => {
    expect(humanizeToolStep('AskUserQuestion', { question: '要继续吗？' }, zh)).toBe('向你提了一个问题');
  });

  it('memory store', () => {
    expect(humanizeToolStep('memory_store', {}, zh)).toBe('记住了一条信息');
  });

  it('memory search', () => {
    expect(humanizeToolStep('memory_search', {}, zh)).toBe('搜索了记忆');
  });

  // 未识别工具没有用户语义，原始 id 只留在展开明细的次级小字。
  it('unknown tool: 确实推不出动作时使用中性兜底', () => {
    const line = humanizeToolStep('some_future_tool', {}, zh);
    expect(line).toBe('执行了工具操作');
    expect(line).not.toContain('some_future_tool');
  });

  it('unknown tool failed: 失败行主文案不暴露工具名', () => {
    const line = humanizeToolStep('MemoryWrite', { action: 'write', filename: 'x.md' }, zh, undefined, 'failed');
    expect(line).toBe('创建内容未成功');
    expect(line).not.toContain('MemoryWrite');
  });

  it('unknown tool failed (en): 失败行主文案不暴露工具名', () => {
    expect(humanizeToolStep('MemoryWrite', {}, en, undefined, 'failed')).toBe('Could not run the tool operation');
  });

  // 钉住原规矩：isInternalStreamTool 命中的纯内部动作（ToolSearch）仍不带内部名进主行。
  it('internal stream tool: 兜底仍不暴露内部名', () => {
    for (const name of ['ToolSearch', 'tool_search']) {
      expect(isInternalStreamTool(name)).toBe(true);
      const line = humanizeToolStep(name, {}, zh);
      expect(line).not.toContain(name);
    }
  });

  it('shortDescription wins over the template when it matches the UI language', () => {
    expect(humanizeToolStep('some_future_tool', {}, zh, '做了一件事')).toBe('做了一件事');
  });

  it.each([
    ['tmeetMeetingList', { scope: 'upcoming' }, 'tmeetMeetingListUpcoming', '查了待开始/进行中的会议'],
    ['tmeetMeetingList', { scope: 'ended' }, 'tmeetMeetingListEnded', '查了近 30 天已结束的会议'],
    ['tmeetMeetingCreate', {}, 'tmeetMeetingCreate', '创建了一场会议'],
    ['tmeetMeetingSearch', {}, 'tmeetMeetingSearch', '搜索了会议'],
  ] as const)('schema stepLabel: %s 使用本地化人话句', (name, args, stepLabel, expected) => {
    expect(humanizeToolStep(name, args, zh, 'Use internal tool', 'completed', stepLabel)).toBe(expected);
  });

  it.each([
    ['tmeetMeetingCreate', {}, 'tmeetMeetingCreate', '创建会议未成功'],
    ['tmeetMeetingSearch', {}, 'tmeetMeetingSearch', '搜索会议未成功'],
    ['mcp__github__create_issue', {}, undefined, '通过 github 创建内容未成功'],
    ['mcp__lark__im_v1_message_create', {}, undefined, '在飞书发消息未成功'],
    ['Read', { file_path: 'report.md' }, undefined, '读取 report.md 未成功'],
    ['Bash', { command: 'npm test' }, undefined, '运行命令 npm test 未成功'],
    ['todo_write', {}, undefined, '更新待办清单未成功'],
  ] as const)('failed %s 使用未遂式，不声称动作已经完成', (name, args, stepLabel, expected) => {
    expect(humanizeToolStep(name, args, zh, '执行了这个动作', 'failed', stepLabel)).toBe(expected);
  });

  it('failed 类目忽略模型写成过去时的 shortDescription', () => {
    expect(humanizeToolStep('WebFetch', { url: 'https://example.com' }, zh, '打开了网页', 'failed'))
      .toBe('打开 https://example.com 未成功');
  });

  it('failed 类目在英文界面也使用 intent phrasing', () => {
    expect(humanizeToolStep('mcp__lark__im_v1_message_create', {}, en, 'Sent the message', 'failed'))
      .toBe('Could not send a message in Lark');
    expect(humanizeToolStep('Bash', { command: 'npm test' }, en, undefined, 'failed'))
      .toBe('Could not run command npm test');
  });

  it.each([
    ['Write', { file_path: 'notes.md' }, '写入 notes.md 未成功'],
    ['Edit', { file_path: 'src/index.ts' }, '编辑 src/index.ts 未成功'],
    ['Grep', { pattern: 'TODO' }, '搜索 TODO 未成功'],
    ['list_directory', { path: 'src' }, '查看 src 目录未成功'],
    ['WebSearch', { query: 'Neo' }, '联网搜索 Neo 未成功'],
    ['spawn_agent', { description: '核对清单' }, '启动代理未成功 — 核对清单'],
    ['wait_agent', {}, '给代理发消息未成功'],
    ['teammate', { name: '劳拉' }, '联系 劳拉 未成功'],
    ['delegate_task', { description: '核对清单' }, '派出后台任务未成功：核对清单'],
    ['task_status', {}, '查看后台任务进度未成功'],
    ['steer_task', {}, '调整后台任务未成功'],
    ['cancel_task', {}, '取消后台任务未成功'],
    ['plan_update', {}, '更新计划未成功'],
    ['plan_read', {}, '查看计划未成功'],
    ['TaskManager', {}, '更新任务未成功'],
    ['Skill', { command: 'lark-doc' }, '使用技能 lark-doc 未成功'],
    ['screenshot', {}, '截图未成功'],
    ['computer_use', { action: 'click', selector: '#save' }, '操作电脑未成功 · #save'],
    ['browser_action', { action: 'click', selector: '#save' }, '操作浏览器未成功 · #save'],
    ['AskUserQuestion', {}, '向你提问未成功'],
    ['memory_store', {}, '保存记忆未成功'],
    ['memory_search', {}, '搜索记忆未成功'],
    ['ToolSearch', {}, '查找可用工具未成功'],
    ['some_future_tool', {}, '执行工具操作未成功'],
  ] as const)('failed category matrix: %s', (name, args, expected) => {
    expect(humanizeToolStep(name, args, zh, undefined, 'failed')).toBe(expected);
  });

  it('interrupted 连接器和 MCP 复用同一套意图式', () => {
    expect(humanizeInterruptedToolAction({
      name: 'tmeetMeetingCreate',
      arguments: {},
      stepLabel: 'tmeetMeetingCreate',
    }, zh)).toBe('创建会议');
    expect(humanizeInterruptedToolAction({
      name: 'mcp__github__create_issue',
      arguments: {},
    }, zh)).toBe('通过 github 创建内容');
  });
});

// 模型自写的 shortDescription 语种不受控（工具 schema 的示例本身就是英文），
// 中文界面上原样上屏会被 CSS 截成半句英文。语种不一致时必须退回本地化模板。
describe('humanizeToolStep — shortDescription 语种不符时退回模板', () => {
  it('中文界面拒绝英文 shortDescription，走模板', () => {
    expect(humanizeToolStep('Write', { file_path: 'gear.txt' }, zh, 'Create gear.txt with gear list'))
      .toBe('写入了 gear.txt');
  });

  it('中文界面下未识别的工具退回中文兜底', () => {
    expect(humanizeToolStep('some_future_tool', {}, zh, 'Did something'))
      .toBe('执行了工具操作');
  });

  it('英文界面拒绝中文 shortDescription，走模板', () => {
    expect(humanizeToolStep('Write', { file_path: 'gear.txt' }, en, '创建 gear.txt 齿轮清单'))
      .toBe('Wrote gear.txt');
  });

  it('中英混排只要带汉字就算中文界面可用', () => {
    expect(humanizeToolStep('Write', { file_path: 'gear.txt' }, zh, '打开 Baidu 搜索 Claude'))
      .toBe('打开 Baidu 搜索 Claude');
  });
});

describe('humanizeToolStep — en locale parity', () => {
  it('renders the same categories in English', () => {
    expect(humanizeToolStep('Read', { file_path: 'report.md' }, en)).toBe('Read report.md');
    expect(humanizeToolStep('Bash', { command: 'ls src/' }, en)).toBe('Ran command ls src/');
    expect(humanizeToolStep('unknown_tool', {}, en)).toBe('Ran a tool operation');
    expect(humanizeToolStep('TaskManager', {}, en)).toBe('Updated tasks');
    expect(humanizeToolStep('mcp__lark__im_v1_message_create', {}, en)).toBe('Sent a message in Lark');
  });

  it('英文界面仍接受英文 shortDescription', () => {
    expect(humanizeToolStep('Bash', { command: 'ls src/' }, en, 'List the source directory'))
      .toBe('List the source directory');
  });
});

describe('humanizeToolStep — 写入动作四态', () => {
  it.each([
    ['pending-approval', '请求写入 notes.md'],
    ['running', '正在写入 notes.md'],
    ['completed', '写入了 notes.md'],
    ['failed', '写入 notes.md 未成功'],
  ] as const)('%s 使用对应动词形态', (status, expected) => {
    expect(humanizeToolStep('Write', { file_path: 'notes.md' }, zh, undefined, status)).toBe(expected);
  });

  it('英文四态与中文状态对齐', () => {
    expect(humanizeToolStep('Write', { file_path: 'notes.md' }, en, undefined, 'pending-approval')).toBe('Request to write notes.md');
    expect(humanizeToolStep('Write', { file_path: 'notes.md' }, en, undefined, 'running')).toBe('Writing notes.md');
    expect(humanizeToolStep('Write', { file_path: 'notes.md' }, en, undefined, 'failed')).toBe('Could not write notes.md');
  });
});

describe('humanizeToolGroupLabel', () => {
  it('aggregates adjacent tool calls into a bucketed overview', () => {
    expect(humanizeToolGroupLabel(['Read', 'Read', 'Bash'], zh))
      .toBe('查看了 2 次内容、运行了 1 条命令');
  });

  it('buckets mcp and subagent tools separately from explored/ran', () => {
    expect(humanizeToolGroupLabel(['mcp__github__create_issue', 'spawn_agent'], zh))
      .toBe('调用了 1 次工具、派发了 1 次代理任务');
  });

  it('TaskManager/todo land in planned bucket — never "使用了 N 次工具"', () => {
    const label = humanizeToolGroupLabel(['TaskManager', 'TaskManager', 'todo_write'], zh);
    expect(label).toBe('更新了 3 次任务');
    expect(label).not.toMatch(/使用了/);
    expect(label).not.toMatch(/TaskManager/i);
  });

  // 反例：TaskManager 不得出现在用户可见主行
  it('anti: TaskManager never appears in user-visible main-line group label', () => {
    const label = humanizeToolGroupLabel(['TaskManager', 'Bash'], zh);
    expect(label).toContain('更新了 1 次任务');
    expect(label).toContain('运行了 1 条命令');
    expect(label).not.toMatch(/TaskManager/i);
    expect(label).not.toMatch(/使用了/);
  });

  // 反例：ToolSearch 不进主流
  it('anti: ToolSearch is excluded from main-stream aggregate label', () => {
    expect(humanizeToolGroupLabel(['ToolSearch'], zh)).toBe('');
    expect(humanizeToolGroupLabel(['ToolSearch', 'ToolSearch'], zh)).toBe('');
    const mixed = humanizeToolGroupLabel(['Read', 'ToolSearch', 'Bash'], zh);
    expect(mixed).toBe('查看了 1 次内容、运行了 1 条命令');
    expect(mixed).not.toMatch(/ToolSearch/i);
    expect(mixed).not.toMatch(/查找了/);
  });

  it('unrecognized tools fall into the neutral "ran N steps" used bucket', () => {
    expect(humanizeToolGroupLabel(['some_future_tool', 'another_mystery'], zh))
      .toBe('执行了 2 个步骤');
  });

  it('todo + askUser split into planned + used buckets', () => {
    expect(humanizeToolGroupLabel(['todo_write', 'AskUserQuestion'], zh))
      .toBe('更新了 1 次任务、执行了 1 个步骤');
  });
});

describe('isInternalStreamTool / getToolFilePath', () => {
  it('marks ToolSearch as internal stream activity', () => {
    expect(isInternalStreamTool('ToolSearch')).toBe(true);
    expect(isInternalStreamTool('Read')).toBe(false);
    expect(isInternalStreamTool('TaskManager')).toBe(false);
  });

  it('extracts full file path for preview routing', () => {
    expect(getToolFilePath('Read', { file_path: '/Users/me/project/docs/report.md' }))
      .toBe('/Users/me/project/docs/report.md');
    expect(getToolFilePath('Bash', { command: 'ls' })).toBeNull();
  });
});
