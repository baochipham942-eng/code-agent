// Light 契约可玩性冒烟：真实浏览器加载 + 键盘输入，只在硬信号上判失败
// （未捕获运行时异常 / canvas 全程空白）。"输入后画面无变化"和 console.error
// 只记 check 不判失败，避免把风格各异的休闲产物误伤进 repair 循环
// （沿用"休闲产物只验能跑"的产品口径，这里补的是此前缺失的"真·能跑"证据）。
import { pathToFileURL } from 'url';
import type { RuntimeSmokeSummary } from '../gameArtifactRuntimeSmoke';
import { openArtifactPage, type ArtifactPageSession } from './artifactPage';

export async function runLightPlayabilitySmoke(filePath: string, timeoutMs: number): Promise<RuntimeSmokeSummary> {
  let session: ArtifactPageSession | null = null;

  try {
    const opened = await openArtifactPage(timeoutMs);
    if (!opened.ok) {
      return {
        attempted: false,
        skipped: true,
        passed: true,
        failures: [],
        checks: [`light playability smoke skipped: ${opened.skippedReason}`],
      };
    }
    session = opened.session;
    const { page, launchChecks } = session;

    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => {
      if (pageErrors.length < 5) pageErrors.push(String(error).slice(0, 200));
    });
    page.on('console', (message) => {
      if (message.type() === 'error' && consoleErrors.length < 5) {
        consoleErrors.push(message.text().slice(0, 200));
      }
    });

    await page.goto(pathToFileURL(filePath).href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(500);

    const sampleCanvas = () => page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      if (canvases.length === 0) return { hasCanvas: false, uniform: false, signature: '' };
      const canvas = canvases.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
      const context = canvas.getContext('2d');
      if (!context || canvas.width === 0 || canvas.height === 0) {
        // WebGL 或零尺寸 canvas 无法采样 2D 像素，不做空白判定
        return { hasCanvas: true, uniform: false, signature: 'unsampled' };
      }
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let min = 255;
      let max = 0;
      let signature = 0;
      const stride = Math.max(4, Math.floor(data.length / 4 / 4000) * 4);
      for (let index = 0; index < data.length; index += stride) {
        const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3;
        if (luminance < min) min = luminance;
        if (luminance > max) max = luminance;
        signature = (signature + luminance * ((index % 7919) + 1)) % Number.MAX_SAFE_INTEGER;
      }
      return { hasCanvas: true, uniform: max - min < 8, signature: String(Math.round(signature)) };
    });

    const beforeInput = await sampleCanvas();
    // 常见开始/操作键：Enter（任意键开始）+ 持续向右 + 空格跳跃
    await page.keyboard.press('Enter').catch(() => undefined);
    await page.keyboard.down('ArrowRight').catch(() => undefined);
    await page.waitForTimeout(400);
    await page.keyboard.press('Space').catch(() => undefined);
    await page.waitForTimeout(250);
    await page.keyboard.up('ArrowRight').catch(() => undefined);
    await page.waitForTimeout(250);
    const afterInput = await sampleCanvas();

    const failures: string[] = [];
    const checks: string[] = [...launchChecks];
    if (pageErrors.length > 0) {
      failures.push(
        `light playability smoke detected runtime page errors during load/keyboard input: ${pageErrors.join(' | ')}`,
      );
    }
    if (beforeInput.hasCanvas && beforeInput.uniform && afterInput.uniform) {
      failures.push('canvas stayed blank after load and keyboard input; no nonblank rendered content was drawn.');
    }
    if (failures.length === 0) {
      checks.push('light playability smoke passed: page loaded and accepted keyboard input without runtime errors');
      if (beforeInput.hasCanvas) {
        checks.push(
          beforeInput.signature !== afterInput.signature
            ? 'canvas pixels changed after keyboard input'
            : 'canvas pixels did not change after keyboard input (informational, not a failure)',
        );
      }
      if (consoleErrors.length > 0) {
        checks.push(`console errors observed (informational): ${consoleErrors.join(' | ')}`);
      }
    }

    return { attempted: true, passed: failures.length === 0, failures, checks };
  } catch (error) {
    return {
      attempted: true,
      passed: false,
      failures: [`无法运行可玩性冒烟: ${error instanceof Error ? error.message : String(error)}`],
      checks: [],
    };
  } finally {
    await session?.close().catch(() => undefined);
  }
}
