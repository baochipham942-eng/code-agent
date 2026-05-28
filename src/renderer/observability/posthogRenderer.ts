// ============================================================================
// PostHog (Renderer) — 浏览器/Tauri webview 端产品行为分析
// ============================================================================
//
// person_profiles: 'identified_only' — 默认匿名不创建 person profile，省 MAU 配额；
//   登录后调 identifyRenderer(userId) 才升级为 identified person。
// autocapture 关闭 —— 事件由代码显式 track，避免噪音 & 隐私意外。
//
// ============================================================================

import posthog from 'posthog-js';

let initialized = false;
let enabled = true;

export function initPostHogRenderer(): void {
  if (initialized) return;
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key) {
    console.info('[PostHog] renderer disabled: no VITE_POSTHOG_KEY');
    return;
  }
  const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';
  posthog.init(key, {
    api_host: host,
    person_profiles: 'identified_only',
    capture_pageview: false, // SPA 路由自己控制
    autocapture: false,
  });
  initialized = true;
  console.info('[PostHog] renderer initialized');
}

export function setPostHogEnabled(value: boolean): void {
  enabled = value;
  if (initialized) {
    if (value) posthog.opt_in_capturing();
    else posthog.opt_out_capturing();
  }
}

export function trackRenderer(event: string, properties?: Record<string, unknown>): void {
  if (!initialized || !enabled) return;
  posthog.capture(event, properties);
}

export function identifyRenderer(distinctId: string, properties?: Record<string, unknown>): void {
  if (!initialized || !enabled) return;
  posthog.identify(distinctId, properties);
}

export function resetRendererIdentity(): void {
  if (!initialized) return;
  posthog.reset();
}
