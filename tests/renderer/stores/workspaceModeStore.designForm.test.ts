// ---------------------------------------------------------------------------
// workspaceModeStore —— 设计模式会话化收口：designFormOpen 旗标
//  旧全屏表单（网页/演示稿/视频/图片）不再随 workspaceMode==='design' 自动弹出，
//  改由独立 designFormOpen 旗标按需控制。默认 false。
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceModeStore } from '../../../src/renderer/stores/workspaceModeStore';

describe('workspaceModeStore designFormOpen', () => {
  beforeEach(() => {
    useWorkspaceModeStore.setState({ workspaceMode: 'code', designFormOpen: false });
  });

  it('designFormOpen 默认 false', () => {
    expect(useWorkspaceModeStore.getState().designFormOpen).toBe(false);
  });

  it('setDesignFormOpen(true) 打开表单旗标', () => {
    useWorkspaceModeStore.getState().setDesignFormOpen(true);
    expect(useWorkspaceModeStore.getState().designFormOpen).toBe(true);
  });

  it('setDesignFormOpen(false) 关闭表单旗标', () => {
    useWorkspaceModeStore.setState({ designFormOpen: true });
    useWorkspaceModeStore.getState().setDesignFormOpen(false);
    expect(useWorkspaceModeStore.getState().designFormOpen).toBe(false);
  });
});
