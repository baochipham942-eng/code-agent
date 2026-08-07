// @vitest-environment jsdom
// ============================================================================
// 渲染反馈环回归（2026-07-30 P0）
// ============================================================================
// 事故：打开任意会话时整个 app 崩进 App 级 ErrorBoundary，报 React #185
// （Maximum update depth exceeded）。崩溃栈落在 react-virtuoso 上，但那是被冤枉的
// ——真正的发动机在这里：
//
//   artifactIds 之前 memo 在 baseItems 的**身份**上，而 baseItems 的上游
//   （currentTurnArtifacts ← 当前轮投影）每渲染都换身份。于是 artifactIds 每渲染
//   都是新数组 → 下面那条 effect 每渲染重跑 → setArtifactIssues({}) 每渲染塞一个
//   新对象（新引用，React 无法 bail out）→ 立刻又触发渲染 → 满速自激。
//   实测把 App 拖到 235 次/秒重渲染，最终打满 React 50 层嵌套更新上限。
//
// 守的不变量：**上游身份变、但 artifact id 集合没变时，那条 effect 不许重跑**。
// 用 getArtifactIssuesByArtifactId 的调用次数当探针——effect 每重跑一次就多打一次，
// 既是渲染环的证据，也是对 host 的请求风暴的证据。
// ============================================================================
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getArtifactIssuesByArtifactId: vi.fn(),
  buildWorkspacePreviewSections: vi.fn(),
  useCurrentTurnArtifactOwnership: vi.fn(),
}));

vi.mock('../../../src/renderer/services/projectClient', () => ({
  getArtifactIssuesByArtifactId: mocks.getArtifactIssuesByArtifactId,
}));

vi.mock('../../../src/renderer/utils/workspacePreview', () => ({
  buildWorkspacePreviewSections: mocks.buildWorkspacePreviewSections,
}));

vi.mock('../../../src/renderer/hooks/useCurrentTurnArtifactOwnership', () => ({
  useCurrentTurnArtifactOwnership: mocks.useCurrentTurnArtifactOwnership,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({ workingDirectory: '/tmp/work', pendingPermissionRequest: null }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ messages: [], currentSessionId: 'session-1', sessionDesignBriefs: new Map() }),
}));

import { useWorkspacePreviewModelState } from '../../../src/renderer/hooks/useWorkspacePreviewModel';

// 环一旦回来，jsdom 里是**真的停不下来**（每次渲染 deps 都变，React 认为是合法的
// 依赖变化，不会触发它自己的 50 层保护）。不设上限的话回归表现为 worker 跑满内存
// 被杀、CI 超时——实测 144 秒。这个计数器把它变成一条秒级、说人话的断言失败。
const RENDER_BUDGET = 200;
let renderCount = 0;

function Probe(): React.ReactElement {
  renderCount += 1;
  if (renderCount > RENDER_BUDGET) {
    throw new Error(`渲染自激环回归：${RENDER_BUDGET} 次渲染后仍未收敛`);
  }
  useWorkspacePreviewModelState();
  return <div data-testid="probe" />;
}

beforeEach(() => {
  renderCount = 0;
  mocks.getArtifactIssuesByArtifactId.mockReset();
  mocks.getArtifactIssuesByArtifactId.mockResolvedValue({});
  // 复刻事故现场：上游每次调用都返回**内容相同但身份全新**的对象。
  mocks.useCurrentTurnArtifactOwnership.mockImplementation(() => ({
    turnNumber: 1,
    artifactOwnership: {},
  }));
  mocks.buildWorkspacePreviewSections.mockImplementation(() => ({
    items: [{ id: 'item-1', kind: 'file', revision: { artifactId: 'artifact-1' } }],
    materialItems: [],
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useWorkspacePreviewModelState 不因上游换身份而自激', () => {
  it('id 集合不变时，重复渲染不重复拉 artifact issues', () => {
    const view = render(<Probe />);
    const afterFirst = mocks.getArtifactIssuesByArtifactId.mock.calls.length;

    // 连续重渲染：上游每次都给新身份对象，但 artifact id 集合始终是 {artifact-1}
    for (let i = 0; i < 5; i++) view.rerender(<Probe />);

    expect(afterFirst).toBe(1);
    expect(mocks.getArtifactIssuesByArtifactId).toHaveBeenCalledTimes(1);
  });

  it('id 集合真的变了才重新拉一次', () => {
    const view = render(<Probe />);
    expect(mocks.getArtifactIssuesByArtifactId).toHaveBeenCalledTimes(1);

    mocks.buildWorkspacePreviewSections.mockImplementation(() => ({
      items: [{ id: 'item-2', kind: 'file', revision: { artifactId: 'artifact-2' } }],
      materialItems: [],
    }));
    view.rerender(<Probe />);

    expect(mocks.getArtifactIssuesByArtifactId).toHaveBeenCalledTimes(2);
    expect(mocks.getArtifactIssuesByArtifactId).toHaveBeenLastCalledWith(['artifact-2'], { limit: 20 });
  });

  it('没有 artifact 时也不许每渲染重置一次状态（空集合同样要稳定）', () => {
    mocks.buildWorkspacePreviewSections.mockImplementation(() => ({
      items: [{ id: 'item-1', kind: 'question_form' }],
      materialItems: [],
    }));

    const view = render(<Probe />);
    for (let i = 0; i < 5; i++) view.rerender(<Probe />);

    // 空集合走的是 setArtifactIssues({}) 早退分支，压根不该打网络
    expect(mocks.getArtifactIssuesByArtifactId).not.toHaveBeenCalled();
  });
});
