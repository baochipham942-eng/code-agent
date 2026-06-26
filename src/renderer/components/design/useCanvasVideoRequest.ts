// 2b：订阅 agent 经 ProposeVideoOps 发来的出视频请求（CANVAS_VIDEO_ASK）→ 设计模式闸 →
// 出视频落画布节点 → 回裁决（CANVAS_VIDEO_RESPONSE）。成本已在会话区确认（main 侧），
// 此处只负责落地，不再弹任何确认。
//
// 适配 main：main 的设计画布是全局单例（workspaceMode==='design' + 全屏 DesignWorkspace），
// 无 per-session 画布属主/隔离（ADR-026 在 main 上无隔离不变量，画布注入只是 prompt 膨胀优化）。
// 故属主闸退化为「设计模式闸」：仅在设计模式激活时接受出视频请求，否则隔离拒绝——绝不在
// 非设计上下文出视频。请求本就只在 designCanvasActive（=workspaceMode==='design'）时由 agent 发出。
import { useEffect } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CanvasVideoRequest, CanvasVideoDecision } from '@shared/contract';
import type { CanvasNode } from './designCanvasTypes';
import ipcService from '../../services/ipcService';
import { useDesignCanvasStore } from './designCanvasStore';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';
import { generateVideoToCanvas } from './designProposedVideoGen';

export function useCanvasVideoRequest(): void {
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.CANVAS_VIDEO_ASK,
      async (request: CanvasVideoRequest) => {
        const respond = (decision: CanvasVideoDecision): void => {
          void ipcService.invoke(IPC_CHANNELS.CANVAS_VIDEO_RESPONSE, decision);
        };

        // 设计模式闸（fail-closed）：main 无 per-session 画布隔离，按全局设计模式守护。
        // 仅在设计模式激活时落地出视频，否则隔离拒绝（绝不在非设计上下文烧钱出视频）。
        if (useWorkspaceModeStore.getState().workspaceMode !== 'design') {
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
