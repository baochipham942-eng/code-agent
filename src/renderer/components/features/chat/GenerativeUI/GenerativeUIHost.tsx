import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import {
  parseNeoUIModelSpec,
  type ExecutionManifestV1,
  type NeoUIComponentNodeV1,
  type NeoUIHostSurfaceV1,
  type NeoUIInstanceV1,
  type NeoUIModelIntent,
} from '@shared/contract/generativeUI';
import { generativeUIClient } from '../../../../services/generativeUIClient';
import { neoUIActionRouter } from '../../../../services/neoUIActionRouter';
import {
  NEO_UI_HEAVY_COMPONENTS,
  neoUIComponentRegistry,
  type NeoUIComponentContext,
} from './componentRegistry';
import { Modal } from '../../../primitives/Modal';

function randomId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${id}`;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function ManifestSurface({
  surface,
  resolving,
  onResolve,
}: {
  surface: NeoUIHostSurfaceV1;
  resolving: boolean;
  onResolve: (decision: 'approve' | 'reject') => Promise<void>;
}) {
  const manifest = surface.manifest;
  const isPending = manifest.status === 'pending';
  const statusLabel: Record<ExecutionManifestV1['status'], string> = {
    pending: '等待决策',
    approved: '已批准',
    executing: '执行中',
    completed: '已完成',
    rejected: '已拒绝',
    expired: '已过期',
    invalidated: '范围已变化',
    orphaned: '进程重启后已失效',
    failed: '执行失败',
  };
  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-cyan-500/30 bg-cyan-950/10" aria-label="可信执行审批">
      <div className="border-b border-cyan-500/20 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-cyan-100">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          {manifest.title}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">{manifest.summary}</p>
      </div>
      <div className="space-y-2 p-4">
        {manifest.items.map((item, index) => (
          <div key={item.id} className="rounded-lg border border-zinc-700 bg-zinc-900/70 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-zinc-100">{index + 1}. {item.label}</div>
                <div className="mt-1 text-xs leading-relaxed text-zinc-400">{item.summary}</div>
              </div>
              <span className="rounded-full border border-zinc-600 px-2 py-0.5 text-[10px] uppercase text-zinc-400">
                {item.riskLevel}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 border-t border-cyan-500/20 bg-zinc-950/60 px-4 py-3 min-[743px]:flex-row min-[743px]:items-center min-[743px]:justify-between">
        <div className="flex items-center gap-2 text-xs text-zinc-400" aria-live="polite">
          {manifest.status === 'completed' ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : null}
          {['rejected', 'expired', 'invalidated', 'orphaned', 'failed'].includes(manifest.status)
            ? <AlertTriangle className="h-4 w-4 text-amber-400" />
            : null}
          {statusLabel[manifest.status]}
          {manifest.invalidationReason ? ` · ${manifest.invalidationReason}` : ''}
        </div>
        {isPending && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={resolving}
              onClick={() => void onResolve('reject')}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-600 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              <XCircle className="h-3.5 w-3.5" />拒绝
            </button>
            <button
              type="button"
              disabled={resolving}
              onClick={() => void onResolve('approve')}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 disabled:opacity-50"
            >
              {resolving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              批准完整范围
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function NodeSurface({
  node,
  context,
  expanded,
  onToggle,
  onFocus,
}: {
  node: NeoUIComponentNodeV1;
  context: NeoUIComponentContext;
  expanded: boolean;
  onToggle: () => void;
  onFocus: () => void;
}) {
  const renderer = neoUIComponentRegistry[node.type];
  const heavy = NEO_UI_HEAVY_COMPONENTS.has(node.type);
  const focusButtonId = `neo-ui-focus-${context.instance.instanceId}-${node.id}`;
  return (
    <section className="rounded-xl border border-zinc-700 bg-zinc-950/40">
      {heavy && (
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left text-xs font-medium text-zinc-300"
          >
            <span className="truncate">{text(node.props?.label, node.type)}</span>
            <ChevronDown className={`h-4 w-4 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          <button
            id={focusButtonId}
            type="button"
            onClick={onFocus}
            className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 min-[743px]:hidden"
            aria-label={`在专注模式打开${text(node.props?.label, node.type)}`}
          >
            专注
          </button>
        </div>
      )}
      <div className={`${heavy && !expanded ? 'hidden' : 'block'} p-4 ${heavy ? 'border-t border-zinc-800' : ''}`}>
        {renderer(node, context)}
        {node.children?.map((child) => (
          <div key={child.id} className="mt-3">
            {neoUIComponentRegistry[child.type](child, context)}
          </div>
        ))}
      </div>
    </section>
  );
}

export const GenerativeUIHost = memo(function GenerativeUIHost({
  rawSpec,
  sessionId,
  messageId,
  sourceOrdinal,
  isStreaming = false,
}: {
  rawSpec: string;
  sessionId?: string;
  messageId?: string;
  sourceOrdinal: number;
  isStreaming?: boolean;
}) {
  const localParse = useMemo(() => parseNeoUIModelSpec(rawSpec), [rawSpec]);
  const fallback = localParse.success ? localParse.spec.fallback : localParse.fallback;
  const [instance, setInstance] = useState<NeoUIInstanceV1 | null>(null);
  const [hostSurface, setHostSurface] = useState<NeoUIHostSurfaceV1 | null>(null);
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const [resolvingManifest, setResolvingManifest] = useState(false);
  const [error, setError] = useState<string | null>(localParse.success ? null : localParse.error);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  useEffect(() => {
    if (isStreaming || !sessionId || !messageId || !localParse.success) return;
    let cancelled = false;
    setError(null);
    void generativeUIClient.resolveInstance({
      sessionId,
      sourceMessageId: messageId,
      sourceOrdinal,
      rawSpec,
    }).then((result) => {
      if (cancelled) return;
      setEnabled(result.enabled);
      setInstance(result.instance ?? null);
      setHostSurface(result.hostSurface ?? null);
      setError(result.error ?? null);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [isStreaming, localParse.success, messageId, rawSpec, sessionId, sourceOrdinal]);

  useEffect(() => {
    if (!instance) return;
    const firstHeavy = instance.spec.components.find((node) => NEO_UI_HEAVY_COMPONENTS.has(node.type));
    setExpandedNodeId((current) => current ?? firstHeavy?.id ?? null);
  }, [instance]);

  const closeFocus = useCallback(() => {
    const nodeId = focusedNodeId;
    setFocusedNodeId(null);
    if (!instance || !nodeId) return;
    globalThis.setTimeout(() => {
      document.getElementById(`neo-ui-focus-${instance.instanceId}-${nodeId}`)?.focus();
    }, 0);
  }, [focusedNodeId, instance]);

  const dispatch = useCallback(async (
    node: NeoUIComponentNodeV1,
    intent: NeoUIModelIntent,
    payload: Record<string, unknown> = {},
  ) => {
    if (!instance) return;
    if (intent === 'conversation.fill') {
      neoUIActionRouter.fillComposer(text(payload.text));
      return;
    }
    if (intent === 'conversation.send') {
      await neoUIActionRouter.sendConversation(text(payload.text));
      return;
    }
    if (intent === 'disclosure.toggle' || intent === 'focus.open') {
      setExpandedNodeId(node.id);
      if (intent === 'focus.open') setFocusedNodeId(node.id);
      return;
    }

    setBusyNodeId(node.id);
    setError(null);
    try {
      const result = await generativeUIClient.applyEvent({
        event: {
          eventId: randomId('event'),
          sessionId: instance.sessionId,
          instanceId: instance.instanceId,
          nodeId: node.id,
          specHash: instance.specHash,
          baseStateRevision: instance.stateRevision,
          intent,
          payload,
          idempotencyKey: randomId('idem'),
          createdAt: Date.now(),
        },
      });
      if (result.instance) setInstance(result.instance);
      if (result.hostSurface?.origin === 'host') setHostSurface(result.hostSurface);
      if (result.error) setError(result.error);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyNodeId(null);
    }
  }, [instance]);

  const resolveManifest = useCallback(async (decision: 'approve' | 'reject') => {
    if (!hostSurface || !sessionId || hostSurface.origin !== 'host') return;
    setResolvingManifest(true);
    setError(null);
    try {
      const result = await generativeUIClient.resolveManifest({
        sessionId,
        manifestId: hostSurface.manifest.manifestId,
        nonce: hostSurface.manifest.nonce,
        decision,
      });
      setHostSurface({ ...hostSurface, manifest: result.manifest });
      if (result.error) setError(result.error);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setResolvingManifest(false);
    }
  }, [hostSurface, sessionId]);

  if (isStreaming) {
    return (
      <div className="my-3 rounded-xl border border-violet-500/20 bg-violet-500/5 p-4" aria-label="交互组件生成中">
        <div className="flex items-center gap-2 text-xs text-violet-200"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />交互组件生成中…</div>
        {fallback && <p className="mt-2 text-xs text-zinc-400">{fallback}</p>}
      </div>
    );
  }

  if (!localParse.success || enabled === false || !sessionId || !messageId || (error !== null && !instance)) {
    return (
      <div className="my-3 rounded-xl border border-zinc-700 bg-zinc-900/70 p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-300"><AlertTriangle className="h-4 w-4 text-amber-400" />交互内容以只读方式显示</div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{fallback || 'Interactive content is unavailable.'}</p>
        {error && <div className="mt-2 text-[11px] text-zinc-500">{error}</div>}
      </div>
    );
  }

  if (!instance) {
    return (
      <div className="my-3 rounded-xl border border-violet-500/20 bg-violet-500/5 p-4 text-xs text-zinc-400">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin motion-reduce:animate-none" />正在恢复交互状态…
      </div>
    );
  }

  const context: NeoUIComponentContext = { instance, busyNodeId, dispatch };
  const focusedNode = instance.spec.components.find((node) => node.id === focusedNodeId) ?? null;
  return (
    <div className="my-3 w-full rounded-2xl border border-violet-500/25 bg-zinc-900/80 p-3 shadow-lg sm:p-4" data-testid="neo-ui-host">
      <header className="mb-4">
        <div className="text-sm font-semibold text-zinc-100">{instance.spec.title || 'Agent Neo 交互组件'}</div>
        {instance.spec.summary && <p className="mt-1 text-xs leading-relaxed text-zinc-400">{instance.spec.summary}</p>}
      </header>
      <div className="grid grid-cols-1 gap-3">
        {instance.spec.components.map((node) => {
          const heavy = NEO_UI_HEAVY_COMPONENTS.has(node.type);
          return (
            <NodeSurface
              key={node.id}
              node={node}
              context={context}
              expanded={!heavy || expandedNodeId === node.id}
              onToggle={() => setExpandedNodeId((current) => current === node.id ? null : node.id)}
              onFocus={() => {
                setExpandedNodeId(node.id);
                setFocusedNodeId(node.id);
              }}
            />
          );
        })}
      </div>
      {hostSurface?.origin === 'host' && (
        <ManifestSurface surface={hostSurface} resolving={resolvingManifest} onResolve={resolveManifest} />
      )}
      {error && (
        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200" role="status">
          {error}
        </div>
      )}
      <Modal
        isOpen={focusedNode !== null}
        onClose={closeFocus}
        title={focusedNode ? text(focusedNode.props?.label, focusedNode.type) : undefined}
        size="viewport"
        closeOnBackdropClick={false}
      >
        {focusedNode ? neoUIComponentRegistry[focusedNode.type](focusedNode, context) : null}
        {focusedNode?.children?.map((child) => (
          <div key={child.id} className="mt-3">{neoUIComponentRegistry[child.type](child, context)}</div>
        ))}
      </Modal>
    </div>
  );
});
