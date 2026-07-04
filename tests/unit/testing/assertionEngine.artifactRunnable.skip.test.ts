// artifact_runnable 环境降级语义：浏览器/Playwright 不可用（adapter verdict='skipped'）
// 时断言必须显式 fail 并说明环境原因——绝不冒充 pass（防"环境缺失=全绿"的假信号），
// 也不发明新的 infra_excluded 语义（G3 红线：分母口径不动）。
// 这里 mock adapter 模拟无浏览器环境（真实环境有 Chrome，无法自然触发）。
import { describe, expect, it, vi } from 'vitest';
import { runExpectations } from '../../../src/host/testing/assertionEngine';
import type { Expectation } from '../../../src/host/testing/types';

vi.mock('../../../src/host/testing/artifactRunnableAdapter', () => ({
  checkGameSmoke: vi.fn(async () => ({
    verdict: 'skipped',
    failures: [],
    checks: ['light playability smoke skipped: Playwright package unavailable.'],
    environment: 'test-env browser=none headless=true',
  })),
  checkHtmlRenders: vi.fn(),
  checkPptxOpens: vi.fn(),
}));

describe('artifact_runnable skip semantics', () => {
  it('fails explicitly (never fake-passes) when the check environment is unavailable', async () => {
    const expectation: Expectation = {
      type: 'game_smoke',
      description: '环境缺浏览器时不许假绿',
      critical: true,
      params: { path: 'game.html' },
    };
    const result = await runExpectations([expectation], {
      toolExecutions: [],
      responses: [],
      errors: [],
      turnCount: 1,
      workingDirectory: '/tmp',
    });

    expect(result.passed).toBe(false);
    expect(String(result.results[0].evidence.actual)).toContain('skipped');
    expect(result.results[0].evidence.details).toContain('environment');
  });

  it('also fails a pinned not_runnable regression case on skip (环境缺失不能证明探测有效)', async () => {
    const expectation: Expectation = {
      type: 'game_smoke',
      description: '回归标本在无浏览器环境下同样不许假绿',
      critical: true,
      params: { path: 'game.html', expected_verdict: 'not_runnable' },
    };
    const result = await runExpectations([expectation], {
      toolExecutions: [],
      responses: [],
      errors: [],
      turnCount: 1,
      workingDirectory: '/tmp',
    });

    expect(result.passed).toBe(false);
  });
});
