// ============================================================================
// 专家个性化正文 — 读写 + 真进 system prompt
// ============================================================================
// 这批的承重点是「编辑完能被模型看见」，所以断言打在 getAgentPrompt 的产物上，
// 而不是只验文件写没写成。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

// 只改目录来源，其余导出（CONFIG_DIR_NEW 等常量）保持真身——
// agentDefinition 会连带拉起 prompts/registry，它要读 CONFIG_DIR_NEW。
vi.mock('../../../src/host/config/configPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/config/configPaths')>()),
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  readRolePersonalization,
  writeRolePersonalization,
  appendRolePersonalization,
} from '../../../src/host/services/roleAssets/rolePersonalization';
import { ensureRoleAssetDirs } from '../../../src/host/services/roleAssets/roleAssetService';

const ROLE = '数据分析师';
const BASE_PROMPT = '你是一位数据分析师。';

describe('专家个性化正文', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-personalization-'));
    await ensureRoleAssetDirs(ROLE);
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  it('没设置过时两段都是空串，且 prompt 逐字不变', () => {
    expect(readRolePersonalization(ROLE)).toEqual({ userExpectation: '', soul: '' });
    expect(appendRolePersonalization(BASE_PROMPT, ROLE)).toBe(BASE_PROMPT);
  });

  it('写入的期望与准则会拼进 system prompt', () => {
    writeRolePersonalization(ROLE, {
      userExpectation: '把原始数据变成管理层看得懂的结论',
      soul: '结论先行，不确定就直说',
    });
    const prompt = appendRolePersonalization(BASE_PROMPT, ROLE);
    expect(prompt.startsWith(BASE_PROMPT)).toBe(true);
    expect(prompt).toContain('把原始数据变成管理层看得懂的结论');
    expect(prompt).toContain('结论先行，不确定就直说');
  });

  it('只写一段时另一段不受影响，也不会凭空出现在 prompt 里', () => {
    writeRolePersonalization(ROLE, { userExpectation: '只要期望' });
    const prompt = appendRolePersonalization(BASE_PROMPT, ROLE);
    expect(readRolePersonalization(ROLE).soul).toBe('');
    expect(prompt).toContain('只要期望');
    expect(prompt).not.toContain('行为准则');
  });

  it('清空即删文件，prompt 回到逐字原样', () => {
    writeRolePersonalization(ROLE, { userExpectation: '先写点东西', soul: '也写点' });
    writeRolePersonalization(ROLE, { userExpectation: '', soul: '   ' });
    expect(readRolePersonalization(ROLE)).toEqual({ userExpectation: '', soul: '' });
    expect(appendRolePersonalization(BASE_PROMPT, ROLE)).toBe(BASE_PROMPT);
  });

  it('超长正文被截断，不会把整本文档灌进上下文', () => {
    writeRolePersonalization(ROLE, { userExpectation: 'x'.repeat(20000) });
    const prompt = appendRolePersonalization(BASE_PROMPT, ROLE);
    expect(prompt).toContain('已截断');
    expect(prompt.length).toBeLessThan(12000);
  });

  it('非法角色 id 不抛也不读盘', () => {
    expect(readRolePersonalization('../逃逸')).toEqual({ userExpectation: '', soul: '' });
    expect(appendRolePersonalization(BASE_PROMPT, '../逃逸')).toBe(BASE_PROMPT);
    expect(() => writeRolePersonalization('../逃逸', { soul: '坏' })).toThrow();
  });

  it('改文件后立刻生效 —— 不吃 agent 注册表缓存', () => {
    writeRolePersonalization(ROLE, { soul: '第一版' });
    expect(appendRolePersonalization(BASE_PROMPT, ROLE)).toContain('第一版');
    writeRolePersonalization(ROLE, { soul: '第二版' });
    const after = appendRolePersonalization(BASE_PROMPT, ROLE);
    expect(after).toContain('第二版');
    expect(after).not.toContain('第一版');
  });
});

// getAgentPrompt 是 spawnAgent / subagentExecutor / task.ts / initBackgroundServices
// 四条派活路径的唯一出口。断言必须打在它身上：只钉 appendRolePersonalization
// 的话，有人把 getAgentPrompt 改回 `return agent.prompt` 测试照样绿。
describe('getAgentPrompt 注入接线', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-personalization-wire-'));
    await ensureRoleAssetDirs(ROLE);
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  it('派活时读到的 prompt 带着这位专家的期望与准则', async () => {
    const { getAgentPrompt } = await import('../../../src/host/agent/agentDefinition');
    writeRolePersonalization(ROLE, { userExpectation: '要能直接汇报', soul: '别猜数' });
    const agent = { id: ROLE, name: ROLE, prompt: BASE_PROMPT, tools: [] } as unknown as Parameters<typeof getAgentPrompt>[0];
    const prompt = getAgentPrompt(agent);
    expect(prompt).toContain('要能直接汇报');
    expect(prompt).toContain('别猜数');
  });
});
