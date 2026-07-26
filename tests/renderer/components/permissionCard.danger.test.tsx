// 「这操作本身危险」与「这次必须你亲手点」是两个信号，卡上必须分开。
//
// 此前 PermissionCard 把 forceConfirm 直接当危险，而 forceConfirm 在 host 侧同时由
// confirmationGate 的真风险评估和 readOnly / 通话抬严这类**流程性**要求置位。净效果：
// 往工作目录写个 hello 也顶着红框和「这是一个危险命令」，红卡成了常态。
//
// 本门钉两侧都不许再串：流程性强制确认不染危险色，真危险照样红；
// 而 forceConfirm 该有的职责（不许「会话/始终」这类常驻授权）两种情况下都保住。

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

const storeState = vi.hoisted(() => ({ request: null as ContractPermissionRequest | null }));

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

const DANGER_COPY = '这是一个危险命令';
const DANGER_TITLE = '危险操作';
const STANDING_GRANT = '始终';

function render(request: ContractPermissionRequest): string {
  storeState.request = request;
  return renderToStaticMarkup(React.createElement(PermissionCard));
}

describe('PermissionCard 危险度与强制确认分离', () => {
  it('档位要求逐次确认的写文件：不染危险色、不说危险命令，但收起常驻授权', () => {
    const html = render({
      id: 'req-1',
      tool: 'Write',
      type: 'file_write',
      details: { path: '/Users/x/work/memo.txt' },
      timestamp: 1,
      forceConfirm: true,
      reason: '只读探索模式：写入操作需要用户确认',
    });

    expect(html).not.toContain(DANGER_COPY);
    expect(html).not.toContain(DANGER_TITLE);
    expect(html).not.toContain('border-red-500');
    // 原本的类型配色要留住——写文件就是写文件
    expect(html).toContain('创建文件');
    // 但 forceConfirm 的职责不能松：不许「会话 / 始终」这类常驻授权
    expect(html).not.toContain(STANDING_GRANT);
    // 原因还是要如实说出来
    expect(html).toContain('只读探索模式：写入操作需要用户确认');
  });

  it('host 判定为高风险（dangerLevel=danger）时照样是红卡', () => {
    const html = render({
      id: 'req-2',
      tool: 'Write',
      type: 'file_write',
      details: { path: '/etc/hosts' },
      timestamp: 1,
      forceConfirm: true,
      dangerLevel: 'danger',
    });

    expect(html).toContain(DANGER_COPY);
    expect(html).toContain(DANGER_TITLE);
    expect(html).toContain('border-red-500');
    expect(html).not.toContain(STANDING_GRANT);
  });

  it('危险命令类型照旧是红卡（旧路径不变）', () => {
    const html = render({
      id: 'req-3',
      tool: 'Bash',
      type: 'dangerous_command',
      details: { command: 'rm -rf /tmp/x' },
      timestamp: 1,
    });

    expect(html).toContain(DANGER_COPY);
    expect(html).toContain(DANGER_TITLE);
  });

  it('普通写文件（既不危险也不强制）保留常驻授权入口', () => {
    const html = render({
      id: 'req-4',
      tool: 'Write',
      type: 'file_write',
      details: { path: '/Users/x/work/memo.txt' },
      timestamp: 1,
    });

    expect(html).not.toContain(DANGER_COPY);
    expect(html).toContain(STANDING_GRANT);
  });
});
