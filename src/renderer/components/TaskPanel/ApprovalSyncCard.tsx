import React, { useCallback, useRef } from 'react';
import { AlertTriangle, Check, Clock, X } from 'lucide-react';
import type { PermissionRequest, PermissionResponse } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import ipcService from '../../services/ipcService';
import { isDangerousCommand } from '../PermissionDialog/utils';

function getRequestTarget(request: PermissionRequest): string {
  return request.details.path
    || request.details.filePath
    || request.details.command
    || request.details.url
    || request.details.toolName
    || request.tool;
}

function isDangerousRequest(request: PermissionRequest): boolean {
  return request.forceConfirm === true
    || request.type === 'dangerous_command'
    || (request.type === 'command' && isDangerousCommand(request.details.command));
}

function getVisibleQueueCount(
  queuedPermissionRequests: Record<string, PermissionRequest[]> | undefined,
  currentSessionId: string | null,
): number {
  const queues = queuedPermissionRequests || {};
  const currentCount = currentSessionId ? queues[currentSessionId]?.length ?? 0 : 0;
  const globalCount = queues.global?.length ?? 0;
  return currentCount + globalCount;
}

export const ApprovalSyncCard: React.FC = () => {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const {
    pendingPermissionRequest,
    pendingPermissionSessionId,
    queuedPermissionRequests,
    setPendingPermissionRequest,
  } = useAppStore();
  const processedRef = useRef<string | null>(null);

  const queueCount = getVisibleQueueCount(queuedPermissionRequests, currentSessionId);
  const isVisiblePending = Boolean(
    pendingPermissionRequest
    && (!pendingPermissionSessionId || !currentSessionId || pendingPermissionSessionId === currentSessionId),
  );

  const respond = useCallback((response: PermissionResponse) => {
    const request = pendingPermissionRequest;
    if (!request || processedRef.current === request.id) return;
    processedRef.current = request.id;

    if (ipcService.isAvailable()) {
      ipcService.invoke(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        request.id,
        response,
        request.sessionId,
      );
    }
    setPendingPermissionRequest(null);
  }, [pendingPermissionRequest, setPendingPermissionRequest]);

  if (!pendingPermissionRequest || !isVisiblePending) {
    return (
      <div className="text-xs text-zinc-600">
        {queueCount > 0 ? `队列中还有 ${queueCount} 个审批` : '暂无审批请求'}
      </div>
    );
  }

  const dangerous = isDangerousRequest(pendingPermissionRequest);
  const target = getRequestTarget(pendingPermissionRequest);
  const traceCount = pendingPermissionRequest.decisionTrace?.steps.length ?? 0;

  return (
    <div className="space-y-2">
      <div className={`rounded-md border px-2.5 py-2 ${
        dangerous ? 'border-red-500/20 bg-red-500/[0.05]' : 'border-amber-500/20 bg-amber-500/[0.04]'
      }`}>
        <div className="flex items-center gap-2">
          <AlertTriangle className={`h-3.5 w-3.5 ${dangerous ? 'text-red-300' : 'text-amber-300'}`} />
          <span className="text-xs font-medium text-zinc-200">{pendingPermissionRequest.tool}</span>
          <span className="ml-auto text-[10px] text-zinc-600">{pendingPermissionRequest.type}</span>
        </div>
        {pendingPermissionRequest.reason && (
          <div className="mt-1 text-[11px] text-zinc-400">{pendingPermissionRequest.reason}</div>
        )}
        <div className="mt-1 truncate font-mono text-[11px] text-zinc-500" title={target}>
          {target}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-600">
          <span>{pendingPermissionSessionId ? '当前会话' : '全局审批'}</span>
          {traceCount > 0 && <span>{traceCount} step trace</span>}
          {queueCount > 0 && <span>队列 {queueCount}</span>}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <button
          type="button"
          onClick={() => respond('allow')}
          className="inline-flex items-center justify-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-300 hover:bg-emerald-500/15"
        >
          <Check className="h-3 w-3" />
          允许
        </button>
        <button
          type="button"
          onClick={() => respond('allow_session')}
          disabled={dangerous}
          className="inline-flex items-center justify-center gap-1 rounded-md border border-sky-500/20 bg-sky-500/10 px-2 py-1.5 text-[11px] text-sky-300 hover:bg-sky-500/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Clock className="h-3 w-3" />
          会话
        </button>
        <button
          type="button"
          onClick={() => respond('deny')}
          className="inline-flex items-center justify-center gap-1 rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300 hover:bg-red-500/15"
        >
          <X className="h-3 w-3" />
          拒绝
        </button>
      </div>
    </div>
  );
};
