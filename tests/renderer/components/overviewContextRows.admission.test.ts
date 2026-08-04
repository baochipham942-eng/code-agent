// 概览四模块 · 模块三「上下文」准入规则（spec §1 模块三，2026-08-04 追加拍板）。
// 唯一准入判据 = 本次任务实际发生过调用/读写；「可用/已加载/已连接/被列出」一律不进。
// 内部工件不进；原始内部 ID 禁漏（兜底人话，不兜底 ID）。

import { describe, expect, it } from 'vitest';
import { buildOverviewContextRows } from '../../../src/renderer/components/TaskPanel/TaskWorkspaceOverview';
import type {
  MemoryActivityEvent,
  ToolCapabilityView,
} from '../../../src/renderer/types/runWorkbench';
import type { ContextItem } from '../../../src/renderer/utils/contextBuckets';

const FALLBACKS = { unnamedOutput: '未命名输出', unknownCapability: '未知能力' };

function tool(overrides: Partial<ToolCapabilityView> & { id: string }): ToolCapabilityView {
  return {
    label: overrides.id,
    source: 'builtin',
    callable: true,
    activatedForTurn: true,
    ...overrides,
  } as ToolCapabilityView;
}

function fileItem(path: string, detail: string, extra: Partial<ContextItem> = {}): ContextItem {
  const label = path.split('/').filter(Boolean).pop() || path;
  return { id: `tool:file:${path}:${detail}`, label, detail, bucket: 'files', source: 'tool', path, ...extra };
}

function build(args: {
  tools?: ToolCapabilityView[];
  memoryActivities?: MemoryActivityEvent[];
  contextItems?: ContextItem[];
}) {
  return buildOverviewContextRows({
    tools: args.tools ?? [],
    memoryActivities: args.memoryActivities ?? [],
    contextItems: args.contextItems ?? [],
    fallbacks: FALLBACKS,
  });
}

describe('buildOverviewContextRows 准入规则', () => {
  it('已连接但零调用的 MCP server 不进（仅在能力范围里被列出）', () => {
    const rows = build({
      tools: [tool({ id: 'mcp:filesystem', label: 'filesystem', source: 'mcp' })],
    });
    expect(rows).toEqual([]);
  });

  it('真被调用过的 MCP 按 server 去重成行，显示 server 名而不是每次调用', () => {
    const rows = build({
      tools: [
        tool({ id: 'tool:mcp__filesystem__read_file', label: 'mcp__filesystem__read_file', source: 'mcp' }),
        tool({ id: 'tool:mcp__filesystem__write_file', label: 'mcp__filesystem__write_file', source: 'mcp' }),
        tool({ id: 'tool:mcp__browser__navigate', label: 'mcp__browser__navigate', source: 'mcp' }),
      ],
    });
    const mcpRows = rows.filter((row) => row.kind === 'mcp');
    expect(mcpRows.map((row) => row.label)).toEqual(['browser', 'filesystem']);
  });

  it('调用被拒/失败的 MCP 仍算「发生过」，标黄保留', () => {
    const rows = build({
      tools: [tool({
        id: 'mcp:offline',
        label: 'offline-server',
        source: 'mcp',
        callable: false,
        blockedReason: 'Not connected',
      })],
    });
    expect(rows).toEqual([expect.objectContaining({
      kind: 'mcp',
      label: 'offline-server',
      blocked: true,
      detail: 'Not connected',
    })]);
  });

  it('技能：仅出现在可用列表的不进；真被 Skill 调用成功的进（显示技能名）', () => {
    const rows = build({
      tools: [tool({ id: 'skill:web', label: 'web-development', source: 'skill' })],
      contextItems: [
        { id: 'tool:Skill:web-search', label: 'web-search', detail: 'Skill', bucket: 'rules', source: 'tool' },
      ],
    });
    expect(rows.map((row) => [row.kind, row.label])).toEqual([['skill', 'web-search']]);
  });

  it('激活失败的 Skill 调用不进（失败属会话链路错误卡）', () => {
    const rows = build({
      contextItems: [
        { id: 'tool:Skill:broken', label: 'broken-skill', detail: 'Skill', bucket: 'rules', source: 'tool', failed: true },
      ],
    });
    expect(rows).toEqual([]);
  });

  it('Computer/浏览器能力：真启动过才进', () => {
    const rows = build({
      tools: [
        tool({ id: 'computer:desktop', label: 'desktop', source: 'computer' }),
        tool({ id: 'tool:computer_use', label: 'computer_use', source: 'computer' }),
      ],
    });
    expect(rows.map((row) => row.label)).toEqual(['computer_use']);
  });

  it('文件：内部工件不进（数据目录内部文件 / tool-result blob）', () => {
    const rows = build({
      contextItems: [
        fileItem('/repo/app/pricing-notes.md', 'Read'),
        fileItem('/Users/x/.code-agent-dev/work/out.png', 'Write'),
        fileItem('/Users/x/.code-agent/cache/snapshots/s1.json', 'Read'),
        fileItem('/tmp/tool-results/tool-result-tool-775064011.json', 'Read'),
      ],
    });
    expect(rows.map((row) => row.label)).toEqual(['pricing-notes.md']);
  });

  it('文件：同一文件读又写只出一行，动作小标合并', () => {
    const rows = build({
      contextItems: [
        fileItem('/repo/app/hello.html', 'Read'),
        fileItem('/repo/app/hello.html', 'Write'),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'file', label: 'hello.html', detail: 'Read / Write' });
  });

  it('原始内部 ID 禁漏：tool-result 文件整行排除，能力名解析不出时兜底人话标签', () => {
    const rows = build({
      tools: [
        // label 漏了内部 ID，但 id 能解析出 server 名 → 用 server 名
        tool({ id: 'tool:mcp__browser__fetch', label: 'tool-result-tool-775064011', source: 'mcp' }),
        // 非 MCP 能力 label 是内部 ID、无从解析 → 兜底人话，不兜底 ID
        tool({ id: 'tool:computer_use', label: 'tool-result-tool-775064011', source: 'computer' }),
      ],
      memoryActivities: [{
        runId: 'run-1',
        action: 'used',
        memoryId: 'memory-1',
        filename: '',
        title: 'tool-result-tool-775064011',
        reason: 'x',
      }],
      contextItems: [
        // tool-result blob 是内部工件：整行不进，而不是换兜底名进
        { id: 'f1', label: 'tool-result-tool-775064011', detail: 'Read', bucket: 'files', source: 'tool', path: '/repo/tool-result-tool-775064011' },
      ],
    });
    for (const row of rows) {
      expect(row.label).not.toContain('tool-result');
      expect(row.label).not.toContain('775064011');
    }
    expect(rows.map((row) => [row.kind, row.label])).toEqual([
      ['computer', '未知能力'],
      ['mcp', 'browser'],
      ['memory', '未知能力'],
    ]);
  });

  it('记忆：真实读写的条目带动作小标', () => {
    const rows = build({
      memoryActivities: [{
        runId: 'run-1',
        action: 'updated',
        memoryId: 'memory-1',
        filename: 'MEMORY.md',
        title: '项目记忆',
        reason: 'x',
      }],
    });
    expect(rows).toEqual([expect.objectContaining({
      kind: 'memory',
      label: 'MEMORY.md',
      detail: 'updated',
    })]);
  });

  it('类内按最近使用倒序', () => {
    const rows = build({
      contextItems: [
        fileItem('/repo/a.md', 'Read'),
        fileItem('/repo/b.md', 'Read'),
      ],
    });
    expect(rows.map((row) => row.label)).toEqual(['b.md', 'a.md']);
  });
});
