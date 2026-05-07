// ============================================================================
// STATE_CHANGE_ON_CLICK_PROBE unit tests — PR-E (anti-Potemkin).
//
// vi.mock interactionProbeRunner 让 runStateChangeProbe 返回固定 result，
// 测 transform 五个 mode → DashboardProbeResult 的映射。不真 launch browser，
// 单测 stable + fast。
//
// 真 browser launch 验证（4 fixture HTML：correct / potemkin-noop /
// potemkin-broken-handler / potemkin-css-only）按 plan §5 PR-E 描述要做，
// 但本 PR 不在 unit test 跑——CI 上 Playwright headless 风险高（plan §6
// 风险 1）。如果未来要加 e2e fixture test，应该走单独的 acceptance 脚本，
// 跟 platformer-gameplay-validate 同等地位（不阻塞主流水线）。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runStateChangeProbeMock } = vi.hoisted(() => ({
  runStateChangeProbeMock: vi.fn(),
}));

vi.mock('../../../../../src/main/agent/runtime/dashboard/general/interactionProbeRunner', () => ({
  runStateChangeProbe: runStateChangeProbeMock,
}));

import {
  STATE_CHANGE_ON_CLICK_PROBE,
  INTERACTION_PROBES,
} from '../../../../../src/main/agent/runtime/dashboard/general/interactionProbes';

const DUMMY_INPUT = { filePath: '/tmp/whatever.html' };

beforeEach(() => {
  runStateChangeProbeMock.mockReset();
});

describe('INTERACTION_PROBES set', () => {
  it('exports state_change_on_click single imperative probe', () => {
    expect(INTERACTION_PROBES.map((p) => p.id)).toEqual(['state_change_on_click']);
  });

  it('all probes are imperative', () => {
    expect(INTERACTION_PROBES.every((p) => p.kind === 'imperative')).toBe(true);
  });
});

describe('STATE_CHANGE_ON_CLICK_PROBE transform — pass mode', () => {
  it('mode=pass returns probe.passed=true with selector + mutations diagnostics', async () => {
    runStateChangeProbeMock.mockResolvedValueOnce({ mode: 'pass', selector: 'button', mutations: 3 });
    const r = await STATE_CHANGE_ON_CLICK_PROBE.evaluate(DUMMY_INPUT);
    expect(r.probe).toBe('state_change_on_click');
    expect(r.passed).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(r.diagnostics?.selector).toBe('button');
    expect(r.diagnostics?.mutations).toBe(3);
  });
});

describe('STATE_CHANGE_ON_CLICK_PROBE transform — Potemkin failure modes', () => {
  it('mode=no-target reports missing interactive element', async () => {
    runStateChangeProbeMock.mockResolvedValueOnce({ mode: 'no-target' });
    const r = await STATE_CHANGE_ON_CLICK_PROBE.evaluate(DUMMY_INPUT);
    expect(r.passed).toBe(false);
    expect(r.failure).toMatch(/找不到 <button> 或 <a>/);
  });

  it('mode=no-mutation reports core Potemkin signal with selector', async () => {
    runStateChangeProbeMock.mockResolvedValueOnce({
      mode: 'no-mutation',
      selector: 'a[href]',
      mutations: 0,
    });
    const r = await STATE_CHANGE_ON_CLICK_PROBE.evaluate(DUMMY_INPUT);
    expect(r.passed).toBe(false);
    expect(r.failure).toContain('a[href]');
    expect(r.failure).toContain('Potemkin');
    expect(r.failure).toMatch(/event listener 没接|hover|focus/);
    expect(r.diagnostics?.mutations).toBe(0);
    expect(r.diagnostics?.selector).toBe('a[href]');
  });

  it('mode=handler-error attributes failure to listener exception', async () => {
    runStateChangeProbeMock.mockResolvedValueOnce({
      mode: 'handler-error',
      selector: 'button',
      errorMessage: 'cannot read property foo of null',
    });
    const r = await STATE_CHANGE_ON_CLICK_PROBE.evaluate(DUMMY_INPUT);
    expect(r.passed).toBe(false);
    expect(r.failure).toContain('handler 抛错');
    expect(r.failure).toContain('cannot read property foo of null');
    expect(r.diagnostics?.handlerError).toBe('cannot read property foo of null');
  });
});

describe('STATE_CHANGE_ON_CLICK_PROBE transform — environment failure', () => {
  it('mode=launch-error distinguishes infra failure from Potemkin', async () => {
    // launch-error 是环境/工具问题（Playwright 没装等），不是产物缺陷。
    // 当前实现仍 mark fail（让 LLM 知道无法验证），但 failure prefix 和
    // Potemkin failure 不同（"启动失败" vs "Potemkin"），LLM repair prompt
    // 可以据此区分动作（重新装 deps vs 重新生成 listener）。
    runStateChangeProbeMock.mockResolvedValueOnce({
      mode: 'launch-error',
      errorMessage: 'browser type cannot be launched: executable not found',
    });
    const r = await STATE_CHANGE_ON_CLICK_PROBE.evaluate(DUMMY_INPUT);
    expect(r.passed).toBe(false);
    expect(r.failure).toContain('启动失败');
    expect(r.failure).toContain('executable not found');
    expect(r.failure).not.toContain('Potemkin');
  });
});
