// ============================================================================
// Role Write-Back Tests — write gate / 判断解析 / 层路由 / 履历
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const mockQuickTask = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../../src/host/model/quickModel', () => ({
  quickTask: mockQuickTask,
}));

import {
  applyWriteGate,
  runRoleWriteBack,
  type WriteBackCandidate,
} from '../../../../src/host/services/roleAssets/roleWriteBack';
import {
  ensureRoleAssetDirs,
  listScopedMemories,
  loadRoleHistory,
  writeScopedMemory,
} from '../../../../src/host/services/roleAssets/roleAssetService';

function candidate(overrides: Partial<WriteBackCandidate> = {}): WriteBackCandidate {
  return {
    layer: 'role',
    filename: 'test-memory.md',
    name: '测试记忆',
    description: '一条测试记忆',
    content: '用户的业务口径：GMV 不含退款，统计周期是自然周。',
    ...overrides,
  };
}

describe('applyWriteGate (设计 §5.1)', () => {
  it('passes valid candidates', () => {
    const { accepted, rejected } = applyWriteGate([candidate()], new Set());
    expect(accepted.length).toBe(1);
    expect(rejected.length).toBe(0);
  });

  it('enforces quota of 3 entries (配额闸)', () => {
    const candidates = [1, 2, 3, 4, 5].map((i) =>
      candidate({ filename: `mem-${i}.md`, content: `有效的知识内容第 ${i} 条，足够长不被质量闸拦截。` }),
    );
    const { accepted, rejected } = applyWriteGate(candidates, new Set());
    expect(accepted.length).toBe(3);
    expect(rejected.length).toBe(2);
  });

  it('rejects log-like content (质量闸：拒流水账)', () => {
    const { accepted, rejected } = applyWriteGate(
      [candidate({ content: '完成了用户的调研任务' })],
      new Set(),
    );
    expect(accepted.length).toBe(0);
    expect(rejected.length).toBe(1);
  });

  it('rejects too-short content', () => {
    const { accepted } = applyWriteGate([candidate({ content: '短' })], new Set());
    expect(accepted.length).toBe(0);
  });

  it('truncates over-long content instead of rejecting', () => {
    const { accepted } = applyWriteGate(
      [candidate({ content: 'x'.repeat(10_000) })],
      new Set(),
    );
    expect(accepted.length).toBe(1);
    expect(accepted[0].content.length).toBeLessThan(5_000);
    expect(accepted[0].content).toContain('truncated by write gate');
  });

  it('dedupes within batch by filename (批内去重闸)', () => {
    const { accepted, rejected } = applyWriteGate(
      [
        candidate({ filename: 'same.md', content: '第一条有效知识内容，足够长。' }),
        candidate({ filename: 'same.md', content: '第二条有效知识内容，足够长。' }),
      ],
      new Set(),
    );
    expect(accepted.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it('allows updating existing memories (同名 = 更新而非新建)', () => {
    const { accepted } = applyWriteGate(
      [candidate({ filename: 'existing.md' })],
      new Set(['existing.md']),
    );
    expect(accepted.length).toBe(1);
  });
});

describe('runRoleWriteBack', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-wb-'));
    mockQuickTask.mockReset();
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  it('skips non-persistent roles without calling the model (零成本)', async () => {
    const result = await runRoleWriteBack({
      roleId: '普通agent',
      taskPrompt: 'task',
      finalOutput: 'output',
    });
    expect(result.executed).toBe(false);
    expect(mockQuickTask).not.toHaveBeenCalled();
  });

  it('writes role-layer memories from judgment and appends history', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        memories: [
          {
            layer: 'role',
            filename: 'user-business-glossary.md',
            name: '业务术语',
            description: '用户的 GMV 口径',
            content: '用户业务中 GMV 指标不含退款，统计周期为自然周。',
          },
        ],
        historySummary: '完成 Q2 增长数据调研',
      }),
    });

    const result = await runRoleWriteBack({
      roleId: '研究员',
      workspacePath: '/tmp/ws-1',
      taskPrompt: '调研 Q2 增长数据',
      finalOutput: '调研完成，GMV 增长 20%...',
      artifacts: [{ label: 'Q2 调研报告', ref: 'artifact://doc/q2-report' }],
    });

    expect(result.executed).toBe(true);
    expect(result.written).toBe(1);
    expect(result.historyAppended).toBe(true);

    const memories = await listScopedMemories({ scope: 'role', roleId: '研究员' });
    expect(memories.length).toBe(1);
    expect(memories[0].filename).toBe('user-business-glossary.md');
    expect(memories[0].content).toContain('不含退款');

    const history = await loadRoleHistory('研究员');
    expect(history.length).toBe(1);
    expect(history[0]).toContain('Q2 调研报告');
    expect(history[0]).toContain('artifact://doc/q2-report');
  });

  it('routes project-layer memories to workspace dir (层路由)', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        memories: [
          {
            layer: 'project',
            filename: 'project-template.md',
            name: '项目模板',
            description: '这个项目的周报模板位置',
            content: '该项目的周报模板在 docs/templates/weekly.md，按部门分三个 sheet。',
          },
        ],
        historySummary: '产出周报',
      }),
    });

    await runRoleWriteBack({
      roleId: '研究员',
      workspacePath: '/tmp/ws-project-route',
      taskPrompt: '写周报',
      finalOutput: 'done',
    });

    const projectMemories = await listScopedMemories({
      scope: 'project',
      workspacePath: '/tmp/ws-project-route',
    });
    expect(projectMemories.length).toBe(1);
    expect(projectMemories[0].filename).toBe('project-template.md');

    // 角色层不应有这条
    const roleMemories = await listScopedMemories({ scope: 'role', roleId: '研究员' });
    expect(roleMemories.length).toBe(0);
  });

  it('routes global-layer memories to light memory dir', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        memories: [
          {
            layer: 'global',
            filename: 'user-preference.md',
            name: '用户偏好',
            description: '用户讨厌套话，回复直接给结论',
            content: '用户是资深 PM，讨厌套话和模板化回复，永远先给结论再给依据。',
          },
        ],
        historySummary: 'x',
      }),
    });

    await runRoleWriteBack({
      roleId: '研究员',
      taskPrompt: 'x',
      finalOutput: 'y',
    });

    const globalMemPath = path.join(mockConfigDir.dir, 'memory', 'user-preference.md');
    const content = await fs.readFile(globalMemPath, 'utf-8');
    expect(content).toContain('讨厌套话');

    const indexContent = await fs.readFile(path.join(mockConfigDir.dir, 'memory', 'INDEX.md'), 'utf-8');
    expect(indexContent).toContain('[user-preference.md]');
  });

  it('degrades gracefully when quick model fails (只记履历不写记忆)', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({ success: false, error: 'model unavailable' });

    const result = await runRoleWriteBack({
      roleId: '研究员',
      taskPrompt: '调研任务',
      finalOutput: 'output',
    });

    expect(result.executed).toBe(true);
    expect(result.written).toBe(0);
    expect(result.historyAppended).toBe(true);

    const history = await loadRoleHistory('研究员');
    expect(history.length).toBe(1);
  });

  it('handles unparsable judgment output', async () => {
    await ensureRoleAssetDirs('研究员');
    mockQuickTask.mockResolvedValue({ success: true, content: 'not json at all' });

    const result = await runRoleWriteBack({
      roleId: '研究员',
      taskPrompt: 'x',
      finalOutput: 'y',
    });
    expect(result.executed).toBe(true);
    expect(result.written).toBe(0);
  });

  it('feeds existing memories to judge for dedup (去重闸输入)', async () => {
    await ensureRoleAssetDirs('研究员');
    await writeScopedMemory(
      { scope: 'role', roleId: '研究员' },
      { filename: 'existing-knowledge.md', name: 'E', description: '已有的知识', content: '...' },
    );
    mockQuickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({ memories: [], historySummary: 'x' }),
    });

    await runRoleWriteBack({ roleId: '研究员', taskPrompt: 'x', finalOutput: 'y' });

    const judgePrompt = mockQuickTask.mock.calls[0][0] as string;
    expect(judgePrompt).toContain('existing-knowledge.md');
    expect(judgePrompt).toContain('已有的知识');
  });

  it('serializes concurrent write-backs for the same role (串行队列)', async () => {
    await ensureRoleAssetDirs('研究员');
    let concurrent = 0;
    let maxConcurrent = 0;
    mockQuickTask.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return {
        success: true,
        content: JSON.stringify({ memories: [], historySummary: 'x' }),
      };
    });

    await Promise.all([
      runRoleWriteBack({ roleId: '研究员', taskPrompt: 'a', finalOutput: '1' }),
      runRoleWriteBack({ roleId: '研究员', taskPrompt: 'b', finalOutput: '2' }),
      runRoleWriteBack({ roleId: '研究员', taskPrompt: 'c', finalOutput: '3' }),
    ]);

    expect(maxConcurrent).toBe(1);
    const history = await loadRoleHistory('研究员');
    expect(history.length).toBe(3);
  });
});
