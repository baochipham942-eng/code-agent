import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('appStore eval center', () => {
  beforeEach(() => {
    useAppStore.setState({
      showEvalCenter: false,
      evalCenterTab: 'replay',
      evalCenterReplaySessionId: null,
      showCapabilityHub: false,
      showLocalOpsPanel: false,
      showKnowledgeMemoryPanel: false,
      showSettings: false,
    });
  });

  it('openEvalCenter 默认落到回放 tab，并互斥关闭其他整窗页', () => {
    useAppStore.setState({ showCapabilityHub: true, showLocalOpsPanel: true, showSettings: true });

    useAppStore.getState().openEvalCenter();

    expect(useAppStore.getState()).toMatchObject({
      showEvalCenter: true,
      evalCenterTab: 'replay',
      evalCenterReplaySessionId: null,
      showCapabilityHub: false,
      showLocalOpsPanel: false,
      showSettings: false,
    });
  });

  it('openEvalCenter 支持验证 tab 与回放会话深链', () => {
    useAppStore.getState().openEvalCenter('validation');
    expect(useAppStore.getState()).toMatchObject({
      showEvalCenter: true,
      evalCenterTab: 'validation',
      evalCenterReplaySessionId: null,
    });

    useAppStore.getState().openEvalCenter('replay', 'session-1');
    expect(useAppStore.getState()).toMatchObject({
      evalCenterTab: 'replay',
      evalCenterReplaySessionId: 'session-1',
    });
  });

  it('setEvalCenterTab 只切 tab，不动深链与互斥状态', () => {
    useAppStore.getState().openEvalCenter('replay', 'session-1');

    useAppStore.getState().setEvalCenterTab('validation');

    expect(useAppStore.getState()).toMatchObject({
      showEvalCenter: true,
      evalCenterTab: 'validation',
      evalCenterReplaySessionId: 'session-1',
    });
  });

  it('clearEvalCenterReplayTarget 清空回放深链', () => {
    useAppStore.getState().openEvalCenter('replay', 'session-1');
    useAppStore.getState().clearEvalCenterReplayTarget();
    expect(useAppStore.getState().evalCenterReplaySessionId).toBeNull();
  });

  it('其他整窗页打开时评测中心被互斥关闭', () => {
    useAppStore.getState().openEvalCenter();
    useAppStore.getState().openCapabilityHub('experts');

    expect(useAppStore.getState()).toMatchObject({
      showEvalCenter: false,
      showCapabilityHub: true,
    });
  });

  it('setShowEvalCenter(false) 只关评测中心', () => {
    useAppStore.getState().openEvalCenter('validation', 'session-1');
    useAppStore.getState().setShowEvalCenter(false);

    expect(useAppStore.getState()).toMatchObject({
      showEvalCenter: false,
      // 关闭不重置 tab/深链，重开时回到上次上下文
      evalCenterTab: 'validation',
    });
  });
});
