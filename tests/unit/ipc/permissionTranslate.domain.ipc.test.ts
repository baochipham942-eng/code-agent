// ============================================================================
// permissionTranslate 域派发特征测试（N-PERM-NL-RULES-K1）
// ----------------------------------------------------------------------------
// translate 的参数解析与错误契约（INVALID_INPUT / TRANSLATE_PARSE_ERROR /
// MODEL_UNAVAILABLE）、工具目录与已存规则的注入形状、未知 action 兜底；
// 全程盯住 updateSettings 零调用——本域只读，绝不写设置。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import { NL_RULE_TEXT, type PermissionTranslateResult } from '../../../src/shared/permissionRuleTranslate';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>(),
  translate: vi.fn(),
  updateSettings: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  mcpClient: {
    getTools: vi.fn(() => [{ serverName: 'github', name: 'create_issue' }]),
  },
}));

vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: (ch: string, fn: (event: unknown, request: IPCRequest) => Promise<IPCResponse>) => h.handlers.set(ch, fn) },
}));
vi.mock('../../../src/host/permissions/permissionRuleTranslator', () => ({
  translatePermissionSentence: (...args: unknown[]) => h.translate(...args),
  PermissionTranslateParseError: class PermissionTranslateParseError extends Error {},
}));
vi.mock('../../../src/host/tools/knownToolNames', () => ({
  getKnownToolNames: () => new Set(['Bash', 'Read', 'Write', 'mail_send']),
}));
vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => h.mcpClient,
}));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => ({ permissions: { deny: ['Bash(rm -rf /)'], ask: [], allow: ['Read'] } }),
    updateSettings: (...args: unknown[]) => h.updateSettings(...args),
  }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: h.logWarn, error: h.logError, debug: vi.fn() }),
}));

import { registerPermissionTranslateHandlers } from '../../../src/host/ipc/permissionTranslate.ipc';

const call = (action: string, payload?: unknown) =>
  h.handlers.get(IPC_DOMAINS.PERMISSION_TRANSLATE)!(null, { action, payload } as IPCRequest);

const okResult: PermissionTranslateResult = {
  status: 'ok',
  rule: 'Bash(rm *)',
  behavior: 'ask',
  restatement: '用终端运行 rm 开头的命令时 → 先问你',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.translate.mockResolvedValue(okResult);
  registerPermissionTranslateHandlers();
});

describe('permissionTranslate 域 dispatch', () => {
  it('translate：透传翻译结果，注入真实工具目录（含 MCP 全名）与已存规则', async () => {
    const response = await call('translate', { sentence: '删文件之前先问我' });
    expect(response).toEqual({ success: true, data: okResult });
    expect(h.translate).toHaveBeenCalledTimes(1);
    const [sentence, options] = h.translate.mock.calls[0] as [
      string,
      { toolCatalog: string[]; existingRules: { deny?: string[]; ask?: string[]; allow?: string[] } },
    ];
    expect(sentence).toBe('删文件之前先问我');
    expect(options.toolCatalog).toEqual(
      expect.arrayContaining(['Bash', 'mail_send', 'mcp__github__create_issue']),
    );
    expect(options.existingRules).toEqual({ deny: ['Bash(rm -rf /)'], ask: [], allow: ['Read'] });
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it('空句子 → INVALID_INPUT，不碰模型也不写设置', async () => {
    expect(await call('translate', { sentence: '   ' })).toEqual({
      success: false,
      error: { code: 'INVALID_INPUT', message: '请先输入一句规则描述' },
    });
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it('非对象 payload → INVALID_INPUT', async () => {
    expect(await call('translate', '删文件之前先问我')).toEqual({
      success: false,
      error: { code: 'INVALID_INPUT', message: '请先输入一句规则描述' },
    });
  });

  it('JSON 解析故障 → TRANSLATE_PARSE_ERROR + 固定话术', async () => {
    const { PermissionTranslateParseError } = await import('../../../src/host/permissions/permissionRuleTranslator');
    h.translate.mockRejectedValue(new PermissionTranslateParseError());
    expect(await call('translate', { sentence: '删文件之前先问我' })).toEqual({
      success: false,
      error: { code: 'TRANSLATE_PARSE_ERROR', message: NL_RULE_TEXT.parseError },
    });
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it('模型通道故障 → MODEL_UNAVAILABLE + 「现在没法翻译」话术（已存规则不受影响）', async () => {
    h.translate.mockRejectedValue(new Error('no api key'));
    expect(await call('translate', { sentence: '删文件之前先问我' })).toEqual({
      success: false,
      error: { code: 'MODEL_UNAVAILABLE', message: NL_RULE_TEXT.modelUnavailable },
    });
    expect(h.logError).toHaveBeenCalled();
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it('未知 action → INVALID_ACTION 兜底', async () => {
    const response = await call('explain');
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('INVALID_ACTION');
  });

  it('MCP 枚举抛错不拦翻译：目录退化为已知工具全集并留 warn', async () => {
    const { getMCPClient } = await import('../../../src/host/mcp/mcpClient');
    vi.spyOn(getMCPClient(), 'getTools').mockImplementation(() => {
      throw new Error('mcp down');
    });
    const response = await call('translate', { sentence: '删文件之前先问我' });
    expect(response.success).toBe(true);
    expect(h.logWarn).toHaveBeenCalled();
    const [, options] = h.translate.mock.calls[0] as [string, { toolCatalog: string[] }];
    expect(options.toolCatalog).toContain('Bash');
  });
});
