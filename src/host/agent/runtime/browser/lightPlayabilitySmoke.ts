// Light 契约可玩性冒烟：真实浏览器加载 + 键盘输入，只在硬信号上判失败
// （未捕获运行时异常 / canvas 全程空白）。"输入后画面无变化"和 console.error
// 只记 check 不判失败，避免把风格各异的休闲产物误伤进 repair 循环
// （沿用"休闲产物只验能跑"的产品口径，这里补的是此前缺失的"真·能跑"证据）。
import { pathToFileURL } from 'url';
import type { RuntimeSmokeSummary } from '../gameArtifactRuntimeSmoke';
import { openArtifactPage, type ArtifactPageSession } from './artifactPage';

type SmokePage = import('playwright').Page;

interface CanvasSample {
  hasCanvas: boolean;
  uniform: boolean;
  signature: string;
}

// 每一段取 max(动画帧, origin/main 的墙钟)。慢渲染时帧等待会把窗口拉长；
// 墙钟是下限，首帧已画出或没有 canvas 时也不许比基线的 500+400+250+250ms 更短，
// 否则加载后或按键后几百毫秒的 pageerror 会被当成可玩。
const KEY_HOLD_FRAMES = 3;
const KEY_GAP_FRAMES = 2;
const POST_LOAD_WALL_MS = 500;
const KEY_HOLD_WALL_MS = 400;
const KEY_GAP_WALL_MS = 250;

function readLargestCanvasSample(): CanvasSample {
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
}

function shouldKeepWaitingForPaint(sample: CanvasSample): boolean {
  return sample.hasCanvas && sample.signature !== 'unsampled' && sample.uniform;
}

async function raceDeadline(work: Promise<unknown>, deadline: number): Promise<void> {
  // 剩余时间为 0 时调用方已经创建了 work。先接住拒绝，否则关页后变成未处理拒绝，整轮测试退出码为 1。
  const observed = work.then(() => undefined, () => undefined);
  const left = deadline - Date.now();
  if (left <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      observed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFramesAndWallClock(
  page: SmokePage,
  frameCount: number,
  wallClockMs: number,
  deadline: number,
  opTimeoutMs: number,
): Promise<void> {
  const started = Date.now();
  if (frameCount > 0) {
    await waitForAnimationFrames(page, frameCount, deadline, opTimeoutMs);
  }
  const remainingWallMs = wallClockMs - (Date.now() - started);
  if (remainingWallMs > 0) {
    await page.waitForTimeout(remainingWallMs);
  }
}

async function waitForAnimationFrames(page: SmokePage, frameCount: number, deadline: number, opTimeoutMs: number): Promise<void> {
  const left = deadline - Date.now();
  if (left <= 0 || frameCount <= 0) return;
  page.setDefaultTimeout(Math.max(1, left));
  try {
    await raceDeadline(page.evaluate((count) => new Promise<void>((resolve) => {
      let seen = 0;
      const tick = () => {
        seen += 1;
        if (seen >= count) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), frameCount), deadline);
  } finally {
    page.setDefaultTimeout(opTimeoutMs);
  }
}

async function waitForPresentCanvas(page: SmokePage, deadline: number, opTimeoutMs: number): Promise<void> {
  while (Date.now() < deadline) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    page.setDefaultTimeout(Math.max(1, left));
    let sample: CanvasSample;
    try {
      sample = await page.evaluate(readLargestCanvasSample);
    } finally {
      page.setDefaultTimeout(opTimeoutMs);
    }
    if (!shouldKeepWaitingForPaint(sample)) return;
    page.setDefaultTimeout(Math.max(1, deadline - Date.now()));
    try {
      await raceDeadline(page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      })), deadline);
    } finally {
      page.setDefaultTimeout(opTimeoutMs);
    }
  }
}

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

    // 加载、按键、等首帧共用调用方传入的 timeoutMs，到点仍空白才走下面的判红。
    const deadline = Date.now() + timeoutMs;
    page.setDefaultTimeout(Math.max(1, timeoutMs));
    await page.goto(pathToFileURL(filePath).href, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, deadline - Date.now()),
    });

    await waitFramesAndWallClock(page, 0, POST_LOAD_WALL_MS, deadline, timeoutMs);
    const beforeInput = await page.evaluate(readLargestCanvasSample);
    // 常见开始/操作键：Enter（任意键开始）+ 持续向右 + 空格跳跃
    await page.keyboard.press('Enter').catch(() => undefined);
    await page.keyboard.down('ArrowRight').catch(() => undefined);
    await waitFramesAndWallClock(page, KEY_HOLD_FRAMES, KEY_HOLD_WALL_MS, deadline, timeoutMs);
    await page.keyboard.press('Space').catch(() => undefined);
    await waitFramesAndWallClock(page, KEY_GAP_FRAMES, KEY_GAP_WALL_MS, deadline, timeoutMs);
    await page.keyboard.up('ArrowRight').catch(() => undefined);
    await waitFramesAndWallClock(page, KEY_GAP_FRAMES, KEY_GAP_WALL_MS, deadline, timeoutMs);
    if (shouldKeepWaitingForPaint(beforeInput)) {
      await waitForPresentCanvas(page, deadline, timeoutMs);
    }
    const afterInput = await page.evaluate(readLargestCanvasSample);

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
