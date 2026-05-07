// ============================================================================
// DashboardVerifier dispatch smoke.
//
// 4 case 覆盖 dispatch 路径：
//   1. 默认 subtype 'general' 跑通，passed=true（含 HTML_PROBES 全 pass）
//   2. 显式传 'general' 同上
//   3. 未知 subtype 返回 passed=false 且 failures 含明确报错
//   4. listSubtypes() 暴露已注册 subtype 列表
//
// PR-C 起 default registry 的 GeneralDashboardChecker 含实际 probes，case 1/2
// 需要真实 fixture HTML 让 declarative probe 跑通。fixture 写到 tmpdir 避免
// 污染 git tree；afterEach 清理。
// ============================================================================

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// PR-D/E 起 default registry 含 imperative browser + interaction probe；mock
// 掉真 launch 让 dispatch smoke 测试不依赖 Playwright 环境。各 imperative
// probe 自身的 transform 行为单独在 browserProbes.test.ts /
// interactionProbes.test.ts 里测。
vi.mock('../../../../../src/main/agent/runtime/browser/visualSmoke', () => ({
  runBrowserVisualSmoke: vi.fn().mockResolvedValue({
    attempted: true,
    passed: true,
    failures: [],
    checks: ['mocked smoke passed'],
  }),
  DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS: 10000,
}));
vi.mock('../../../../../src/main/agent/runtime/dashboard/general/interactionProbeRunner', () => ({
  runStateChangeProbe: vi.fn().mockResolvedValue({
    mode: 'pass',
    selector: 'button',
    mutations: 1,
  }),
}));

import { DashboardVerifier } from '../../../../../src/main/agent/runtime/dashboard/DashboardVerifier';

// fixture 故意不含任何 no_lorem_ipsum 触发词（lorem / TODO / Coming soon /
// placeholder / 占位 等）；如果未来加 probe，这里也要保持干净。
const VALID_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>OK</title></head>
<body>
  <h1>真实内容</h1>
  <p>这是一段真实的正文，不含任何待替换文字。</p>
</body>
</html>`;

describe('DashboardVerifier dispatch', () => {
  let workspaceDir: string;
  let validHtmlPath: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'dashboard-verifier-test-'));
    validHtmlPath = join(workspaceDir, 'valid.html');
    await writeFile(validHtmlPath, VALID_HTML, 'utf-8');
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('runs default subtype general and returns passed result against a valid HTML', async () => {
    const verifier = new DashboardVerifier();
    const result = await verifier.validate({ filePath: validHtmlPath });
    expect(result.subtype).toBe('general');
    expect(result.passed).toBe(true);
    expect(result.probes.length).toBeGreaterThan(0);
    expect(result.probes.every((p) => p.passed)).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('accepts explicit general subtype with same outcome', async () => {
    const verifier = new DashboardVerifier();
    const result = await verifier.validate({ filePath: validHtmlPath }, 'general');
    expect(result.subtype).toBe('general');
    expect(result.passed).toBe(true);
  });

  it('returns failure result for unknown subtype without throwing', async () => {
    const verifier = new DashboardVerifier();
    const result = await verifier.validate({ filePath: validHtmlPath }, 'data-viz');
    expect(result.passed).toBe(false);
    expect(result.subtype).toBe('data-viz');
    expect(result.probes).toEqual([]);
    expect(result.failures).toEqual(['Unknown dashboard subtype: data-viz']);
  });

  it('listSubtypes exposes the registered subtype set', () => {
    const verifier = new DashboardVerifier();
    expect(verifier.listSubtypes()).toEqual(['general']);
  });
});
