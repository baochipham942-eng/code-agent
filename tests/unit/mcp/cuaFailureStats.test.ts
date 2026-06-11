import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyCuaFailure,
  recordCuaFailure,
} from '../../../src/main/mcp/cuaFailureStats';

describe('classifyCuaFailure — 失败六分类（灰度决策数据口径）', () => {
  it('权限缺失', () => {
    expect(classifyCuaFailure('Accessibility permission not granted')).toBe('permission');
    expect(classifyCuaFailure('TCC denied for screen recording')).toBe('permission');
  });

  it('元素定位失败', () => {
    expect(classifyCuaFailure('stale element_index 5, re-snapshot required')).toBe('element');
    expect(classifyCuaFailure('Element not found at index 12')).toBe('element');
  });

  it('无 AX 树（视觉兜底决策的关键信号）', () => {
    expect(classifyCuaFailure('accessibility tree is empty for window')).toBe('no_ax_tree');
    expect(classifyCuaFailure('AX unavailable: app does not expose accessibility')).toBe('no_ax_tree');
  });

  it('超时', () => {
    expect(classifyCuaFailure('Request timed out after 60000ms')).toBe('timeout');
  });

  it('预算超限与锁拒绝（Neo 自产事件）', () => {
    expect(classifyCuaFailure('本次任务的桌面操作轨迹预算已用尽（25 次操控动作上限）')).toBe('budget');
    expect(classifyCuaFailure('另一个会话（s1）正在使用计算机，本次桌面操作已拒绝')).toBe('lock');
  });

  it('兜底 other', () => {
    expect(classifyCuaFailure('something completely unexpected')).toBe('other');
  });
});

describe('recordCuaFailure — JSONL 落盘', () => {
  let dir: string;
  let statsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cua-stats-'));
    statsPath = join(dir, 'cua-failures.jsonl');
    process.env.CODE_AGENT_CUA_STATS_PATH = statsPath;
  });

  afterEach(() => {
    delete process.env.CODE_AGENT_CUA_STATS_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('追加一行含分类的 JSON 记录', async () => {
    await recordCuaFailure('click', 's1', 'stale element_index 3');
    await recordCuaFailure('type_text', 's1', 'Request timed out');
    const lines = readFileSync(statsPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.tool).toBe('click');
    expect(first.category).toBe('element');
    expect(first.sessionId).toBe('s1');
    expect(typeof first.ts).toBe('number');
  });

  it('错误文本截断到 200 字符（防日志膨胀）', async () => {
    await recordCuaFailure('click', 's1', 'x'.repeat(500));
    const rec = JSON.parse(readFileSync(statsPath, 'utf8').trim());
    expect(rec.error.length).toBeLessThanOrEqual(200);
  });

  it('写入失败静默吞掉（统计不能影响主链路）', async () => {
    process.env.CODE_AGENT_CUA_STATS_PATH = '/nonexistent-root-dir/x/y.jsonl';
    await expect(recordCuaFailure('click', 's1', 'err')).resolves.toBeUndefined();
    expect(existsSync(statsPath)).toBe(false);
  });
});
