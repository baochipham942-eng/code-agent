// ============================================================================
// B7 外放回声提示（方案 §12.1 的最小交互形态）
//
// 首次开启通话且未检测到耳机类输出设备时提示一次；「不再提示」持久化。
// enumerateDevices 拿不到 label（未授权/不支持）= 检测不了 = 一律首次提示。
// 不做增益压制、不做 VAD 收紧（Phase 2 议题）。
// ============================================================================

import { toast } from '../hooks/useToast';

const DISMISS_KEY = 'code-agent:voice-echo-hint-dismissed';

const HEADPHONE_RE = /headphone|headset|earphone|earbud|airpods| buds|耳机|耳塞/i;

function isDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function dismiss(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // localStorage 不可写就当本次已提示，不纠缠
  }
}

/** 输出设备里是否有耳机类；检测不了（异常/无 label）返回 false = 按未检测到处理。 */
export async function hasHeadphoneOutput(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audiooutput')
      .some((device) => HEADPHONE_RE.test(device.label));
  } catch {
    return false;
  }
}

/**
 * 通话进入 live 后调用。只在「未点过不再提示 + 没检测到耳机」时弹 toast；
 * 弹过即写 dismiss——本批语义是「首次提示」，不随每次通话重复打扰。
 */
export async function maybeShowSpeakerEchoHint(text: { message: string; dontShowAgain: string }): Promise<void> {
  if (isDismissed()) return;
  if (await hasHeadphoneOutput()) return;
  dismiss();
  toast.warning(text.message, { label: text.dontShowAgain, onClick: dismiss }, 8000);
}
