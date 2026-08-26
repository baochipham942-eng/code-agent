import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, GitBranch } from 'lucide-react';
import type { QueuedInput } from '@shared/contract/queuedInput';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../../hooks/useI18n';
import ipcService from '../../../../services/ipcService';

interface QueuedInputTrayProps {
  sessionId: string | null;
  revision: number;
  editingId: string | null;
  onEdit: (input: QueuedInput) => void;
}

function activeItems(items: QueuedInput[]): QueuedInput[] {
  return items.filter((item) => item.status === 'queued' || item.status === 'failed');
}

export function QueuedInputTray({
  sessionId,
  revision,
  editingId,
  onEdit,
}: QueuedInputTrayProps) {
  const { t } = useI18n();
  const copy = t.waitingInputTray;
  const [items, setItems] = useState<QueuedInput[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setItems([]);
      return;
    }
    const listed = await ipcService.invokeDomain<QueuedInput[]>(
      IPC_DOMAINS.QUEUED_INPUT,
      'list',
      { sessionId },
    );
    setItems(activeItems(listed));
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.QUEUED_INPUT_SETTLED, (settled) => {
      if (settled.sessionId === sessionId) void refresh();
    });
    return () => unsubscribe?.();
  }, [refresh, sessionId]);

  const runAction = useCallback(async (action: 'retract' | 'sendNow', id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.QUEUED_INPUT, action, { id });
    } finally {
      await refresh();
    }
  }, [refresh]);

  if (items.length === 0) return null;

  return (
    <section
      className="mb-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/80"
      data-testid="queued-input-tray"
    >
      <button /* ds-allow:button: 队列条标题整行都是收起热区，Button primitive 的居中按钮形态不适配 */
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-zinc-400 hover:text-zinc-200"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span>{copy.title.replace('{count}', String(items.length))}</span>
        {collapsed
          ? <ChevronDown className="h-3.5 w-3.5" aria-label={copy.expand} />
          : <ChevronUp className="h-3.5 w-3.5" aria-label={copy.collapse} />}
      </button>
      {!collapsed && (
        <div className="border-t border-zinc-800/80">
          {items.map((item) => {
            const paused = item.pausedReason !== null || item.status === 'failed';
            return (
              <div
                key={item.id}
                className="group flex min-h-9 items-center gap-2 border-b border-zinc-800/60 px-2.5 last:border-b-0"
                data-testid={`queued-input-row-${item.id}`}
              >
                {paused && (
                  <span
                    className="shrink-0 text-[11px] text-mark-warning"
                    title={copy.failed}
                    aria-label={copy.failed}
                  >
                    ⚠
                  </span>
                )}
                {editingId === item.id && (
                  <span className="shrink-0 text-[10px] text-zinc-500">
                    {copy.editing}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                  {item.envelope.content}
                </span>
                <div
                  className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  data-testid={`queued-input-actions-${item.id}`}
                >
                  {paused ? (
                    <>
                      <button /* ds-allow:button: 行内文字动作需保持 11px 紧凑密度，Button primitive 最小尺寸会挤掉正文 */ type="button" className="rounded px-1.5 py-1 text-[11px] text-mark-warning hover:opacity-80" onClick={() => { void runAction('sendNow', item.id); }}>
                        {copy.retry}
                      </button>
                      <button /* ds-allow:button: paused 行内删除与重试同密度排列 */ type="button" className="rounded px-1.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-200" onClick={() => { void runAction('retract', item.id); }}>
                        {copy.delete}
                      </button>
                    </>
                  ) : (
                    <>
                      <button /* ds-allow:button: 改道是队列条紧凑图标动作，Button primitive 最小尺寸会挤掉正文 */
                        type="button"
                        className="rounded p-1 text-accent-accessible hover:text-accent-accessible/80"
                        title={copy.redirectNow}
                        aria-label={copy.redirectNow}
                        data-testid={`queued-input-redirect-${item.id}`}
                        onClick={() => { void runAction('sendNow', item.id); }}
                      >
                        <GitBranch className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button /* ds-allow:button: 普通行内编辑与其他文字动作同密度排列 */ type="button" className="rounded px-1.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-200" onClick={() => onEdit(item)}>
                        {copy.edit}
                      </button>
                      <button /* ds-allow:button: 普通行内撤回与其他文字动作同密度排列 */ type="button" className="rounded px-1.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-200" onClick={() => { void runAction('retract', item.id); }}>
                        {copy.retract}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
