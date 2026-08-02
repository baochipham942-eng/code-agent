import { describe, expect, it } from 'vitest';
import { humanizeToolStep, humanizeToolGroupLabel } from '../../../src/renderer/utils/humanizeToolStep';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

describe('humanizeToolStep — per-category snapshots (zh)', () => {
  it('read: file path shortened', () => {
    expect(humanizeToolStep('Read', { file_path: '/Users/me/project/docs/报告.md' }, zh))
      .toBe('读取了 .../docs/报告.md');
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
      .toBe('查看了 .../src/renderer 目录');
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
      .toBe('调用了 github 的 create_issue');
  });

  it('mcp: legacy single-underscore naming', () => {
    expect(humanizeToolStep('mcp_exa_search', {}, zh)).toBe('调用了 exa 的 search');
  });

  it('mcp channel: lark message send', () => {
    expect(humanizeToolStep('mcp__lark__im_v1_message_create', {}, zh))
      .toBe('在飞书发了一条消息');
  });

  it('mcp channel: non-messaging lark tool stays generic', () => {
    expect(humanizeToolStep('mcp__lark__calendar_v4_event_list', {}, zh))
      .toBe('调用了 lark 的 calendar_v4_event_list');
  });

  it('subagent spawn: with description', () => {
    expect(humanizeToolStep('spawn_agent', { description: '核对发版清单' }, zh))
      .toBe('启动了子任务 — 核对发版清单');
  });

  it('subagent spawn: fallback with no description', () => {
    expect(humanizeToolStep('Task', {}, zh)).toBe('启动了一个子任务');
  });

  it('subagent message', () => {
    expect(humanizeToolStep('agent_message', {}, zh)).toBe('给子任务发了条消息');
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

  it('skill', () => {
    expect(humanizeToolStep('skill', { skill: 'lark-doc' }, zh)).toBe('执行了技能 lark-doc');
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

  it('unknown tool: fallback names the tool, not raw jargon', () => {
    expect(humanizeToolStep('some_future_tool', {}, zh)).toBe('使用了 some_future_tool');
  });

  it('shortDescription wins over the template when it matches the UI language', () => {
    expect(humanizeToolStep('some_future_tool', {}, zh, '做了一件事')).toBe('做了一件事');
  });
});

// 模型自写的 shortDescription 语种不受控（工具 schema 的示例本身就是英文），
// 中文界面上原样上屏会被 CSS 截成半句英文。语种不一致时必须退回本地化模板。
describe('humanizeToolStep — shortDescription 语种不符时退回模板', () => {
  it('中文界面拒绝英文 shortDescription，走模板', () => {
    expect(humanizeToolStep('Write', { file_path: 'gear.txt' }, zh, 'Create gear.txt with gear list'))
      .toBe('写入了 gear.txt');
  });

  it('中文界面下未识别的工具也退回中文兜底', () => {
    expect(humanizeToolStep('some_future_tool', {}, zh, 'Did something'))
      .toBe('使用了 some_future_tool');
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
    expect(humanizeToolStep('unknown_tool', {}, en)).toBe('Used unknown_tool');
    expect(humanizeToolStep('mcp__lark__im_v1_message_create', {}, en)).toBe('Sent a message in Lark');
  });

  it('英文界面仍接受英文 shortDescription', () => {
    expect(humanizeToolStep('Bash', { command: 'ls src/' }, en, 'List the source directory'))
      .toBe('List the source directory');
  });
});

describe('humanizeToolStep — 失败结果不再输出过去时肯定式', () => {
  // 「写入失败 + 写入了 …」这类同行矛盾：正文改意图式中性表述，结果语义交给状态词。
  it('failed write: intent phrasing instead of past-tense claim', () => {
    expect(humanizeToolStep('Write', { file_path: 'notes.md' }, zh, undefined, true))
      .toBe('写入 notes.md');
  });

  it('failed edit: intent phrasing instead of past-tense claim', () => {
    expect(humanizeToolStep('Edit', { file_path: 'src/index.ts' }, zh, undefined, true))
      .toBe('编辑 src/index.ts');
  });

  it('failed write without path: intent fallback', () => {
    expect(humanizeToolStep('Write', {}, zh, undefined, true)).toBe('写入一个文件');
  });

  it('failed edit without path: intent fallback', () => {
    expect(humanizeToolStep('Edit', {}, zh, undefined, true)).toBe('编辑一个文件');
  });

  it('en parity: failed write/edit use intent phrasing', () => {
    expect(humanizeToolStep('Write', { file_path: 'notes.md' }, en, undefined, true))
      .toBe('Write notes.md');
    expect(humanizeToolStep('Edit', { file_path: 'src/index.ts' }, en, undefined, true))
      .toBe('Edit src/index.ts');
  });

  it('failed=false keeps the past-tense templates (success/in-progress 不回归)', () => {
    expect(humanizeToolStep('Write', { file_path: 'notes.md' }, zh, undefined, false))
      .toBe('写入了 notes.md');
    expect(humanizeToolStep('Edit', { file_path: 'src/index.ts' }, zh, undefined, false))
      .toBe('编辑了 src/index.ts');
  });
});

describe('humanizeToolGroupLabel', () => {
  it('aggregates adjacent tool calls into a bucketed overview', () => {
    expect(humanizeToolGroupLabel(['Read', 'Read', 'Bash'], zh))
      .toBe('查看了 2 次内容、运行了 1 条命令');
  });

  it('buckets mcp and subagent tools separately from explored/ran', () => {
    expect(humanizeToolGroupLabel(['mcp__github__create_issue', 'spawn_agent'], zh))
      .toBe('调用了 1 次工具、派发了 1 次子任务');
  });

  it('falls back unrecognized tools into the "used" bucket', () => {
    expect(humanizeToolGroupLabel(['todo_write', 'AskUserQuestion'], zh))
      .toBe('使用了 2 次工具');
  });
});
