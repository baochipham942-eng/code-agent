// ============================================================================
// 通话侧屏幕上下文采集（Appshots Phase 3 —— 看屏进 Live）
//
// 只做一件事：把「用户此刻的屏幕」采成一份 AppshotCapture，交给 coordinator 附到
// 下一次派活上。**不新造采集器**——截图走 computerSurface 那支既有的 screencapture，
// 前台 app/窗口名走 computerSurfaceContext 既有的 osascript，附件与隐藏上下文形状
// 复用 shared/contract/appshot。这个文件里只有胶水和失败分类。
//
// 为什么单独一个文件而不是塞进 coordinator：这是唯一会碰真实屏幕的地方，测试必须
// 能整块替掉（CI 没有屏幕录制权限，真跑一次采集就是一个必挂的用例）。
//
// 失败一律 fail-closed 且说人话：本仓语音线的第一铁律是状态不说谎——
// 「没拍到却回一句像成功的话」比拍不到严重得多。
// ============================================================================

import { readFile } from 'fs/promises';
import type { AppshotCapture } from '../../../shared/contract/appshot';
import { captureComputerSurfaceScreenshot } from '../desktop/computerSurfaceScreenshots';
import { getFrontmostComputerSurfaceContext } from '../desktop/computerSurfaceContext';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceScreenContext');

/** 采不到的三种原因。受控词表：遥测按它分组，不许在调用处拼串。 */
export type VoiceScreenCaptureFailure =
  /** 这台机器没有这个能力（screencapture 是 macOS 的） */
  | 'unsupported_platform'
  /** 系统没给屏幕录制权限 */
  | 'no_permission'
  /** 拍了但没拍成（命令失败、文件是空的、读不出来） */
  | 'capture_failed';

export type VoiceScreenCaptureResult =
  | { ok: true; capture: AppshotCapture }
  | { ok: false; reason: VoiceScreenCaptureFailure; detail?: string };

/**
 * 这台机器能不能看屏。instructions 与工具执行共用这一个判据——
 * 「语音脑说能看、执行脑不能看」正是策略双写要防的那种错位。
 */
export function isVoiceScreenContextSupported(): boolean {
  return process.platform === 'darwin';
}

/**
 * 屏幕录制被拒时 screencapture 报的那类话。
 *
 * 刻意本地写而不是复用 backgroundCgEventBridge 的 isLikelyAccessibilityPermissionError：
 * 那条是「辅助功能」的词表，这条是「屏幕录制」，两个权限不是一回事；而且那个模块会
 * 拉起 Swift helper，为了一行正则把它 import 进实时语音链路不划算。
 */
function isLikelyScreenPermissionError(message: string): boolean {
  return /not authorized|not permitted|operation not permitted|screen recording|screen capture|privacy|tcc/i
    .test(message);
}

function newRequestId(): string {
  return `voice-screen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 采一次屏幕上下文。整屏，不挑窗口——用户说的是「我屏幕上这个」，我们并不知道他指的
 * 是哪个窗口，挑一个就是替他猜。前台 app/窗口名只作元数据，取不到就不写。
 */
export async function captureVoiceScreenContext(): Promise<VoiceScreenCaptureResult> {
  if (!isVoiceScreenContextSupported()) {
    return { ok: false, reason: 'unsupported_platform' };
  }

  let screenshotPath: string;
  try {
    screenshotPath = await captureComputerSurfaceScreenshot();
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown';
    const reason = isLikelyScreenPermissionError(detail) ? 'no_permission' : 'capture_failed';
    logger.warn('screen capture failed', { reason, message: detail });
    return { ok: false, reason, detail };
  }

  let screenshotDataUrl: string;
  try {
    const png = await readFile(screenshotPath);
    // 空文件 = 命令退了 0 但什么都没拍到。当成没拍到，不能拿一张 0 字节的图当成功。
    if (!png.length) {
      logger.warn('screen capture produced an empty file', { screenshotPath });
      return { ok: false, reason: 'capture_failed', detail: 'screenshot file is empty' };
    }
    screenshotDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown';
    logger.warn('screen capture readback failed', { message: detail });
    return { ok: false, reason: 'capture_failed', detail };
  }

  // 前台 app/窗口名是锦上添花（它自己走辅助功能权限，可能单独失败）：
  // 取不到就只是少一行元数据，绝不能把整次采集拖成失败。
  const frontmost = await getFrontmostComputerSurfaceContext().catch(() => null);
  const appName = frontmost?.appName ?? '';

  return {
    ok: true,
    capture: {
      requestId: newRequestId(),
      appName,
      // 没认出 app 就别单独留一个窗口名：那行字自己说不清是谁的窗口。
      windowTitle: appName ? frontmost?.windowTitle ?? null : null,
      screenshotPath,
      screenshotDataUrl,
      // AX/OCR 是热键 appshot 那条链的事（它有明确的目标窗口）。整屏没有「窗口文本」
      // 可读，如实标 none，别让下游以为图文都有。
      axText: null,
      textSource: 'none',
      // ponytail: 整屏截图没有窗口矩形；这个字段只喂 Renderer 的飞入动画，
      // 而这条链根本不飞入。给零值，不为它编一个假的窗口位置。
      windowFrame: { x: 0, y: 0, width: 0, height: 0 },
      capturedAtMs: Date.now(),
    },
  };
}

// ============================================================================
// 采集结果 → 回给通话 brain 的话（文案与失败分类同住：都是「状态不说谎」的一部分）
// ============================================================================

/** 系统设置里那条路。三处失败文案共用一份措辞，免得各写一半各指一处。 */
const SCREEN_PERMISSION_PATH = '「系统设置 → 隐私与安全性 → 屏幕录制」里允许 Neo（勾完要把 Neo 重开一次）';

/**
 * 没拍到时回给通话 brain 的话。
 *
 * 三条共同的硬要求：**先说没拍到**，再说去哪开权限，最后明令不许描述画面。
 * 这条链上最坏的失败不是拍不到，是拍不到却回一句听起来像成功的话——那样模型会顺着
 * 编一段「你屏幕上这个按钮」，而用户根本没法分辨它在瞎说。
 */
export function screenCaptureFailureSpeech(reason: VoiceScreenCaptureFailure): string {
  const deny = '**你没有拿到任何画面**，不许描述屏幕上有什么，也不许说「我看到…」。';
  switch (reason) {
    case 'unsupported_platform':
      return [
        '没能拍到屏幕：这台电脑不支持看屏（这个能力只有 macOS 有）。',
        '现在对用户说：「我在这台机器上看不了你的屏幕，你直接讲给我听吧。」',
        deny,
      ].join('\n');
    case 'no_permission':
      return [
        '没能拍到屏幕：系统没给屏幕录制权限。',
        `现在对用户说：「我没能拍到你的屏幕，要先去${SCREEN_PERMISSION_PATH}，弄好了再叫我。」`,
        deny,
      ].join('\n');
    case 'capture_failed':
      return [
        '没能拍到屏幕：这次截图失败了。',
        `现在对用户说：「我没能拍到你的屏幕，可以再说一次让我重试；一直不行的话，去${SCREEN_PERMISSION_PATH}看看。」`,
        deny,
      ].join('\n');
  }
}

/** 拍到之后回给通话 brain 的话。重点全在「你看不到它」——它确实看不到。 */
export function screenCapturedSpeech(capture: AppshotCapture): string {
  const frontmost = capture.appName
    ? `（前台是 ${capture.appName}${capture.windowTitle ? ` · ${capture.windowTitle}` : ''}）`
    : '';
  return [
    `已经拍下用户此刻的屏幕${frontmost}。`,
    '**这张图不会给你看**：你不知道画面里有什么，不要描述它，也不要说「我看到…」。',
    '它会自动跟着你下一次 delegate_task / steer_task 交给执行侧，由执行侧去看图。',
    '所以：用户要你就这张图做点什么，直接调 delegate_task 把事情派出去（图会自己带上，不用你转述画面）；',
    '他只是先让你知道他在看什么，就说「我拍下来了，你要我做什么？」。',
  ].join('\n');
}
