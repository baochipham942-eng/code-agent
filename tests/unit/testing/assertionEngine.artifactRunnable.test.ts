// artifact_runnable 断言家族在 expectation 引擎里的接线测试（批 3 · B3①）。
// pptx 类无浏览器依赖，作为确定性接线主载体；game_smoke 走真浏览器带 skip 守卫。
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { runExpectations } from '../../../src/host/testing/assertionEngine';
import { checkGameSmoke } from '../../../src/host/testing/artifactRunnableAdapter';
import type { Expectation } from '../../../src/host/testing/types';

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../.claude/test-cases/artifact-runnable/fixtures',
);

const EMPTY_CONTEXT = {
  toolExecutions: [],
  responses: [],
  errors: [],
  turnCount: 1,
};

async function makeWorkingDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'code-agent-artifact-expectation-'));
}

describe('pptx_opens expectation wiring', () => {
  it('fails on a corrupt pptx with default polarity and resolves relative paths against workingDirectory', async () => {
    const workingDirectory = await makeWorkingDirectory();
    await writeFile(path.join(workingDirectory, 'deck.pptx'), 'not a zip');

    const expectation: Expectation = {
      type: 'pptx_opens',
      description: 'pptx 产物可解析打开',
      critical: true,
      params: { path: 'deck.pptx' },
    };
    const result = await runExpectations([expectation], { ...EMPTY_CONTEXT, workingDirectory });

    expect(result.passed).toBe(false);
    expect(result.hasCriticalFailure).toBe(true);
    expect(String(result.results[0].evidence.actual)).toContain('not_runnable');
  });

  it('passes a corrupt pptx when the case pins expected_verdict=not_runnable (回归标本极性)', async () => {
    const workingDirectory = await makeWorkingDirectory();
    await writeFile(path.join(workingDirectory, 'broken.pptx'), 'not a zip');

    const expectation: Expectation = {
      type: 'pptx_opens',
      description: '坏 pptx 标本必须被判红',
      critical: true,
      params: { path: 'broken.pptx', expected_verdict: 'not_runnable' },
    };
    const result = await runExpectations([expectation], { ...EMPTY_CONTEXT, workingDirectory });

    expect(result.passed).toBe(true);
    expect(result.results[0].evidence.details).toContain('environment');
  });

  it('fails a missing artifact file with a clear message', async () => {
    const workingDirectory = await makeWorkingDirectory();

    const expectation: Expectation = {
      type: 'pptx_opens',
      description: '产物文件不存在',
      params: { path: 'never-written.pptx' },
    };
    const result = await runExpectations([expectation], { ...EMPTY_CONTEXT, workingDirectory });

    expect(result.passed).toBe(false);
    expect(String(result.results[0].evidence.actual)).toContain('not found');
  });
});

describe('artifact_runnable params 校验（审计 R1：非法参数必须 fail-loud，不许静默降级）', () => {
  it('fails a pinned not_runnable regression case when the artifact file is missing (R1-H1：文件缺失≠探测器抓红)', async () => {
    const workingDirectory = await makeWorkingDirectory();

    const expectation: Expectation = {
      type: 'pptx_opens',
      description: '回归标本文件缺位时不许假绿',
      critical: true,
      params: { path: 'missing-specimen.pptx', expected_verdict: 'not_runnable' },
    };
    const result = await runExpectations([expectation], { ...EMPTY_CONTEXT, workingDirectory });

    expect(result.passed).toBe(false);
    expect(String(result.results[0].evidence.actual)).toContain('file_missing');
  });

  it('fails on a misspelled expected_verdict instead of silently falling back to runnable (R1-M1)', async () => {
    const workingDirectory = await makeWorkingDirectory();
    await writeFile(path.join(workingDirectory, 'deck.pptx'), 'not a zip');

    const expectation: Expectation = {
      type: 'pptx_opens',
      description: '拼错的 expected_verdict 必须显式报错',
      critical: true,
      params: { path: 'deck.pptx', expected_verdict: 'not_runable' },
    };
    const result = await runExpectations([expectation], { ...EMPTY_CONTEXT, workingDirectory });

    expect(result.passed).toBe(false);
    expect(String(result.results[0].evidence.actual)).toContain('invalid params');
  });

  it('fails on a missing/non-string path with a clear message instead of throwing (R1-M2)', async () => {
    const workingDirectory = await makeWorkingDirectory();

    const expectation: Expectation = {
      type: 'game_smoke',
      description: '漏写 path 必须显式报错',
      critical: true,
      params: {},
    };
    const result = await runExpectations([expectation], { ...EMPTY_CONTEXT, workingDirectory });

    expect(result.passed).toBe(false);
    expect(String(result.results[0].evidence.actual)).toContain('invalid params');
  });

  it('fails on an invalid game_smoke contract value instead of silently running light (对称应用)', async () => {
    const workingDirectory = await makeWorkingDirectory();

    const expectation: Expectation = {
      type: 'game_smoke',
      description: '拼错的 contract 必须显式报错',
      critical: true,
      params: { path: 'game.html', contract: 'ful' },
    };
    const result = await runExpectations([expectation], { ...EMPTY_CONTEXT, workingDirectory });

    expect(result.passed).toBe(false);
    expect(String(result.results[0].evidence.actual)).toContain('invalid params');
  });

  it('fails on a non-positive timeout_ms instead of silently ignoring it (对称应用)', async () => {
    const workingDirectory = await makeWorkingDirectory();

    const expectation: Expectation = {
      type: 'html_renders',
      description: '非法 timeout_ms 必须显式报错',
      critical: true,
      params: { path: 'page.html', timeout_ms: -5 },
    };
    const result = await runExpectations([expectation], { ...EMPTY_CONTEXT, workingDirectory });

    expect(result.passed).toBe(false);
    expect(String(result.results[0].evidence.actual)).toContain('invalid params');
  });
});

describe('game_smoke expectation wiring (真浏览器)', () => {
  it('judges the bad-game specimen red and the pinned regression case green', async (ctx) => {
    const probe = await checkGameSmoke(path.join(FIXTURE_DIR, 'bad-game-referenceerror.html'));
    if (probe.verdict === 'skipped') ctx.skip(); // 无浏览器环境真 skip（不许静默假绿），与生产语义一致

    const badDefault: Expectation = {
      type: 'game_smoke',
      description: '坏游戏（默认极性）应 fail',
      critical: true,
      params: { path: path.join(FIXTURE_DIR, 'bad-game-referenceerror.html') },
    };
    const badPinned: Expectation = {
      type: 'game_smoke',
      description: '坏游戏标本回归 pin：必须被判 not_runnable',
      critical: true,
      params: {
        path: path.join(FIXTURE_DIR, 'bad-game-referenceerror.html'),
        expected_verdict: 'not_runnable',
      },
    };
    const good: Expectation = {
      type: 'game_smoke',
      description: '已知好产物必须 runnable',
      critical: true,
      params: { path: path.join(FIXTURE_DIR, 'good-game-playable.html') },
    };

    const workingDirectory = await makeWorkingDirectory();
    const result = await runExpectations([badDefault, badPinned, good], {
      ...EMPTY_CONTEXT,
      workingDirectory,
    });

    expect(result.results[0].passed).toBe(false);
    expect(result.results[1].passed).toBe(true);
    expect(result.results[2].passed).toBe(true);
  }, 60_000);
});

describe('html_renders expectation wiring (真浏览器)', () => {
  it('passes the known-good canvas game (layout findings stay informational)', async (ctx) => {
    const goodPath = path.join(FIXTURE_DIR, 'good-game-playable.html');
    const probe = await checkGameSmoke(goodPath);
    if (probe.verdict === 'skipped') ctx.skip();

    const expectation: Expectation = {
      type: 'html_renders',
      description: '好产物 headless 渲染无硬错误',
      critical: true,
      params: { path: goodPath },
    };
    const workingDirectory = await makeWorkingDirectory();
    const result = await runExpectations([expectation], { ...EMPTY_CONTEXT, workingDirectory });

    expect(result.passed).toBe(true);
  }, 60_000);
});
