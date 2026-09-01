export type UiSlotKind = 'single' | 'list' | 'keyed' | 'chain';
export type UiSlotScope = 'root' | 'session';
export type UiSlotReplaceRisk = 'none' | 'shadows-shipped-ui';

export interface UiSlotContract {
  kind: UiSlotKind;
  scope: UiSlotScope;
  props: Readonly<Record<string, string>>;
  replaceRisk: UiSlotReplaceRisk;
}

/**
 * ADR-062 首批公开契约。这里仅登记可申请的座位及其 props 形状；
 * 产品组件要到 L2 显式调用 declareSlot 后，座位才会在运行时出现。
 */
export const UI_SLOT_CONTRACTS = Object.freeze({
  'nav.account.item': Object.freeze({
    kind: 'list', scope: 'root', props: Object.freeze({ onClose: '() => void' }), replaceRisk: 'none',
  }),
  'hub.tab': Object.freeze({
    kind: 'list', scope: 'root', props: Object.freeze({ active: 'boolean' }), replaceRisk: 'none',
  }),
  'settings.section': Object.freeze({
    kind: 'list', scope: 'root', props: Object.freeze({}), replaceRisk: 'none',
  }),
  'workspace.page': Object.freeze({
    kind: 'keyed', scope: 'root', props: Object.freeze({}), replaceRisk: 'none',
  }),
  'shell.overlay': Object.freeze({
    kind: 'list', scope: 'root', props: Object.freeze({}), replaceRisk: 'none',
  }),
  'conversation.turnTail': Object.freeze({
    kind: 'chain',
    scope: 'session',
    props: Object.freeze({ sessionId: 'string', turnId: 'string' }),
    replaceRisk: 'none',
  }),
} as const satisfies Record<string, UiSlotContract>);

export type UiSlotName = keyof typeof UI_SLOT_CONTRACTS;
