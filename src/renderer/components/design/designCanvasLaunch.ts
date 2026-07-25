// 用户主动打开设计画布时的认领动作：视图入口（WorkbenchTabs）和快捷键（useKeyboardShortcuts）
// 必须走同一段逻辑，否则键盘打开的画布不属于当前会话，agent 的提议会被跨会话闸门拒掉。
import { useDesignCanvasStore } from './designCanvasStore';
import { saveCanvasDoc } from './designCanvasPersistence';

export function claimDesignCanvasForSession(sessionId: string): void {
  useDesignCanvasStore.getState().markSessionDesignActive(sessionId);
  const canvasState = useDesignCanvasStore.getState();
  if (canvasState.ownerSessionId && canvasState.ownerSessionId !== sessionId && canvasState.runDir) {
    // 换主前先把上一个会话的画布存档落盘，别把它的内容丢在内存里。
    void saveCanvasDoc(canvasState.runDir, canvasState.toDoc());
  }
  useDesignCanvasStore.getState().claimCanvasForSession(sessionId);
}
