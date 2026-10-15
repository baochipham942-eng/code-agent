// ============================================================================
// useConnectorCardFocus —— 连接器深链落点（N-ONBOARD-CONNECTOR-LANDING）
// settingsCapabilityFocus.kind === 'connector' 时等目标卡片真渲染出来
// （SaaS 先 skeleton、本机卡要先过 inventory 加载），scrollIntoView 并挂
// 高亮环；focus 被清掉（横幅关闭/换目标）时撤环。DOM 定位走卡片既有
// data-testid 锚点，sections 组件零侵入——MCPSettings.tsx 已 900+ 行不再加载体。
// ============================================================================

import { useEffect } from 'react';
import type { SettingsCapabilityFocus } from '../stores/appStore';
import type { useI18n } from './useI18n';
import { interpolate } from '../i18n/interpolate';

type I18nText = ReturnType<typeof useI18n>['t'];

const CONNECTOR_CARD_POLL_MS = 100;
const CONNECTOR_CARD_WAIT_MS = 15_000;
const CONNECTOR_FOCUS_RING_CLASS = 'connector-focus-ring';

function findConnectorCardElement(connectorId: string): HTMLElement | null {
  const selector = [
    `[data-testid="native-connector-card-${CSS.escape(connectorId)}"]`,
    `[data-testid="saas-connector-${CSS.escape(connectorId)}"]`,
  ].join(', ');
  return document.querySelector<HTMLElement>(selector);
}

/** 横幅只展示显示名：引导行命名 → 本机卡标签 → SaaS provider 名 → 兜底 id */
function getConnectorFocusDisplayName(id: string, t: I18nText): string {
  const onboardingRow = t.onboarding.connectorRows[id as keyof typeof t.onboarding.connectorRows];
  if (onboardingRow) return onboardingRow.name;
  const nativeLabel = t.settings.nativeConnectors.grid.labels[
    id as keyof typeof t.settings.nativeConnectors.grid.labels
  ];
  if (nativeLabel) return nativeLabel;
  // saasConnectors.providers 的键不带连字符（google-calendar → googleCalendar）
  const saasKey = id === 'google-calendar' ? 'googleCalendar' : id;
  const saasName = t.settings.saasConnectors.providers[
    saasKey as keyof typeof t.settings.saasConnectors.providers
  ];
  if (saasName) return saasName;
  return id;
}

/** 落页横幅文案：引导来源用引导措辞（显示名），会话页保持原前缀但同样只展示显示名 */
export function getConnectorFocusBannerText(focus: SettingsCapabilityFocus, t: I18nText): string {
  const name = getConnectorFocusDisplayName(focus.id, t);
  if (focus.source === 'onboarding') {
    return interpolate(t.onboarding.focusFromOnboarding, { name });
  }
  return `${t.settings.mcp.focusPromptPrefix}${name}`;
}

export function useConnectorCardFocus(focus: SettingsCapabilityFocus | null): void {
  const connectorFocus = focus?.kind === 'connector' ? focus : null;
  const connectorId = connectorFocus?.id ?? null;
  const nonce = connectorFocus?.nonce ?? null;

  useEffect(() => {
    if (!connectorId) return;
    let decorated: HTMLElement | null = null;
    let timer: number | null = null;
    const startedAt = Date.now();
    const settle = () => {
      const card = findConnectorCardElement(connectorId);
      if (!card) {
        // 等不到就放弃（卡片分区加载失败/被裁剪），不留悬挂定时器
        if (timer !== null && Date.now() - startedAt >= CONNECTOR_CARD_WAIT_MS) {
          window.clearInterval(timer);
          timer = null;
        }
        return;
      }
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      decorated = card;
      card.setAttribute('data-connector-focus', 'true');
      card.classList.add(CONNECTOR_FOCUS_RING_CLASS);
      card.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    };
    settle();
    if (!decorated) timer = window.setInterval(settle, CONNECTOR_CARD_POLL_MS);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      decorated?.classList.remove(CONNECTOR_FOCUS_RING_CLASS);
      decorated?.removeAttribute('data-connector-focus');
    };
  }, [connectorId, nonce]);
}
