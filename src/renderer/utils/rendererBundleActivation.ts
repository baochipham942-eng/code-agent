import type { RendererBundleActiveStatus, RendererBundleStatus } from '@shared/contract';

export interface RendererBundleReloadBlockInput {
  runningSessionCount: number;
  processingSessionCount: number;
  isProcessing: boolean;
  activeTaskCount?: number;
  backgroundTaskCount?: number;
}

export interface RendererBundleAutoReloadInput extends RendererBundleReloadBlockInput {
  status: RendererBundleStatus | null;
  loadedBundle: RendererBundleActiveStatus | null;
  focusedElement?: Element | null;
  documentHidden?: boolean;
  idleMs: number;
  minIdleMs: number;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

export function readLoadedRendererBundleStatus(): RendererBundleActiveStatus | null {
  if (typeof window === 'undefined') return null;
  const value = (window as unknown as {
    __CODE_AGENT_RENDERER_BUNDLE__?: RendererBundleActiveStatus | null;
  }).__CODE_AGENT_RENDERER_BUNDLE__;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.version !== 'string' || typeof value.contentHash !== 'string') return null;
  return { version: value.version, contentHash: value.contentHash };
}

export function hasRendererBundlePendingActivation(
  status: RendererBundleStatus | null,
  loadedBundle: RendererBundleActiveStatus | null,
): boolean {
  if (!status) return false;
  const target = status.disabled ? null : status.activeBundle;
  return (
    (target?.version ?? null) !== (loadedBundle?.version ?? null) ||
    (target?.contentHash ?? null) !== (loadedBundle?.contentHash ?? null)
  );
}

export function getRendererBundleActivationText(
  status: RendererBundleStatus | null,
  loadedBundle: RendererBundleActiveStatus | null,
): string | null {
  if (!hasRendererBundlePendingActivation(status, loadedBundle)) return null;
  const target = status?.disabled ? null : status?.activeBundle ?? null;
  return target
    ? `刷新界面后使用 v${target.version}`
    : '刷新界面后回到包内版本';
}

export function getRendererBundleReloadBlockedReason(input: RendererBundleReloadBlockInput): string | null {
  if (input.runningSessionCount > 0) {
    return `有 ${input.runningSessionCount} 个会话正在运行，完成后再刷新`;
  }
  if (input.backgroundTaskCount && input.backgroundTaskCount > 0) {
    return `有 ${input.backgroundTaskCount} 个后台任务正在运行，完成后再刷新`;
  }
  if (
    input.activeTaskCount && input.activeTaskCount > 0 ||
    input.processingSessionCount > 0 ||
    input.isProcessing
  ) {
    return '任务执行中，完成后再刷新';
  }
  return null;
}

export function isRendererBundleTextEntryElement(element: Element | null | undefined): boolean {
  if (!element) return false;
  const htmlElement = element as HTMLElement;
  if (htmlElement.isContentEditable) return true;
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'textarea') return true;
  if (tagName !== 'input') return false;
  const type = ((element as HTMLInputElement).type || 'text').toLowerCase();
  return !NON_TEXT_INPUT_TYPES.has(type);
}

export function getRendererBundleAutoReloadBlockedReason(input: RendererBundleAutoReloadInput): string | null {
  if (!hasRendererBundlePendingActivation(input.status, input.loadedBundle)) {
    return 'no-pending-renderer-bundle';
  }
  const workBlockedReason = getRendererBundleReloadBlockedReason(input);
  if (workBlockedReason) return workBlockedReason;
  if (input.documentHidden) {
    return '页面未激活，暂不刷新';
  }
  if (isRendererBundleTextEntryElement(input.focusedElement)) {
    return '正在输入，暂不刷新';
  }
  if (input.idleMs < input.minIdleMs) {
    return '页面刚有操作，等待空闲';
  }
  return null;
}

export function shouldAutoReloadRendererBundle(input: RendererBundleAutoReloadInput): boolean {
  return getRendererBundleAutoReloadBlockedReason(input) === null;
}
