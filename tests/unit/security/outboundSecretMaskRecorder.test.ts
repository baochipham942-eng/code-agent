// ============================================================================
// OutboundSecretMaskRecorder 单测（N-PROMPT-SECRET-MASK-FU2 ①②）
// ① 回执形状：kind + placeholder + timestamp + 可选 provider/model；JSON 序列化后
//    不含原值（任何片段）；容量 20；没发生替换 / 开关关 → 空。
// ② 回执不出现在日志 / 遥测 / 设置写入里（console、TelemetryService.startSpan、
//    configService.updateSettings 三个 sink 的钉子：谁日后把回执喂进去谁红）。
// 隔离：回执是进程级环形缓冲，每个用例 vi.resetModules() 后动态 import 拿全新模块
// 状态（不为测试加 reset 导出——生产档 knip 不认 test-only export）。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const maskSettingsState = vi.hoisted(() => ({
  settings: {} as Record<string, unknown> | undefined,
  updateCalls: [] as unknown[],
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => maskSettingsState.settings,
    updateSettings: (updates: unknown) => {
      maskSettingsState.updateCalls.push(updates);
      return Promise.resolve();
    },
  }),
}));

const SECRET = 'sk-Abc123defGHI789xyz';
const SECRET_TEXT = `key is ${SECRET} ok`;

function maskOn(): void {
  maskSettingsState.settings = { privacy: { outboundSecretMask: true } };
}

function maskOff(): void {
  maskSettingsState.settings = {};
}

/** 每个 beforeEach 后调：拿一份全新模块状态的三个入口。 */
async function load() {
  const maskModule = await import('../../../src/host/security/outboundSecretMask');
  const recorderModule = await import('../../../src/host/security/outboundSecretMaskRecorder');
  return {
    applyOutboundSecretMask: maskModule.applyOutboundSecretMask,
    getOutboundMaskRecords: recorderModule.getOutboundMaskRecords,
    recordOutboundMaskedRequest: recorderModule.recordOutboundMaskedRequest,
  };
}

describe('outboundSecretMaskRecorder ① 回执形状与红线', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    maskSettingsState.updateCalls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('开关关：不记录（含密钥文本也不记）', async () => {
    const { applyOutboundSecretMask, getOutboundMaskRecords } = await load();
    maskOff();
    const session = applyOutboundSecretMask([{ role: 'user', content: SECRET_TEXT }]);
    expect(session).toBeUndefined();
    expect(getOutboundMaskRecords()).toEqual([]);
  });

  it('开关开但没有可掩内容：不记录', async () => {
    const { applyOutboundSecretMask, getOutboundMaskRecords } = await load();
    maskOn();
    const session = applyOutboundSecretMask([{ role: 'user', content: 'plain text only' }]);
    expect(session).toBeDefined();
    expect(getOutboundMaskRecords()).toEqual([]);
  });

  it('发生替换：回执含 kind + placeholder + timestamp + provider/model，且不含原值', async () => {
    const { applyOutboundSecretMask, getOutboundMaskRecords } = await load();
    maskOn();
    const session = applyOutboundSecretMask(
      [{ role: 'user', content: SECRET_TEXT }],
      undefined,
      { provider: 'deepseek', model: 'deepseek-chat' },
    );
    expect(session).toBeDefined();
    const records = getOutboundMaskRecords();
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.timestamp).toBe(Date.now());
    expect(record.provider).toBe('deepseek');
    expect(record.model).toBe('deepseek-chat');
    expect(record.replacements).toHaveLength(1);
    expect(record.replacements[0].kind).toBe('OPENAI_KEY');
    expect(record.replacements[0].placeholder).toMatch(/^\{\{SECRET_OPENAI_KEY_[0-9a-f]{8}\}\}$/);
    // placeholder 与出云文本里的一致（厂商收到的就是这个形态）
    expect(session!.messages[0].content).toContain(record.replacements[0].placeholder);
    // 红线：序列化后的回执不含原值的任何可辨认片段
    const serialized = JSON.stringify(getOutboundMaskRecords());
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(SECRET.slice(0, 8));
    expect(serialized).not.toContain('Abc123');
  });

  it('同一次请求多个密钥（含同种类重复）：逐条记录', async () => {
    const { applyOutboundSecretMask, getOutboundMaskRecords } = await load();
    maskOn();
    const session = applyOutboundSecretMask([{
      role: 'user',
      content: `a ${SECRET} b ${SECRET} c MY_APP_TOKEN=tok_abcdef123456 end`,
    }]);
    expect(session).toBeDefined();
    const records = getOutboundMaskRecords();
    expect(records).toHaveLength(1);
    expect(records[0].replacements).toHaveLength(3);
    expect(records[0].replacements.filter((r) => r.kind === 'OPENAI_KEY')).toHaveLength(2);
    expect(records[0].replacements.filter((r) => r.kind === 'ENV_SECRET')).toHaveLength(1);
  });

  it('不传 meta：回执只有 timestamp + replacements，无 provider/model 键', async () => {
    const { applyOutboundSecretMask, getOutboundMaskRecords } = await load();
    maskOn();
    applyOutboundSecretMask([{ role: 'user', content: SECRET_TEXT }]);
    const record = getOutboundMaskRecords()[0];
    expect(Object.keys(record).sort()).toEqual(['replacements', 'timestamp']);
  });

  it('容量 20：只留最近 20 次请求，最老的先被挤掉', async () => {
    const { recordOutboundMaskedRequest, getOutboundMaskRecords } = await load();
    for (let i = 0; i < 25; i += 1) {
      recordOutboundMaskedRequest(
        [{ kind: 'KIND_A', placeholder: `{{SECRET_KIND_A_${i.toString().padStart(8, '0')}}}` }],
        { provider: `p${i}` },
      );
    }
    const records = getOutboundMaskRecords();
    expect(records).toHaveLength(20);
    expect(records[0].provider).toBe('p5');
    expect(records[records.length - 1].provider).toBe('p24');
  });

  it('空替换清单是 no-op', async () => {
    const { recordOutboundMaskedRequest, getOutboundMaskRecords } = await load();
    recordOutboundMaskedRequest([]);
    expect(getOutboundMaskRecords()).toEqual([]);
  });

  it('getOutboundMaskRecords 返回防御性拷贝：改返回值不影响后续读取', async () => {
    const { recordOutboundMaskedRequest, getOutboundMaskRecords } = await load();
    recordOutboundMaskedRequest([{ kind: 'KIND_A', placeholder: '{{SECRET_KIND_A_deadbeef}}' }]);
    recordOutboundMaskedRequest([{ kind: 'KIND_B', placeholder: '{{SECRET_KIND_B_feedface}}' }]);
    const first = getOutboundMaskRecords();
    first.pop();
    // 故意篡改返回值（readonly 是类型面，运行时仍可写）：断言防御性拷贝吸收了篡改。
    (first[0].replacements[0] as { kind: string }).kind = 'TAMPERED';
    const second = getOutboundMaskRecords();
    expect(second).toHaveLength(2);
    expect(second[0].replacements[0].kind).toBe('KIND_A');
    expect(second[1].replacements[0].kind).toBe('KIND_B');
  });
});

describe('outboundSecretMaskRecorder ② 回执不进日志 / 遥测 / 设置写入', () => {
  beforeEach(() => {
    vi.resetModules();
    maskSettingsState.updateCalls = [];
  });

  it('掩码流之后，console / TelemetryService.startSpan / updateSettings 都没收到回执内容', async () => {
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug']
      .map((level) => vi.spyOn(console, level as 'log').mockImplementation(() => {}));
    const { TelemetryService } = await import('../../../src/host/telemetry/telemetryService');
    const startSpanSpy = vi.spyOn(TelemetryService.prototype, 'startSpan').mockImplementation((() => ({})) as never);

    const { applyOutboundSecretMask, getOutboundMaskRecords } = await load();
    maskOn();
    applyOutboundSecretMask([{ role: 'user', content: SECRET_TEXT }], undefined, {
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    const records = getOutboundMaskRecords();
    expect(records).toHaveLength(1);
    const placeholder = records[0].replacements[0].placeholder;

    const sinkCalls: unknown[] = [
      ...consoleSpies.flatMap((spy) => spy.mock.calls),
      ...startSpanSpy.mock.calls,
      maskSettingsState.updateCalls,
    ];
    for (const call of sinkCalls) {
      const dumped = JSON.stringify(call);
      expect(dumped).not.toContain(placeholder);
      expect(dumped).not.toContain(SECRET);
      expect(dumped).not.toContain('OPENAI_KEY');
    }
    // 掩码流本身没有产生任何 console 输出 / span / 设置写入
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(startSpanSpy.mock.calls.length).toBe(0);
    expect(maskSettingsState.updateCalls).toHaveLength(0);

    consoleSpies.forEach((spy) => spy.mockRestore());
    startSpanSpy.mockRestore();
  });
});
