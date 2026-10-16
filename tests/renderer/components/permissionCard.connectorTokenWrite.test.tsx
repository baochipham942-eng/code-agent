// @vitest-environment jsdom
// N-HTTPREQ-CONNECTOR-CARD-DISCLOSE：http_request 携带已连接连接器令牌的写调用，
// 审批卡必须点名连接器与「以你的身份写入」，并披露 METHOD/路径与脱敏后的请求内容；
// 不带 connectorTokenAttached 的普通 http_request 一字不变（仍问「允许访问 URL？」）。
// http_request 不是可编辑工具（rawArgs 恒 undefined），走的就是 RequestDetails 非
// rawArgs 分支——boundary 披露块也在该分支断言。PermissionCard 是 store 连接型组件
// （permissionCard.externalScope.test.tsx 同款 mock）。

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

const storeState = vi.hoisted(() => ({
  request: null as ContractPermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh }, { en }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return { useI18n: () => ({ t: storeState.language === 'en' ? en : zh, language: storeState.language }) };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: storeState.request,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { currentSessionId: string | null }) => unknown) =>
    selector({ currentSessionId: null }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

const { PermissionCard } = await import('../../../src/renderer/components/PermissionDialog/PermissionCard');

// connectorTokenWrite.ts 对 http_request 令牌写构造的请求形状（host 侧同源字段）。
const connectorTokenWriteRequest = (overrides?: Partial<ContractPermissionRequest>): ContractPermissionRequest => ({
  id: 'permission-httpreq-feishu-write',
  sessionId: 'session-1',
  forceConfirm: true,
  type: 'network',
  tool: 'http_request',
  details: {
    url: 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
    method: 'POST',
    body: '{"receive_id":"oc_x","msg_type":"text","content":"{\\"text\\":\\"明天 10 点开会\\"}"}',
    connectorTokenAttached: true,
  },
  reason: '要向 飞书 发起写入请求，你的授权将附加到本次请求上，需要你确认',
  boundary: {
    id: 'connector.external_write',
    reason: '要向 飞书 发起写入请求，你的授权将附加到本次请求上，需要你确认',
    reasonEn: 'A write request to 飞书 will attach your authorization to this request; confirmation required',
    connectorName: '飞书',
    connectorNameEn: '飞书',
  },
  timestamp: 1,
  ...overrides,
});

function renderCard(request: ContractPermissionRequest): HTMLElement {
  storeState.request = request;
  const { container } = render(React.createElement(PermissionCard));
  return container;
}

describe('PermissionCard 连接器令牌写披露（http_request + connectorTokenAttached）', () => {
  afterEach(() => {
    cleanup();
    storeState.language = 'zh';
    storeState.request = null;
  });

  it('中文卡点名「将以你的飞书身份写入」，出 METHOD/路径与隐私边界（非 rawArgs 分支）', () => {
    renderCard(connectorTokenWriteRequest());
    const card = screen.getByTestId('permission-card');
    expect(card.textContent).toContain('Neo 将以你的飞书身份写入，允许吗？');
    // 方法 + 路径行：只显路径不带 query（query 里的 receive_id_type 不进这行）
    const methodPath = screen.getByTestId('connector-write-method-path');
    expect(methodPath.textContent).toContain('POST');
    expect(methodPath.textContent).toContain('/open-apis/im/v1/messages');
    expect(methodPath.textContent).not.toContain('receive_id_type');
    // 非 rawArgs 分支的 boundary 披露块（数据会离开本机并写入飞书）
    expect(card.textContent).toContain('数据会离开本机并写入飞书');
    // 旧问句不再出现
    expect(card.textContent).not.toContain('允许访问');
  });

  it('英文卡问 "Neo will write to 飞书 as you. Allow?" 并出同款披露', () => {
    storeState.language = 'en';
    renderCard(connectorTokenWriteRequest());
    const card = screen.getByTestId('permission-card');
    expect(card.textContent).toContain('Neo will write to 飞书 as you. Allow?');
    expect(screen.getByTestId('connector-write-method-path').textContent).toContain('POST');
    // 英文侧 connectorNameEn 缺英文名（OAuth descriptor 只有 displayName），复用 zh 名
    expect(card.textContent).not.toContain('Allow accessing');
  });

  it('展开「请求内容」看到脱敏正文：Bearer sk-… 令牌永不进 DOM', () => {
    const request = connectorTokenWriteRequest();
    request.details.body = '{"receive_id":"oc_x","content":"{\\"text\\":\\"明天 10 点开会\\"}","auth":"Bearer sk-abc123def456ghi789"}';
    renderCard(request);

    // 默认收起：正文不在 DOM
    expect(screen.queryByTestId('connector-write-body')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '请求内容' }));

    const body = screen.getByTestId('connector-write-body');
    expect(body.textContent).toContain('明天 10 点开会');
    expect(body.textContent).toContain('[REDACTED]');
    // 原始令牌串在整个文档里都不出现（收起/展开两个状态都验）
    expect(document.body.textContent).not.toContain('sk-abc123def456ghi789');
  });

  it('普通 http_request（无 connectorTokenAttached）仍问「允许访问 {url}？」且不出披露块', () => {
    renderCard({
      id: 'permission-httpreq-plain',
      type: 'network',
      tool: 'http_request',
      details: { url: 'https://api.example.com/data', method: 'GET' },
      timestamp: 1,
    });
    const card = screen.getByTestId('permission-card');
    expect(card.textContent).toContain('允许访问 https://api.example.com/data？');
    expect(screen.queryByTestId('connector-write-disclosure')).toBeNull();
    expect(card.textContent).not.toContain('以你的');
  });
});
