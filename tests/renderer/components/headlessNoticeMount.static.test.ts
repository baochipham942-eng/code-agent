// ============================================================================
// headless 通知组件的「挂载」静态契约门
// ----------------------------------------------------------------------------
// 这一族组件（ProviderStatusNotice / BudgetAlertNotice / AgentNoticeToast）没有可见
// DOM，全部价值在于「被挂进 App 树里、订阅到自己那条 IPC 通道」。它们的既有测试只覆盖
// 格式化函数——**把 <XxxNotice /> 从 App.tsx 里删掉，所有测试照样全绿，而用户从此再也
// 收不到任何提示**。这正是本轮在修的「静默丢弃族」bug 的形状：
// `notification` AgentEvent 有 25 个生产发送点、渲染侧零消费者，静默了不知道多久。
//
// 所以这道门只钉一件事：**通路的最后一环存在**。三个组件必须同时被 import 且被渲染。
// 参照「门必须能报告自己的盲区」：清单为空或锚点失效时报红，不静默通过。
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const APP_TSX = path.resolve(__dirname, '../../../src/renderer/App.tsx');

/** 必须挂在 App 树里的 headless 通知组件。新增同族组件时加进来。 */
const HEADLESS_NOTICE_COMPONENTS = [
  'ProviderStatusNotice',
  'BudgetAlertNotice',
  'AgentNoticeToast',
] as const;

describe('headless 通知组件必须真的挂在 App 树里', () => {
  const app = fs.readFileSync(APP_TSX, 'utf8');

  it('清单非空（防止有人清空清单让门变成永真）', () => {
    expect(HEADLESS_NOTICE_COMPONENTS.length).toBeGreaterThan(0);
  });

  it.each(HEADLESS_NOTICE_COMPONENTS)('%s 被 import 且被渲染', (name) => {
    expect(app, `${name} 未在 App.tsx 里 import`).toMatch(
      new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`),
    );
    // 锚在 JSX 渲染语法上，而不是裸符号名——否则只留 import、删掉 <Xxx /> 也能骗过门
    expect(app, `${name} 已 import 但没有 <${name} /> 渲染点`).toMatch(
      new RegExp(`<${name}\\s*/>`),
    );
  });
});
