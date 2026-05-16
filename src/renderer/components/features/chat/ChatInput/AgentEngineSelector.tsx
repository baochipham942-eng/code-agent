import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, Terminal, Check, AlertTriangle } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AgentEngineDescriptor, AgentEngineKind } from '@shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '@shared/contract/agentEngine';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useAppStore } from '../../../../stores/appStore';
import { toast } from '../../../../hooks/useToast';

const ENGINE_SHORT_LABEL: Record<AgentEngineKind, string> = {
  native: 'Native',
  codex_cli: 'Codex',
  claude_code: 'Claude',
};

function getEngineStatusText(descriptor: AgentEngineDescriptor, needsWorkspace: boolean): string {
  if (needsWorkspace) return '需要 workspace';
  if (descriptor.installState === 'missing') return '未安装';
  if (!descriptor.executable) return descriptor.version ? `${descriptor.version} · 导入/回看` : '导入/回看';
  if (descriptor.kind !== 'native') return descriptor.version ? `${descriptor.version} · 外部只读执行` : '外部只读执行';
  return descriptor.version || descriptor.runtimeState;
}

export function AgentEngineSelector() {
  const [open, setOpen] = useState(false);
  const [descriptors, setDescriptors] = useState<AgentEngineDescriptor[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sessionId = useSessionStore((state) => state.currentSessionId);
  const session = useSessionStore((state) =>
    state.currentSessionId
      ? state.sessions.find((item) => item.id === state.currentSessionId) ?? null
      : null
  );
  const updateSessionEngine = useSessionStore((state) => state.updateSessionEngine);
  const appWorkingDirectory = useAppStore((state) => state.workingDirectory);
  const engine = normalizeAgentEngineSession(session?.engine);
  const effectiveWorkingDirectory = session?.workingDirectory || appWorkingDirectory || null;

  const descriptorByKind = useMemo(() => {
    const map = new Map<AgentEngineKind, AgentEngineDescriptor>();
    for (const descriptor of descriptors) {
      map.set(descriptor.kind, descriptor);
    }
    return map;
  }, [descriptors]);

  const currentDescriptor = descriptorByKind.get(engine.kind);
  const label = ENGINE_SHORT_LABEL[engine.kind] ?? currentDescriptor?.label ?? 'Native';

  const loadDescriptors = useCallback(async () => {
    try {
      const res = await window.domainAPI?.invoke<AgentEngineDescriptor[]>(IPC_DOMAINS.AGENT_ENGINE, 'list', {});
      if (res?.success && res.data) {
        setDescriptors(res.data);
      }
    } catch (error) {
      toast.error('Engine 检测失败: ' + (error instanceof Error ? error.message : '未知错误'));
    }
  }, []);

  useEffect(() => {
    void loadDescriptors();
  }, [loadDescriptors]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    if (open) {
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }
  }, [open]);

  const selectEngine = useCallback(async (descriptor: AgentEngineDescriptor) => {
    if (!sessionId) return;
    if (descriptor.kind !== 'native' && !effectiveWorkingDirectory) {
      toast.error(`${descriptor.label} 需要先选择 workspace`);
      return;
    }
    if (!descriptor.executable) {
      toast.info(`${descriptor.label} 当前只开放检测和历史导入`);
      return;
    }
    if (descriptor.installState === 'missing' || descriptor.runtimeState === 'error' || descriptor.runtimeState === 'blocked') {
      toast.error(`${descriptor.label} 不可用`);
      return;
    }

    await updateSessionEngine(sessionId, {
      kind: descriptor.kind,
      permissionProfile: descriptor.defaultPermissionProfile,
      origin: 'manual',
    });
    setOpen(false);
  }, [effectiveWorkingDirectory, sessionId, updateSessionEngine]);

  return (
    <div className="relative text-xs">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          void loadDescriptors();
        }}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[0.08] bg-zinc-900/70 px-2 text-zinc-300 hover:border-white/[0.14] hover:bg-zinc-800/80 hover:text-zinc-100"
        title={`Agent Engine: ${currentDescriptor?.label ?? label}${engine.kind !== 'native' && engine.cwd ? ` · ${engine.cwd}` : ''}`}
      >
        {engine.kind === 'native' ? <Cpu className="h-3.5 w-3.5" /> : <Terminal className="h-3.5 w-3.5" />}
        <span className="max-w-[72px] truncate">{label}</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="absolute bottom-full right-0 z-50 mb-2 w-64 overflow-hidden rounded-lg border border-white/[0.08] bg-zinc-950/95 shadow-2xl backdrop-blur"
        >
          {descriptors.map((descriptor) => {
            const selected = descriptor.kind === engine.kind;
            const needsWorkspace = descriptor.kind !== 'native' && !effectiveWorkingDirectory;
            const disabled = needsWorkspace || !descriptor.executable || descriptor.installState === 'missing' || descriptor.runtimeState === 'error' || descriptor.runtimeState === 'blocked';
            const statusText = getEngineStatusText(descriptor, needsWorkspace);
            return (
              <button
                key={descriptor.kind}
                type="button"
                disabled={disabled}
                onClick={() => void selectEngine(descriptor)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-zinc-200 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/[0.06]">
                  {descriptor.kind === 'native' ? <Cpu className="h-3.5 w-3.5" /> : <Terminal className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{descriptor.label}</span>
                    {descriptor.runtimeState === 'error' && <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />}
                  </span>
                  <span className="block truncate text-[11px] text-zinc-500">
                    {statusText}
                  </span>
                </span>
                {selected && <Check className="h-3.5 w-3.5 text-emerald-300" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
