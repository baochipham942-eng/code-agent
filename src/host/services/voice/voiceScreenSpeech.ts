// ============================================================================
// 看屏结果 → 回给通话 brain 的话（Appshots Phase 3）
//
// 单独一个文件的理由和 voiceScreenContext 相反：采集模块在测试里被整块替掉
// （CI 没有屏幕权限），而这些文案恰恰是测试要逐句断言的内容——住在被 mock 的
// 模块里等于测试自己把被测物换掉。文案与采集分居，mock 采集不再连坐文案。
// ============================================================================

import type { AppshotCapture } from '../../../shared/contract/appshot';
import type { VoiceScreenCaptureFailure } from './voiceScreenContext';

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
