import { createLogger } from '../infra/logger';
import { getSessionManager } from '../infra/sessionManager';

const logger = createLogger('VoiceSession');

/**
 * 会话级标记：这条会话用过实时语音。侧栏据此在标题旁挂一个语音图标
 * （产品负责人 2026-07-27）——是**身份**不是状态，所以写在会话 metadata 上，
 * 不去每次列会话时翻消息。
 *
 * 用 patchSessionMetadata 而不是 updateSession({metadata})：后者是整份覆盖，
 * 会把别人写的 key 冲掉。失败只告警不影响通话。
 */
export function markSessionHadLiveVoice(neoSessionId: string): void {
  void getSessionManager()
    .patchSessionMetadata(neoSessionId, { hadLiveVoice: true }, { notifyRenderer: true })
    .catch((err: unknown) => {
      logger.warn('failed to mark session as live-voice', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    });
}

/**
 * 通话生命周期事件（observer-only）：暂停/结束要让 agent 侧可编排，
 * 典型用例是会议形态的通话结束后问一句「要我整理一下吗」。
 *
 * 三条纪律：
 * 1. **fire-and-forget**：hook 是用户脚本，不能让它拖住建连或收尾，也不能把通话搞挂；
 * 2. **懒加载 task 依赖树**：建连是关键路径，不为一个可能没人订阅的事件把它拉进来
 *    （同 voiceAgentCoordinator 的 taskManager() 先例）；
 * 3. **重连不重复发 started**：宽限窗内接回来走 reattachVoiceClient，不经过这里。
 */
export function emitVoiceCallHook(
  event: 'VoiceCallStarted' | 'VoiceCallPaused' | 'VoiceCallEnded',
  params: { voiceCallId: string; sessionId: string; durationSec: number; workItemCount?: number; reason?: string },
): void {
  void (async () => {
    try {
      const { getTaskManager } = await import('../../task');
      // 已存在的 manager 挂着 onTrigger / aiCompletion，优先复用；纯语音会话没有
      // orchestrator 时才临时创建，避免为了观察事件拉起整棵 agent 运行时。
      let hooks = getTaskManager()?.getOrchestrator(params.sessionId)?.getHookManager?.();
      if (!hooks) {
        try {
          const session = await getSessionManager().getSession(params.sessionId, 1);
          const { createHookManager } = await import('../../hooks');
          hooks = createHookManager({
            workingDirectory: session?.workingDirectory?.trim() || process.cwd(),
          });
          await hooks.initialize();
          if (!hooks.hasHooksFor(event)) return;
        } catch (err) {
          logger.info('voice call hook skipped: existing and temporary hook managers unavailable', {
            event,
            sessionId: params.sessionId,
            message: err instanceof Error ? err.message : 'unknown',
          });
          return;
        }
      }
      await hooks.triggerVoiceCall(event, params);
    } catch (err) {
      logger.warn('voice call hook failed', { event, message: err instanceof Error ? err.message : 'unknown' });
    }
  })();
}
