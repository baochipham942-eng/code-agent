// 2b：订阅 agent 经 ProposeVideoOps 发来的出视频请求（CANVAS_VIDEO_ASK）→ 设计会话属主闸 →
// 出视频落画布节点 → 回裁决（CANVAS_VIDEO_RESPONSE）。成本已在会话区确认（main 侧），
// 此处只负责落地，不再弹任何确认。
//
// 设计画布 store 是全局单例，但激活态按 session 记录，属主也绑定 session。agent 自动进画布
// 只会设置 per-session 激活态并认领画布；因此落地闸必须复用统一的
// designCanvasActive 判据，严格校验「当前 session 已设计激活 + 画布属主是当前 session」。
import { useEffect } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CanvasVideoRequest, CanvasVideoDecision } from '@shared/contract';
import type { CanvasNode } from './designCanvasTypes';
import ipcService from '../../services/ipcService';
import { useDesignCanvasStore } from './designCanvasStore';
import { isDesignCanvasActiveForSession } from './designCanvasSessionGate';
import { useSessionStore } from '../../stores/sessionStore';
import { generateVideoToCanvas } from './designProposedVideoGen';

export function useCanvasVideoRequest(): void {
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.CANVAS_VIDEO_ASK,
      async (request: CanvasVideoRequest) => {
        const respond = (decision: CanvasVideoDecision): void => {
          void ipcService.invoke(IPC_CHANNELS.CANVAS_VIDEO_RESPONSE, decision);
        };

        // 设计会话属主闸（fail-closed）：无主、属主非当前会话、或请求来自其他会话均拒绝。
        // agent 自动认领画布时仍可正常落地视频。
        const currentSessionId = useSessionStore.getState().currentSessionId;
        const requestMatchesCurrentSession = !request.sessionId || request.sessionId === currentSessionId;
        if (!requestMatchesCurrentSession || !isDesignCanvasActiveForSession(currentSessionId)) {
          respond({ requestId: request.requestId, status: 'rejected', error: '当前不在设计画布会话，已隔离拒绝' });
          return;
        }

        // i2v：解析底图节点（须存在且未淘汰）。
        let baseNode: CanvasNode | undefined;
        if (request.mode === 'i2v') {
          baseNode = useDesignCanvasStore
            .getState()
            .nodes.find((n) => n.id === request.baseNodeId && !n.discarded);
          if (!baseNode) {
            respond({ requestId: request.requestId, status: 'failed', error: '找不到底图节点（baseNodeId）' });
            return;
          }
        }

        const result = await generateVideoToCanvas({
          mode: request.mode,
          modelId: request.model,
          durationSec: request.durationSec,
          prompt: request.prompt,
          baseNode,
          commandId: request.commandId,
        });

        if (result.ok) {
          respond({
            requestId: request.requestId,
            status: 'applied',
            costCny: result.costCny,
            durationSec: result.durationSec,
            actualModel: result.actualModel,
            nodeId: result.nodeId,
          });
        } else {
          respond({ requestId: request.requestId, status: 'failed', error: result.error });
        }
      },
    );
    return unsubscribe;
  }, []);
}
