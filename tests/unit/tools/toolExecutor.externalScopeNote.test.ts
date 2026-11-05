import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

// standing grant 命中开关（N-FIX-PARKED-BANNER-STALE-AFTER-RESOLVE 验收④）：默认关，
// 保持既有用例「不命中 → 照旧询问」的行为；需要命中的用例置 true。
const standingGrantState = vi.hoisted(() => ({ hit: false }));

vi.mock('../../../src/host/services/sessionAutomation/sessionAutomationService', () => ({
  getSessionAutomationService: () => ({
    matchStandingGrant: () => standingGrantState.hit,
    mintStandingGrant: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
    shouldConfirm: () => false,
  }),
}));

vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { AgentEventSchema } from '../../../src/shared/contract/agentEventSchemas';

// ============================================================================
// N-APPROVAL-EXTERNAL-SCOPENOTE —— 交互审批卡「离开本机」作用域打标
//   host：external 工具（IM 出站发送 / native 邮件）的 PermissionRequest 带
//         riskClass:'external'；非 external（IM 只读 / web_fetch）属性缺省（≠ null）。
//   schema：permission_request 事件解析后保留 riskClass（不被 zod 剥掉）。
// 只打标不改裁决：见 toolExecutor.ts ask 位点的单行赋值。
// ============================================================================

describe('ToolExecutor EXTERNAL 审批卡作用域打标', () => {
  const definitions = new Map([
    ['mcp__feishu__im_v1_message_create', {
      name: 'mcp__feishu__im_v1_message_create',
      description: 'feishu im send test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'network',
    }],
    ['mail_send', {
      name: 'mail_send',
      description: 'send email test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'write',
    }],
    ['mcp__feishu__im_chat_list', {
      name: 'mcp__feishu__im_chat_list',
      description: 'feishu im read test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'network',
    }],
    ['web_fetch', {
      name: 'web_fetch',
      description: 'web fetch test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'network',
    }],
  ]);

  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => definitions.get(name));
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
    standingGrantState.hit = false;
  });

  async function askFor(toolName: string, params: Record<string, unknown>): Promise<PermissionRequestData> {
    const requestPermission = vi.fn(async (_request: unknown) => false);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
      forcePermissionHandler: true,
    });
    executor.setAuditEnabled(false);
    await executor.execute(toolName, params, { sessionId: 's1' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    return requestPermission.mock.calls[0][0] as PermissionRequestData;
  }

  it('mcp__feishu__im_v1_message_create 携带 riskClass=external 与授权 target', async () => {
    const request = await askFor('mcp__feishu__im_v1_message_create', {
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_C1', msg_type: 'text' },
    });
    expect(request.riskClass).toBe('external');
    expect(request.details.standingGrantTarget).toBe('chat_id:oc_C1');
  });

  it('mail_send 携带 riskClass=external（native 出站邮件）', async () => {
    const request = await askFor('mail_send', { subject: 'hi', to: ['a@b.com'] });
    expect(request.riskClass).toBe('external');
    expect(request.details.standingGrantTarget).toBe('a@b.com');
  });

  it('mcp__feishu__im_chat_list 不携带 riskClass（读列表不是出站发送）', async () => {
    const request = await askFor('mcp__feishu__im_chat_list', {});
    expect(request).not.toHaveProperty('riskClass');
  });

  it('web_fetch 不携带 riskClass（联网读不是 external）', async () => {
    const request = await askFor('web_fetch', { url: 'https://example.com' });
    expect(request).not.toHaveProperty('riskClass');
  });

  it('standing grant 命中时不发起审批（已授权即不打扰，也就不可能弹 needs-input 通知）', async () => {
    standingGrantState.hit = true;
    const requestPermission = vi.fn(async (_request: unknown) => false);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
      forcePermissionHandler: true,
    });
    executor.setAuditEnabled(false);
    // 参数与前面「会走到询问」的 mail_send 用例不同：同参第二次会被 prior-denial
    // 的 launderRetryForcesAsk 拦住不走授权消费，测的就不再是 standing grant 了。
    await executor.execute('mail_send', { subject: 'granted', to: ['c@x.com'] }, { sessionId: 's1' });
    // needs-input 通知的两个发送口（parkApproval / permission_request 落库）都在
    // requestPermission 之后；这里连问都不问，自然一条 needs-input 都不会有。
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });
});

describe('permission_request 事件 schema 保留 riskClass', () => {
  it('riskClass=external 解析后原样保留（不被 zod 剥掉）', () => {
    const event = {
      type: 'permission_request',
      data: {
        id: 'permission-external-1',
        type: 'network',
        tool: 'mcp__feishu__im_v1_message_create',
        riskClass: 'external',
        details: { standingGrantTarget: 'chat_id:oc_C1' },
        timestamp: 1,
      },
    };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });
});
