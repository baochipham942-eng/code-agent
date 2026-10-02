import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
import { handleToolResultBookkeeping } from '../../../../src/host/agent/runtime/toolResultLifecycle';
import type { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { RuntimeControlPort } from '../../../../src/host/agent/runtime/runtimeControl';
import { ControlState } from '../../../../src/host/agent/runtime/controlState';
import { resetInputSanitizer } from '../../../../src/host/security/inputSanitizer';
import { resetCitationService } from '../../../../src/host/services/citation/citationService';
import { setProtocolToolRegistryPort } from '../../../../src/host/tools/protocolToolRegistration';
import type { AgentEvent, ToolCall, ToolResult } from '../../../../src/shared/contract';
import type { ToolExecutionResult } from '../../../../src/host/tools/types';
import type { JevSystemOneCall } from '../../../../src/shared/constants/jevQuestions';
import type { ToolSchema } from '../../../../src/host/protocol/tools';
import { webFetchSchema } from '../../../../src/host/tools/modules/network/webFetch.schema';
import { webSearchSchema } from '../../../../src/host/tools/modules/network/webSearch.schema';

// 判官替身：只摸 systemOne 这一个缝（scanWithJevInjection 的第三参），
// 正则层 / 开关 / 远端判定全走真代码。禁付费模型调用，判官恒 mock。
const jevMock = vi.hoisted(() => ({
  calls: 0,
  behavior: 'flag' as 'flag' | 'throw',
}));

vi.mock('../../../../src/host/security/jevInjectionScan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/security/jevInjectionScan')>();
  const mockJudge: JevSystemOneCall = async () => {
    jevMock.calls += 1;
    if (jevMock.behavior === 'throw') throw new Error('mock judge unavailable');
    return { injection: { noul: 0.99 }, exfil_request: { noul: 0.99 } };
  };
  return {
    ...actual,
    scanWithJevInjection: (source: string, text: string, _systemOne?: JevSystemOneCall, signal?: AbortSignal) =>
      actual.scanWithJevInjection(source, text, mockJudge, signal),
  };
});

// 干净的中文安装步骤文本：正则层零命中，只有语义判官能说话。
const CLEAN_CHINESE_OUTPUT = [
  '安装步骤：',
  '1. 打开官方网站，下载对应系统的安装包。',
  '2. 双击安装包，按向导提示完成安装。',
  '3. 首次启动后在设置里登录账号。',
].join('\n');

function installFakeProtocolToolRegistry(schemas: readonly ToolSchema[]): void {
  const map = new Map(schemas.map((schema) => [schema.name, schema]));
  setProtocolToolRegistryPort({
    register: (schema: ToolSchema) => { map.set(schema.name, schema); },
    unregister: (name: string) => map.delete(name),
    has: (name: string) => map.has(name),
    getSchemas: () => [...map.values()],
    resolve: async () => { throw new Error('unused in this test'); },
  } as never);
}

function makeHarness() {
  const injectedMessages: Array<{ message: string; tag?: string }> = [];
  const events: AgentEvent[] = [];

  const ctx = {
    sessionId: 'session-jev-injection-mock',
    artifact: ArtifactState.forTest(),
    control: ControlState.forTest(),
    needsReinference: false,
    onEvent: (event: AgentEvent) => events.push(event),
    circuitBreaker: {
      recordFailure: () => false,
      recordSuccess: () => undefined,
      generateWarningMessage: () => '',
      generateUserErrorMessage: () => '',
    },
    goalTracker: {
      recordAction: () => undefined,
    },
    nudgeManager: {
      recordVerification: () => undefined,
    },
    antiPatternDetector: {
      trackToolFailure: () => undefined,
      clearToolFailure: () => undefined,
      trackDuplicateCall: () => undefined,
      trackSuccessfulWrite: () => undefined,
    },
  } as unknown as RuntimeContext;

  const contextAssembly = {
    injectSystemMessage: (message: string, tag?: string) => injectedMessages.push({ message, tag }),
    pushPersistentSystemContext: (message: string, tag?: string) => injectedMessages.push({ message, tag }),
  } as unknown as ContextAssembly;

  const runtimeControl = {
    setPlanMode: () => undefined,
    isPlanMode: () => false,
    generateAutoContinuationPrompt: () => '',
  } satisfies RuntimeControlPort;

  async function runTool(toolName: string, output: string): Promise<ToolResult> {
    const toolCall: ToolCall = {
      id: `tc-jev-${events.length}-${toolName}`,
      name: toolName,
      arguments: { query: '安装步骤', url: 'https://example.com/install' },
    };
    const normalizedResult: ToolExecutionResult = { success: true, output };
    const toolResult: ToolResult = {
      toolCallId: toolCall.id,
      success: true,
      output,
      metadata: {},
    };

    await handleToolResultBookkeeping({
      ctx,
      contextAssembly,
      runtimeControl,
      toolCall,
      normalizedResult,
      toolResult,
    });

    return toolResult;
  }

  return { injectedMessages, runTool };
}

describe('toolResultLifecycle Jev 注入第二层（判官 mock）', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // 验收⑤：显式设开关与 key，不依赖默认值。
    vi.stubEnv('CODE_AGENT_JEV_INJECTION_SCAN', '1');
    vi.stubEnv('TYPESAFE_API_KEY', 'test-dummy-key');
    jevMock.calls = 0;
    jevMock.behavior = 'flag';
    resetInputSanitizer();
    resetCitationService();
    installFakeProtocolToolRegistry([webSearchSchema, webFetchSchema]);
  });

  it.each(['WebSearch', 'WebFetch'])(
    '验收②：判官恒返 injection/exfil=0.99，%s 的干净中文结果只告警不拦截',
    async (toolName) => {
      const harness = makeHarness();
      const result = await harness.runTool(toolName, CLEAN_CHINESE_OUTPUT);

      expect(jevMock.calls).toBe(1);
      expect(result.success).toBe(true);
      expect(result.output).toBe(CLEAN_CHINESE_OUTPUT);
      expect(result.output).not.toContain('[BLOCKED]');
      expect(result.metadata?.jevInjectionScan).toEqual({
        skipped: false,
        flagged: true,
        injection: 0.99,
        exfilRequest: 0.99,
      });
      const warnings = harness.injectedMessages.filter((entry) => entry.tag === 'security-warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('[security-warning]');
      expect(warnings[0].message).toContain('Jev semantic scan flagged');
    },
  );

  it('验收③：判官恒抛错 → 原文放行、metadata skipped/unavailable、无 security-warning', async () => {
    jevMock.behavior = 'throw';
    const harness = makeHarness();
    const result = await harness.runTool('WebSearch', CLEAN_CHINESE_OUTPUT);

    expect(jevMock.calls).toBe(1);
    expect(result.success).toBe(true);
    expect(result.output).toBe(CLEAN_CHINESE_OUTPUT);
    expect(result.metadata?.jevInjectionScan).toEqual({
      skipped: true,
      flagged: false,
      injection: 0,
      exfilRequest: 0,
      reason: 'unavailable',
    });
    expect(harness.injectedMessages.filter((entry) => entry.tag === 'security-warning')).toHaveLength(0);
  });
});
