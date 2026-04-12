// ============================================================================
// Protocol Adapter (原 shadowAdapter) 接入验证
//
// 验收标准：
// 1. buildProtocolContext 把旧 ToolContext 字段映射到新 ProtocolToolContext，
//    缺失字段用安全默认值填充（sessionId → 'protocol-unknown'，abortSignal → fresh）
// 2. buildCanUseToolFromLegacy 把 legacy requestPermission 桥接成 protocol CanUseToolFn
// 3. executePocToolViaProtocol 作为 protocol 层唯一执行入口
//
// P0-6 step 3 已移除 runShadowCompare / buildAlwaysAllowCanUseTool（shadow 机制退役）
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  buildProtocolContext,
  buildCanUseToolFromLegacy,
  executePocToolViaProtocol,
} from '../../../src/main/protocol/dispatch/shadowAdapter';
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

// ----------------------------------------------------------------------------
// tests
// ----------------------------------------------------------------------------

describe('protocolAdapter — buildProtocolContext', () => {
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

  it('sessionId 缺失时退回 protocol-unknown', () => {
    const legacy = makeLegacyCtx('/tmp/workdir');
    const ctx = buildProtocolContext({
      workingDirectory: '/tmp/workdir',
      legacyCtx: legacy,
    });
    expect(ctx.sessionId).toBe('protocol-unknown');
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

    expect(ctx.hookManager).toBe(fakeHookManager);
    expect(ctx.planningService).toBe(fakePlanningService);
    expect(ctx.modelConfig).toBe(fakeModelConfig);
    // legacyToolRegistry field removed after protocol migration; fakeRegistry no longer passed through
    void fakeRegistry;

    expect(ctx.modelCallback).toBe(fakeModelCallback);
    expect(ctx.currentToolCallId).toBe('call_123');

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

  it('legacy 无 setPlanMode → 返回 no-op planMode controller', () => {
    // Batch B1 (P0-6.3) 把 plan-mode 工具改成 native ToolModule 后，
    // shadowAdapter 在 legacy ctx 没有 isPlanMode/setPlanMode 时也会提供
    // 一个 no-op controller，让 CLI/测试场景下 native 工具能正常跑通。
    const legacy = {
      workingDirectory: '/tmp',
      requestPermission: async () => true,
    } as unknown as LegacyToolContext;
    const ctx = buildProtocolContext({
      workingDirectory: '/tmp',
      legacyCtx: legacy,
    });
    expect(ctx.planMode).toBeDefined();
    expect(ctx.planMode!.isActive()).toBe(false);
    expect(() => ctx.planMode!.enter('noop')).not.toThrow();
    expect(() => ctx.planMode!.exit('noop')).not.toThrow();
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

describe('protocolAdapter — buildCanUseToolFromLegacy', () => {
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

describe('protocolAdapter — executePocToolViaProtocol', () => {
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
    expect(result.output).toBeTypeOf('string');
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
