/**
 * Smoke — multi-agent mode screenshot crop, REAL screencapture on macOS.
 *
 * 跑 ComputerSurface.observe(targetApp) 的两条路径对比：
 *   - 单 agent 模式：targetApp 时不截图（保留原行为，避免泄露其它窗口）
 *   - 多 agent 模式 + 同一个 targetApp：通过 listWindows + screencapture -R
 *     截 targetApp 窗口区域；该区域的截图字节数应该比全屏小
 *
 * 环境依赖：
 *   - macOS（process.platform === 'darwin'）
 *   - AX 权限给到运行 vitest 的进程（terminal/iTerm/...）。无权限时
 *     backgroundCgEventSurface.listWindows 返回空，本测试自动 skip 而非 fail。
 *   - 一个能启动并产生 AX 可见窗口的 app（默认 Calculator —— 内置 + 启动即开窗）
 *
 * 跑法：npm run test:smoke -- tests/smoke/multiAgentScreenshotCrop.smoke.test.ts
 *（smoke 测试已从默认 npm test 中隔离 —— 会真实操作桌面/启动真实进程）
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { stat, unlink } from 'fs/promises';
import { getComputerSurface } from '../../src/main/services/desktop/computerSurface';
import {
  setMultiAgentMode,
  resetMultiAgentModeForTests,
} from '../../src/main/services/multiAgentMode';
import { backgroundCgEventSurface } from '../../src/main/services/desktop/backgroundCgEventSurface';

const execFileAsync = promisify(execFile);
const TARGET_APP = 'Calculator';

async function quitApp(app: string): Promise<void> {
  await execFileAsync('osascript', ['-e', `tell application "${app}" to quit`]).catch(() => undefined);
}

async function isAppWindowAxVisible(app: string): Promise<boolean> {
  try {
    const wins = await backgroundCgEventSurface.listWindows({ targetApp: app, limit: 1 });
    return wins.length > 0 && Boolean(wins[0].bounds);
  } catch {
    return false;
  }
}

describe.skipIf(process.platform !== 'darwin')(
  'multi-agent screenshot crop (real screencapture)',
  () => {
    let environmentReady = false;

    beforeAll(async () => {
      await execFileAsync('open', ['-a', TARGET_APP]).catch(() => undefined);
      // 等窗口出来 + AX tree 就绪
      await new Promise((r) => setTimeout(r, 1500));
      environmentReady = await isAppWindowAxVisible(TARGET_APP);
      if (!environmentReady) {
        console.warn(
          `[crop-smoke] AX listWindows could not see ${TARGET_APP} window — likely missing` +
          ` Accessibility permission for the test runner. Skipping crop comparison.`,
        );
      }
    }, 30_000);

    afterAll(async () => {
      resetMultiAgentModeForTests();
      await quitApp(TARGET_APP);
    });

    it('preserves single-agent behavior — no screenshot when targetApp is set', async () => {
      setMultiAgentMode(false);
      const snap = await getComputerSurface().observe({
        includeScreenshot: true,
        targetApp: TARGET_APP,
      });
      expect(snap.screenshotPath).toBeUndefined();
    });

    it('crops to targetApp window in multi-agent mode (smaller than full-screen)', async () => {
      if (!environmentReady) {
        console.warn('[crop-smoke] skipping — AX environment not ready');
        return;
      }

      setMultiAgentMode(true);
      const surface = getComputerSurface();
      const cropSnap = await surface.observe({ includeScreenshot: true, targetApp: TARGET_APP });
      expect(cropSnap.screenshotPath).toBeTruthy();
      const cropStat = await stat(cropSnap.screenshotPath!);

      // 全屏截图作为对比基线（不传 targetApp = 全屏路径，跟 multiAgentMode 无关）
      setMultiAgentMode(false);
      const fullSnap = await surface.observe({ includeScreenshot: true });
      expect(fullSnap.screenshotPath).toBeTruthy();
      const fullStat = await stat(fullSnap.screenshotPath!);

      console.log(`[crop-smoke] crop screenshot bytes: ${cropStat.size}`);
      console.log(`[crop-smoke] full screenshot bytes: ${fullStat.size}`);
      console.log(`[crop-smoke] crop / full ratio: ${(cropStat.size / fullStat.size).toFixed(3)}`);

      expect(cropStat.size).toBeGreaterThan(0);
      expect(cropStat.size).toBeLessThan(fullStat.size);

      await unlink(cropSnap.screenshotPath!).catch(() => undefined);
      await unlink(fullSnap.screenshotPath!).catch(() => undefined);
    }, 30_000);
  },
);
