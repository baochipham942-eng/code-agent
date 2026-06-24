// 2b：订阅 agent 经 ProposeVideoOps 发来的出视频请求（CANVAS_VIDEO_ASK）→ 属主闸 →
// 出视频落画布节点 → 回裁决（CANVAS_VIDEO_RESPONSE）。成本已在会话区确认（main 侧），
// 此处只负责属主隔离 + 落地，不再弹任何确认。属主闸逻辑与 useCanvasProposalReview 一致。
import { useEffect } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CanvasVideoRequest, CanvasVideoDecision } from '@shared/contract';
import type { CanvasNode } from './designCanvasTypes';
import ipcService from '../../services/ipcService';
import { useDesignCanvasStore } from './designCanvasStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { generateVideoToCanvas } from './designProposedVideoGen';

export function useCanvasVideoRequest(): void {
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.CANVAS_VIDEO_ASK,
      async (request: CanvasVideoRequest) => {
        const respond = (decision: CanvasVideoDecision): void => {
          void ipcService.invoke(IPC_CHANNELS.CANVAS_VIDEO_RESPONSE, decision);
        };

        // 属主闸（fail-closed）+ 意图驱动自动认领——与 useCanvasProposalReview 同一口径。
        const cs = useDesignCanvasStore.getState();
        if (request.sessionId) {
          const currentSessionId = useSessionStore.getState().currentSessionId;
          if (cs.ownerSessionId === null && request.sessionId === currentSessionId) {
            useSessionStore.getState().markSessionDesignActive(request.sessionId);
            useDesignCanvasStore.getState().claimCanvasForSession(request.sessionId);
          } else if (useDesignCanvasStore.getState().ownerSessionId !== request.sessionId) {
            // 画布属另一会话（或无主但非当前会话）→ 隔离拒绝，绝不在别人画布烧钱出视频。
            respond({ requestId: request.requestId, status: 'rejected', error: '画布当前不属于该会话，已隔离拒绝' });
            return;
          }
        }

        // UX：自动展开+聚焦设计画布 tab，让用户看到出视频忙态与产物。
        useAppStore.getState().openWorkbenchTab('design-canvas', { source: 'auto' });

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
