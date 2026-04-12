// ============================================================================
// P0-5 POC: Shadow Adapter 接入验证
//
// 验收标准：
// 1. buildProtocolContext 把旧 ToolContext 字段映射到新 ProtocolToolContext，
//    缺失字段用安全默认值填充（sessionId → 'shadow-unknown'，abortSignal → fresh）
// 2. buildAlwaysAllowCanUseTool 返回 { allow: true }（避免二次权限弹窗）
// 3. runShadowCompare 在白名单命中时跑 POC tool 并写 jsonl diff
// 4. runShadowCompare 对未命中白名单的 toolName no-op
// 5. diff 记录包含 outputMatch 字段，内容一致时为 true
// 6. runShadowCompare 永不抛（容错：POC handler throw 也吞掉）
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  buildProtocolContext,
  buildAlwaysAllowCanUseTool,
  buildCanUseToolFromLegacy,
  runShadowCompare,
  executePocToolViaProtocol,
} from '../../../src/main/tools/shadowAdapter';
import { resetProtocolRegistry, getProtocolRegistry } from '../../../src/main/tools/protocolRegistry';
import type { ToolContext as LegacyToolContext } from '../../../src/main/tools/types';

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function makeLegacyCtx(workingDir: string): LegacyToolContext {
  return {
    workingDirectory: workingDir,
    requestPermission: async () => true,
  } as unknown as LegacyToolContext;
}

const DIFF_LOG_REL = 'data/debug/tool-shadow-diff.jsonl';

async function readDiffLines(): Promise<Record<string, unknown>[]> {
  const logPath = path.resolve(process.cwd(), DIFF_LOG_REL);
  try {
    const raw = await fs.readFile(logPath, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function truncateDiffLog(): Promise<void> {
  const logPath = path.resolve(process.cwd(), DIFF_LOG_REL);
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, '', 'utf-8');
  } catch {
    // ignore
  }
}

// ----------------------------------------------------------------------------
// tests
// ----------------------------------------------------------------------------

describe('shadowAdapter — buildProtocolContext', () => {
  it('把 workingDirectory / sessionId 映射到新字段', () => {
    const legacy = makeLegacyCtx('/tmp/workdir');
    const ctx = buildProtocolContext({
      sessionId: 'sess-1',
      workingDirectory: '/tmp/workdir',
      legacyCtx: legacy,
    });
    expect(ctx.sessionId).toBe('sess-1');
    expect(ctx.workingDir).toBe('/tmp/workdir');
    expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    expect(ctx.fileCache).toBeDefined();
    expect(typeof ctx.emit).toBe('function');
    expect(typeof ctx.logger.info).toBe('function');
  });

  it('sessionId 缺失时退回 shadow-unknown', () => {
    const legacy = makeLegacyCtx('/tmp/workdir');
    const ctx = buildProtocolContext({
      workingDirectory: '/tmp/workdir',
      legacyCtx: legacy,
    });
    expect(ctx.sessionId).toBe('shadow-unknown');
  });

  it('外部传入的 abortSignal 被保留', () => {
    const ac = new AbortController();
    const legacy = makeLegacyCtx('/tmp/workdir');
    const ctx = buildProtocolContext({
      workingDirectory: '/tmp/workdir',
      legacyCtx: legacy,
      abortSignal: ac.signal,
    });
    expect(ctx.abortSignal).toBe(ac.signal);
  });

  it('P0-5 ctx 扩展字段从 legacy passthrough', () => {
    const fakeHookManager = { triggerXxx: () => {} };
    const fakePlanningService = { read: () => null };
    const fakeModelConfig = { provider: 'claude' };
    const fakeRegistry = { get: () => null };
    const fakeModelCallback = async (p: string) => `echo: ${p}`;
    const modifiedFiles = new Set(['/tmp/a.ts']);

    const legacy = {
      workingDirectory: '/tmp',
      requestPermission: async () => true,
      hookManager: fakeHookManager,
      planningService: fakePlanningService,
      modelConfig: fakeModelConfig,
      modelCallback: fakeModelCallback,
      toolRegistry: fakeRegistry,
      currentToolCallId: 'call_123',
      agentId: 'agent_a',
      agentName: 'Researcher',
      agentRole: 'analyst',
      sessionId: 'sess_xyz',
      modifiedFiles,
      messages: [{ role: 'user', content: 'hi' }],
      todos: [{ id: '1', content: 'do x', status: 'pending' }],
      currentAttachments: [{ type: 'image', path: '/tmp/img.png' }],
    } as unknown as LegacyToolContext;

    const ctx = buildProtocolContext({
      sessionId: 'sess_xyz',
      workingDirectory: '/tmp',
      legacyCtx: legacy,
    });

    // opaque service handles
    expect(ctx.hookManager).toBe(fakeHookManager);
    expect(ctx.planningService).toBe(fakePlanningService);
    expect(ctx.modelConfig).toBe(fakeModelConfig);
    expect(ctx.legacyToolRegistry).toBe(fakeRegistry);

    // 结构化字段
    expect(ctx.modelCallback).toBe(fakeModelCallback);
    expect(ctx.currentToolCallId).toBe('call_123');

    // subagent snapshot
    expect(ctx.subagent).toBeDefined();
    expect(ctx.subagent?.agentId).toBe('agent_a');
    expect(ctx.subagent?.agentName).toBe('Researcher');
    expect(ctx.subagent?.agentRole).toBe('analyst');
    expect(ctx.subagent?.modifiedFiles).toBe(modifiedFiles);
    expect(ctx.subagent?.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(ctx.subagent?.todos).toHaveLength(1);
    expect(ctx.subagent?.attachments).toHaveLength(1);
  });

  it('planMode 从 legacy setPlanMode/isPlanMode 桥接', () => {
    let active = false;
    const legacy = {
      workingDirectory: '/tmp',
      requestPermission: async () => true,
      isPlanMode: () => active,
      setPlanMode: (v: boolean) => { active = v; },
    } as unknown as LegacyToolContext;

    const ctx = buildProtocolContext({
      workingDirectory: '/tmp',
      legacyCtx: legacy,
    });

    expect(ctx.planMode).toBeDefined();
    expect(ctx.planMode!.isActive()).toBe(false);
    ctx.planMode!.enter('test reason');
    expect(active).toBe(true);
    expect(ctx.planMode!.isActive()).toBe(true);
    ctx.planMode!.exit();
    expect(active).toBe(false);
  });

  it('legacy 无 setPlanMode → planMode 为 undefined', () => {
    const legacy = {
      workingDirectory: '/tmp',
      requestPermission: async () => true,
    } as unknown as LegacyToolContext;
    const ctx = buildProtocolContext({
      workingDirectory: '/tmp',
      legacyCtx: legacy,
    });
    expect(ctx.planMode).toBeUndefined();
  });

  it('emit 把 AgentEvent 透传到 legacy emitEvent', () => {
    const captured: Array<{ name: string; data: unknown }> = [];
    const legacy = {
      workingDirectory: '/tmp',
      requestPermission: async () => true,
      emitEvent: (name: string, data: unknown) => {
        captured.push({ name, data });
      },
    } as unknown as LegacyToolContext;
    const ctx = buildProtocolContext({
      workingDirectory: '/tmp',
      legacyCtx: legacy,
    });
    ctx.emit({ type: 'tool_use_started', toolName: 'X' } as never);
    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe('tool_use_started');
  });
});

describe('shadowAdapter — buildAlwaysAllowCanUseTool', () => {
  it('返回的 canUseTool 对任意输入都 allow: true', async () => {
    const canUseTool = buildAlwaysAllowCanUseTool();
    const r1 = await canUseTool('ReadPoc', { file_path: '/tmp/x' });
    const r2 = await canUseTool('BashPoc', { command: 'rm -rf /' });
    expect(r1).toEqual({ allow: true });
    expect(r2).toEqual({ allow: true });
  });
});

describe('shadowAdapter — buildCanUseToolFromLegacy', () => {
  it('legacy requestPermission 返回 true → allow: true', async () => {
    const ctx = {
      workingDirectory: '/tmp',
      requestPermission: async () => true,
    } as unknown as LegacyToolContext;
    const canUseTool = buildCanUseToolFromLegacy(ctx, 'ReadPoc');
    const r = await canUseTool('ReadPoc', { file_path: '/tmp/x' });
    expect(r).toEqual({ allow: true });
  });

  it('legacy requestPermission 返回 false → allow: false', async () => {
    const ctx = {
      workingDirectory: '/tmp',
      requestPermission: async () => false,
    } as unknown as LegacyToolContext;
    const canUseTool = buildCanUseToolFromLegacy(ctx, 'BashPoc');
    const r = await canUseTool('BashPoc', { command: 'echo' });
    expect(r.allow).toBe(false);
  });

  it('input 含 url → type=network', async () => {
    let captured: { type?: string } | null = null;
    const ctx = {
      workingDirectory: '/tmp',
      requestPermission: async (req: { type: string }) => {
        captured = req;
        return true;
      },
    } as unknown as LegacyToolContext;
    const canUseTool = buildCanUseToolFromLegacy(ctx, 'WebFetchPoc');
    await canUseTool('WebFetchPoc', { url: 'https://example.com' });
    expect(captured!.type).toBe('network');
  });

  it('legacy requestPermission 抛异常 → allow: false', async () => {
    const ctx = {
      workingDirectory: '/tmp',
      requestPermission: async () => {
        throw new Error('boom');
      },
    } as unknown as LegacyToolContext;
    const canUseTool = buildCanUseToolFromLegacy(ctx, 'X');
    const r = await canUseTool('X', {});
    expect(r.allow).toBe(false);
    if (r.allow === false) expect(r.reason).toContain('boom');
  });
});

describe('shadowAdapter — executePocToolViaProtocol (B 阶段 dispatch)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'poc-dispatch-'));
  });

  afterEach(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {
      // ignore
    }
  });

  it('调用 ReadPoc 返回结构化 output 包到 ToolExecutionResult.result', async () => {
    const testFile = path.join(tempDir, 'a.txt');
    await fs.writeFile(testFile, 'hello\nworld\n');

    const result = await executePocToolViaProtocol({
      toolName: 'ReadPoc',
      params: { file_path: testFile },
      workingDirectory: tempDir,
      requestPermission: async () => true,
    });

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.output).toBeTypeOf('string'); // 会被 JSON.stringify
  });

  it('未注册的 tool → success=false', async () => {
    const result = await executePocToolViaProtocol({
      toolName: 'NotARealPocTool',
      params: {},
      workingDirectory: tempDir,
      requestPermission: async () => true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not registered');
  });

  it('canUseTool 拒绝 → success=false 带 PERMISSION_DENIED metadata', async () => {
    const result = await executePocToolViaProtocol({
      toolName: 'ReadPoc',
      params: { file_path: '/tmp/whatever' },
      workingDirectory: tempDir,
      requestPermission: async () => false,
    });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PERMISSION_DENIED');
  });
});

describe('shadowAdapter — runShadowCompare', () => {
  let tempDir: string;

  beforeEach(async () => {
    resetProtocolRegistry();
    getProtocolRegistry(); // 触发 POC 注册
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-test-'));
    await truncateDiffLog();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('非白名单 toolName 立即 no-op，不写日志', async () => {
    await runShadowCompare({
      toolName: 'NotAWhitelistedTool',
      params: {},
      legacyResult: { success: true, result: 'ok' },
      legacyCtx: makeLegacyCtx(tempDir),
      workingDirectory: tempDir,
    });
    const lines = await readDiffLines();
    expect(lines).toEqual([]);
  });

  it('Read 白名单命中时 shadow 跑 ReadPoc 并写 diff', async () => {
    const testFile = path.join(tempDir, 'sample.txt');
    const content = 'line1\nline2\nline3\n';
    await fs.writeFile(testFile, content, 'utf-8');

    await runShadowCompare({
      toolName: 'Read',
      params: { file_path: testFile },
      legacyResult: {
        success: true,
        result: { content, lineCount: 3 } as unknown as string,
      },
      legacyCtx: makeLegacyCtx(tempDir),
      workingDirectory: tempDir,
      sessionId: 'sess-shadow',
    });

    const lines = await readDiffLines();
    expect(lines.length).toBe(1);
    const record = lines[0];
    expect(record.toolName).toBe('Read');
    expect(record.shadowName).toBe('ReadPoc');
    expect(record.shadowOk).toBe(true);
    expect(record.legacySuccess).toBe(true);
    expect(typeof record.outputMatch).toBe('boolean');
  });

  it('legacy 和 shadow 输出一致时 outputMatch=true', async () => {
    const testFile = path.join(tempDir, 'match.txt');
    // POC ReadPoc 的 content 输出 = split('\n').slice(...).join('\n')，
    // 对 'alpha\nbeta\n' 会产出 'alpha\nbeta\n'（trailing '' 被保留）
    await fs.writeFile(testFile, 'alpha\nbeta\n', 'utf-8');

    await runShadowCompare({
      toolName: 'Read',
      params: { file_path: testFile },
      legacyResult: {
        success: true,
        result: { content: 'alpha\nbeta\n' } as unknown as string,
      },
      legacyCtx: makeLegacyCtx(tempDir),
      workingDirectory: tempDir,
    });

    const lines = await readDiffLines();
    const record = lines[lines.length - 1];
    expect(record.outputMatch).toBe(true);
  });

  it('POC 执行失败时 diff 记录 shadowError 并不抛异常', async () => {
    await runShadowCompare({
      toolName: 'Read',
      params: { file_path: '/nonexistent/path/to/file.txt' },
      legacyResult: { success: false, error: 'ENOENT' },
      legacyCtx: makeLegacyCtx(tempDir),
      workingDirectory: tempDir,
    });

    const lines = await readDiffLines();
    expect(lines.length).toBe(1);
    const record = lines[0];
    expect(record.shadowOk).toBe(false);
    expect(typeof record.shadowError).toBe('string');
  });

  it('WebSearch 白名单映射到 WebSearchPoc', async () => {
    // 清空 env 让 POC 返回 API_KEY_MISSING
    const savedPerp = process.env.PERPLEXITY_API_KEY;
    const savedExa = process.env.EXA_API_KEY;
    const savedTav = process.env.TAVILY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.TAVILY_API_KEY;

    try {
      await runShadowCompare({
        toolName: 'WebSearch',
        params: { query: 'test' },
        legacyResult: { success: true, result: 'mocked legacy result' },
        legacyCtx: makeLegacyCtx(tempDir),
        workingDirectory: tempDir,
      });

      const lines = await readDiffLines();
      expect(lines.length).toBe(1);
      expect(lines[0].shadowName).toBe('WebSearchPoc');
    } finally {
      if (savedPerp !== undefined) process.env.PERPLEXITY_API_KEY = savedPerp;
      if (savedExa !== undefined) process.env.EXA_API_KEY = savedExa;
      if (savedTav !== undefined) process.env.TAVILY_API_KEY = savedTav;
    }
  });
});
