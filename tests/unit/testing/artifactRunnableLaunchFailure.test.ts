// N-TEST-GAMESMOKE-FLAKY 回归：启动阶段的浏览器失败不允许判成产物的 not_runnable。
//
// 背景：CI runner（ubuntu-latest）有系统 Chrome、没有 Playwright bundled Chromium
// （runner 镜像不带，workflow 也不跑 npx playwright install）。冷启动+CPU 饥饿下
// system Chrome 的 CDP 端点偶尔超过启动预算 → 旧版静默回退 bundled launch →
// 在 CI 上必失败（Executable doesn't exist）→ 异常抛进 smoke 的 catch →
// known-good 产物被误判 not_runnable（Eval Harness Gate 假红）。
//
// 本文件是 hermetic 环境接缝测试（非 mock）：走 checkGameSmoke 公共入口 +
// 真实 spawn/CDP 轮询/launch 回退，只用环境旋钮（CHROME_PATH 指向假 chrome、
// PLAYWRIGHT_BROWSERS_PATH 指向不存在目录）注入「系统 Chrome 起不来 +
// bundled Chromium 缺失」的 CI 拓扑。独立成文件是为了拿干净的 worker：
// playwright 的浏览器目录在模块加载时捕获 env，必须保证本文件内首次加载时
// env 已经换成假值。
import { afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { checkGameSmoke } from '../../../src/host/testing/artifactRunnableAdapter';

// 假 chrome：立即退出（waitForCdpEndpoint 会以「进程先退」判失败，快速走完全链）。
const FAKE_CHROME_EXIT_NOW = [
  '#!/bin/sh',
  '# N-TEST-GAMESMOKE-FLAKY hermetic seam: system Chrome that never serves CDP.',
  'exit 0',
  '',
].join('\n');

// 假 chrome：撑过 800ms 的 smoke deadline 后才退出。若 CDP 等待仍被
// min(timeoutMs, 8000) 卡死在 800ms，看到的是「超时」而不是「进程先退」——
// 用来钉「启动预算与 smoke deadline 解耦」。
const FAKE_CHROME_EXIT_SLOW = [
  '#!/bin/sh',
  '# N-TEST-GAMESMOKE-FLAKY hermetic seam: system Chrome that outlives the smoke deadline.',
  'exec sleep 1.5',
  '',
].join('\n');

interface LaunchEnvSeam {
  chromePath: string;
  browsersPath: string;
}

const SAVED_ENV_KEYS = ['CHROME_PATH', 'CODE_AGENT_BROWSER_PROVIDER', 'PLAYWRIGHT_BROWSERS_PATH'] as const;

let activeSeam: LaunchEnvSeam | null = null;
const savedEnv = new Map<string, string | undefined>();

function enterLaunchEnvSeam(seam: LaunchEnvSeam): void {
  for (const key of SAVED_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
  }
  process.env.CHROME_PATH = seam.chromePath;
  process.env.CODE_AGENT_BROWSER_PROVIDER = 'system-chrome-cdp';
  process.env.PLAYWRIGHT_BROWSERS_PATH = seam.browsersPath;
  activeSeam = seam;
}

afterEach(() => {
  if (!activeSeam) return;
  for (const key of SAVED_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  activeSeam = null;
});

async function writeFakeChrome(script: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'neo-launch-failure-'));
  const filePath = path.join(dir, 'fake-chrome.sh');
  await writeFile(filePath, script, { mode: 0o755 });
  return filePath;
}

async function writeTempArtifact(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'neo-launch-failure-artifact-'));
  const filePath = path.join(dir, 'game.html');
  await writeFile(filePath, '<!doctype html><html><body><canvas id="game"></canvas></body></html>');
  return filePath;
}

describe('checkGameSmoke launch-phase browser failure (N-TEST-GAMESMOKE-FLAKY)', () => {
  it('judges an environment that cannot launch any browser skipped, with a per-leg trace — never not_runnable', async () => {
    const chromePath = await writeFakeChrome(FAKE_CHROME_EXIT_NOW);
    const artifact = await writeTempArtifact();
    enterLaunchEnvSeam({ chromePath, browsersPath: path.join(tmpdir(), 'neo-no-playwright-browsers') });

    const result = await checkGameSmoke(artifact, { timeoutMs: 15_000 });

    // 启动失败是环境事实，不是产物事实：必须是 skipped（与 Playwright 包缺失同语义）。
    expect(result.verdict).toBe('skipped');
    expect(result.failures).toEqual([]);
    // 降级留痕：每条启动腿（system Chrome CDP / bundled Chromium / 重试）都要留下可区分的原因。
    expect(result.checks[0]).toContain('light playability smoke skipped: browser launch failed');
    expect(result.checks[0]).toContain('system Chrome CDP:');
    expect(result.checks[0]).toContain('Playwright bundled Chromium:');
  });

  it('gives the launch phase its own budget instead of the smoke deadline (fake Chrome outlives timeoutMs=800)', async () => {
    const chromePath = await writeFakeChrome(FAKE_CHROME_EXIT_SLOW);
    const artifact = await writeTempArtifact();
    enterLaunchEnvSeam({ chromePath, browsersPath: path.join(tmpdir(), 'neo-no-playwright-browsers') });

    // smoke deadline 只有 800ms；假 chrome 1.5s 后才退。启动预算若还被
    // min(timeoutMs, 8000) 拴在 800ms 上，只能看到「CDP 超时」；解耦后
    // CDP 等待活过 800ms，看到的是「进程先退」——断言钉住解耦。
    const result = await checkGameSmoke(artifact, { timeoutMs: 800 });

    expect(result.verdict).toBe('skipped');
    expect(result.failures).toEqual([]);
    expect(result.checks[0]).toContain('System Chrome exited before CDP became ready');
  });
});
