// ============================================================================
// jevFeatures 单测（N-JEV-DEFAULT-ON）—— 四特性默认开 + 无 key 静默降级
// ----------------------------------------------------------------------------
// 覆盖：每个 flag 的 unset/0/false/1 语义；createProductionJevCall 无 key 时
// 抛 TYPESAFE_KEY_MISSING、计数逐次累加、每特性每进程只 warn 一条；四个站点在
// 无 key 时逐字段回到开关关的结果且 provider 零调用；有 key 时四站点 Jev 路径真实
// 走通；权限分类契约（判官抛错回 ask、规则层 deny 不被 Jev 翻成 allow、出境脱敏
// 在默认开路径仍先行）；getJevStatus 形状与无 key 材料。
// provider 与 logger 全 mock——测试永不触网、永不读真 SecureStorage。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerState = vi.hoisted(() => ({
  route: null as null | { kind: 'official' | 'openrouter' },
  systemOne: vi.fn(),
}));

vi.mock('../../../src/host/model/providers/typesafeProvider', () => ({
  resolveJevRoute: () => providerState.route,
  systemOne: providerState.systemOne,
}));

const loggerWarns = vi.hoisted(() => [] as unknown[][]);

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => { loggerWarns.push(args); },
    error: () => {},
  }),
}));

import {
  createProductionJevCall,
  getJevStatus,
  isJevFeatureOn,
  type JevFeature,
} from '../../../src/host/model/jevFeatures';
import { PermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { scanWithJevInjection } from '../../../src/host/security/jevInjectionScan';
import { applyJevCompaction } from '../../../src/host/context/jevCompaction';
import { AdaptiveRouter } from '../../../src/host/model/adaptiveRouter';
import type { ProjectableMessage } from '../../../src/host/context/projectionEngine';
import type { JevQuestionSpec } from '../../../src/shared/constants/jevQuestions';

const FEATURE_ENV_FLAGS: Record<JevFeature, string> = {
  permissionClassifier: 'CODE_AGENT_PERMISSION_LLM_CLASSIFIER',
  injectionScan: 'CODE_AGENT_JEV_INJECTION_SCAN',
  compaction: 'CODE_AGENT_JEV_COMPACTION',
  router: 'CODE_AGENT_JEV_ROUTER',
};

/** 规则层判 null（fallback ask 桶）的探针命令，与 permissionClassifier.jev.test.ts 同源。 */
const FALLBACK_COMMAND = 'python3 -c "import pptx; print(pptx.__version__)"';
/** 规则层直接 deny 的命令（凭据目录破坏），Jev 永远看不到它。 */
const RULE_DENY_COMMAND = 'cd ~ && 2>&1; rm -rf .ssh/id_rsa';

function classifyBashCommand(classifier: PermissionClassifier, command: string) {
  return classifier.classify('Bash', { command }, { workingDirectory: '/tmp' });
}

function toolTranscript(): ProjectableMessage[] {
  const messages: ProjectableMessage[] = [];
  for (let index = 0; index < 8; index++) {
    messages.push({
      id: `call-${index}`,
      role: 'assistant',
      content: `call ${index}`,
      toolCalls: [{ id: `tool-${index}`, name: 'Read' }],
    });
    messages.push({
      id: `result-${index}`,
      role: 'tool',
      content: `result ${index} ${'x'.repeat(500)}`,
      toolCallId: `tool-${index}`,
    });
  }
  return messages;
}

/** 判官全 approve 的标准四问答案（Bash 档）。 */
function approveAnswers() {
  return {
    risk: { choice: 'read_only', confidence: 0.95 },
    needs_human: { noul: 0.1 },
    touches_secrets: { noul: 0.05 },
    config_or_credential_access: { noul: 0.1 },
    injection: { noul: 0.1 },
    privilege_escalation: { noul: 0.1 },
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  providerState.route = null;
  providerState.systemOne.mockReset();
  loggerWarns.length = 0;
});

// ---------------------------------------------------------------------------
// 开关语义：unset = on；'0'/'false'（trim、大小写不敏感）= off；其余 = on
// ---------------------------------------------------------------------------

describe('isJevFeatureOn 语义（四 flag 逐个）', () => {
  it.each(Object.entries(FEATURE_ENV_FLAGS) as Array<[JevFeature, string]>)(
    '%s（%s）：unset → on；0/false/FALSE → off；1 → on；空白 trim',
    (_feature, flag) => {
      expect(isJevFeatureOn(_feature, {})).toBe(true);
      expect(isJevFeatureOn(_feature, { [flag]: '0' })).toBe(false);
      expect(isJevFeatureOn(_feature, { [flag]: 'false' })).toBe(false);
      expect(isJevFeatureOn(_feature, { [flag]: 'FALSE' })).toBe(false);
      expect(isJevFeatureOn(_feature, { [flag]: ' 0 ' })).toBe(false);
      expect(isJevFeatureOn(_feature, { [flag]: 'False' })).toBe(false);
      expect(isJevFeatureOn(_feature, { [flag]: '1' })).toBe(true);
      expect(isJevFeatureOn(_feature, { [flag]: 'true' })).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// createProductionJevCall：无 key 静默降级 / 有 key 走通
// ---------------------------------------------------------------------------

describe('createProductionJevCall', () => {
  it('无 key：抛 code=TYPESAFE_KEY_MISSING、不触达 systemOne、计数逐次累加、warn 只留一条', async () => {
    const call = createProductionJevCall('router');
    const before = getJevStatus().features.router.degradedCount;
    for (let index = 0; index < 3; index++) {
      await expect(call({}, {}, {})).rejects.toMatchObject({ code: 'TYPESAFE_KEY_MISSING' });
    }
    expect(providerState.systemOne).not.toHaveBeenCalled();
    expect(getJevStatus().features.router.degradedCount).toBe(before + 3);
    const degradeWarns = loggerWarns.filter((args) => String(args[0]).includes('CODE_AGENT_JEV_ROUTER'));
    expect(degradeWarns).toHaveLength(1);
  });

  it('有 key：装载并委托 provider systemOne，透传 state/questions/options', async () => {
    providerState.route = { kind: 'official' };
    providerState.systemOne.mockResolvedValue({ risk: { choice: 'read_only', confidence: 1 } });
    const signal = new AbortController().signal;
    const call = createProductionJevCall('compaction');
    const question: Record<string, JevQuestionSpec> = { q: { type: 'noul', instructions: 'test question' } };
    const answers = await call({ entries: {} }, question, { signal });
    expect(answers).toEqual({ risk: { choice: 'read_only', confidence: 1 } });
    expect(providerState.systemOne).toHaveBeenCalledTimes(1);
    expect(providerState.systemOne).toHaveBeenCalledWith(
      { entries: {} },
      question,
      { signal },
    );
  });
});

// ---------------------------------------------------------------------------
// 无 key 时四站点逐字段回到开关关的结果（provider 零调用 + 降级计数可观测）
// ---------------------------------------------------------------------------

describe('无 key 静默降级：四站点与开关关结果一致', () => {
  it('permissionClassifier：ask 桶保持 ask（rule=fallback），判官零调用', async () => {
    const before = getJevStatus().features.permissionClassifier.degradedCount;
    const classifier = new PermissionClassifier();
    const result = await classifyBashCommand(classifier, FALLBACK_COMMAND);
    expect(result.decision).toBe('ask');
    expect(result.traceStep?.rule).toBe('fallback');
    expect(providerState.systemOne).not.toHaveBeenCalled();
    expect(getJevStatus().features.permissionClassifier.degradedCount).toBe(before + 1);
  });

  it('injectionScan：远端来源照旧 skipped（unavailable），判官零调用', async () => {
    const before = getJevStatus().features.injectionScan.degradedCount;
    const result = await scanWithJevInjection('web_fetch', 'ordinary report');
    expect(result.skipped).toBe(true);
    expect(result.flagged).toBe(false);
    expect(providerState.systemOne).not.toHaveBeenCalled();
    expect(getJevStatus().features.injectionScan.degradedCount).toBe(before + 1);
  });

  it('compaction：transcript 逐字节不变（unavailable），判官零调用', async () => {
    const before = getJevStatus().features.compaction.degradedCount;
    const messages = toolTranscript();
    const snapshot = JSON.stringify(messages);
    const result = await applyJevCompaction(messages);
    expect(result).toMatchObject({ skipped: true, reason: 'unavailable' });
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(providerState.systemOne).not.toHaveBeenCalled();
    expect(getJevStatus().features.compaction.degradedCount).toBe(before + 1);
  });

  it('router：启发式逐字段一致（高风险词也不经规则地板），3 次调用零 fallback warn', async () => {
    const router = new AdaptiveRouter();
    const before = getJevStatus().features.router.degradedCount;
    // 高风险词 + 无 key：降级必须与开关关完全一致（开关关时规则地板整段不生效），
    // 不得混入 high_risk_rule_floor 信号。
    const messages = [{ role: 'user', content: 'delete all cached files under /tmp/scratch' }];
    const heuristic = router.estimateComplexity(messages);
    for (let index = 0; index < 3; index++) {
      const result = await router.estimateComplexityWithJev(messages);
      expect(result).toEqual(heuristic);
    }
    expect(providerState.systemOne).not.toHaveBeenCalled();
    expect(getJevStatus().features.router.degradedCount).toBe(before + 3);
    const fallbackWarns = loggerWarns.filter((args) => String(args[0]).includes('Jev fallback'));
    expect(fallbackWarns).toHaveLength(0);
    const degradeWarns = loggerWarns.filter((args) => String(args[0]).includes('CODE_AGENT_JEV_ROUTER'));
    expect(degradeWarns.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 有 key：四站点 Jev 路径真实走通（provider mock）
// ---------------------------------------------------------------------------

describe('有 key：四站点 Jev 路径走通', () => {
  it('permissionClassifier：ask 桶经判官 approve，且出境 state 先过脱敏', async () => {
    providerState.route = { kind: 'official' };
    providerState.systemOne.mockImplementation(async (state: Record<string, unknown>) => {
      // 台账验收⑤：默认开路径上 guardSensitiveText 必须先行——密钥不得原文出境。
      expect(JSON.stringify(state)).not.toContain('sk-FAKE000111222333');
      expect(JSON.stringify(state)).toContain('***REDACTED***');
      return approveAnswers();
    });
    const classifier = new PermissionClassifier();
    const result = await classifier.classify(
      'Bash',
      { command: `API_KEY=sk-FAKE000111222333444 ${FALLBACK_COMMAND}` },
      { workingDirectory: '/tmp' },
    );
    expect(result.decision).toBe('approve');
    expect(result.traceStep?.rule).toBe('jev_approve');
    expect(providerState.systemOne).toHaveBeenCalledTimes(1);
  });

  it('injectionScan：语义分照常产出（flagged）', async () => {
    providerState.route = { kind: 'openrouter' };
    providerState.systemOne.mockResolvedValue({ injection: { noul: 0.81 }, exfil_request: { noul: 0.12 } });
    const result = await scanWithJevInjection('web_fetch', 'ordinary report');
    expect(result).toEqual({ skipped: false, flagged: true, injection: 0.81, exfilRequest: 0.12 });
    expect(providerState.systemOne).toHaveBeenCalledTimes(1);
  });

  it('compaction：判官参与（不再 unavailable）', async () => {
    providerState.route = { kind: 'official' };
    providerState.systemOne.mockImplementation(async (_state: unknown, questions: Record<string, unknown>) => {
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) answers[key] = { noul: 1 };
      return answers;
    });
    const messages = toolTranscript();
    const result = await applyJevCompaction(messages);
    expect(result.skipped).toBe(false);
    expect(providerState.systemOne).toHaveBeenCalled();
  });

  it('router：jev signals 出现，启发式不再兜底', async () => {
    providerState.route = { kind: 'official' };
    providerState.systemOne.mockResolvedValue({
      intent: { choice: 'coding', confidence: 0.92 },
      complexity: { choice: 'moderate', confidence: 0.91 },
      needs_clarification: { noul: 0 },
      needs_vision: { noul: 0 },
      high_stakes: { noul: 0 },
    });
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'fix the parser bug' }],
    );
    expect(result.level).toBe('moderate');
    expect(result.signals).toContain('jev_intent:coding');
  });
});

// ---------------------------------------------------------------------------
// 权限分类契约：只缩小 ask 桶，不扩大放行，出错回 ask（默认开路径）
// ---------------------------------------------------------------------------

describe('权限分类契约（默认开）', () => {
  it('判官抛错 ⇒ 回 ask（fail-closed），不放行', async () => {
    providerState.route = { kind: 'official' };
    providerState.systemOne.mockRejectedValue(new Error('jev down'));
    const classifier = new PermissionClassifier();
    const result = await classifyBashCommand(classifier, FALLBACK_COMMAND);
    expect(result.decision).toBe('ask');
    expect(result.traceStep?.rule).toBe('fallback');
  });

  it('判官全 approve 也翻不动规则层 deny（Jev 只缩小 ask 桶）', async () => {
    providerState.route = { kind: 'official' };
    providerState.systemOne.mockResolvedValue(approveAnswers());
    const classifier = new PermissionClassifier();
    const result = await classifyBashCommand(classifier, RULE_DENY_COMMAND);
    expect(result.decision).toBe('deny');
    expect(providerState.systemOne).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getJevStatus：形状、effective 推导、无 key 材料
// ---------------------------------------------------------------------------

describe('getJevStatus', () => {
  it('无 key：keyConfigured=false、route=null、四特性 flagOn/effective=false', () => {
    const status = getJevStatus();
    expect(status.keyConfigured).toBe(false);
    expect(status.route).toBe(null);
    expect(Object.keys(status.features).sort()).toEqual(['compaction', 'injectionScan', 'permissionClassifier', 'router']);
    for (const feature of Object.keys(status.features) as JevFeature[]) {
      expect(status.features[feature].flagOn, feature).toBe(true);
      expect(status.features[feature].effective, feature).toBe(false);
      expect(Number.isInteger(status.features[feature].degradedCount), feature).toBe(true);
    }
  });

  it("有 key：keyConfigured=true、route='official'、effective=true", () => {
    providerState.route = { kind: 'official' };
    const status = getJevStatus();
    expect(status.keyConfigured).toBe(true);
    expect(status.route).toBe('official');
    expect(status.features.router.effective).toBe(true);
  });

  it("flag '0'：flagOn=false 且 effective=false（flag 关优先于 key 在）", () => {
    providerState.route = { kind: 'official' };
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '0');
    const status = getJevStatus();
    expect(status.features.router.flagOn).toBe(false);
    expect(status.features.router.effective).toBe(false);
  });

  it('快照永不包含 key 材料', () => {
    providerState.route = { kind: 'openrouter' };
    const serialized = JSON.stringify(getJevStatus());
    expect(serialized).not.toMatch(/apiKey|api_key|sk-|secret/i);
    expect(serialized).toContain('"route":"openrouter"');
  });
});
