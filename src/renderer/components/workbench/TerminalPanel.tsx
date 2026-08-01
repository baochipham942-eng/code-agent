import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalSquare } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useI18n } from '../../hooks/useI18n';
import { invokeDomain, ipcService } from '../../services/ipcService';
import { Button } from '../primitives';

// 右栏「终端」视图 = 一个真 shell，跟当前会话绑定。宿主侧那个 PTY 同时也是 Agent
// terminal_* 工具读写的对象——用户在这里登录的 CLI，Agent 接着用的就是同一个登录态。

interface TerminalSnapshot {
  sessionId: string;
  data: string;
  cols: number;
  rows: number;
  alive: boolean;
}

// xterm 不吃 CSS 变量，只吃具体色值；从主题变量现取（Neo 有浅色主题，写死黑底会打架）。
// 取不到就整个不传，让 xterm 用自己的默认——不写兜底色值，那等于把某一个主题硬编码进来。
function readThemeColors(host: HTMLElement): { background?: string; foreground?: string } {
  const styles = getComputedStyle(host);
  const background = styles.getPropertyValue('--bg-deep').trim() || styles.backgroundColor;
  const foreground = styles.getPropertyValue('--text-primary').trim() || styles.color;
  return {
    ...(background ? { background } : {}),
    ...(foreground ? { foreground } : {}),
  };
}

export const TerminalPanel: React.FC = () => {
  const { t } = useI18n();
  const copy = t.workbenchTabs.terminal;
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [openedSessionId, setOpenedSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openTerminal = useCallback(() => {
    if (!currentSessionId) return;
    setError(null);
    setOpenedSessionId(currentSessionId);
  }, [currentSessionId]);

  // 切会话 = 切实例：先卸掉上一个会话的 xterm（别把两个会话的输出串在一块），再问宿主
  // 这个会话是不是已经有活着的 PTY——有就直接挂回去。PTY 活着却让用户重按一次「打开终端」，
  // 是把「面板重新挂载」当成了「终端不存在」。
  useEffect(() => {
    setOpenedSessionId(null);
    if (!currentSessionId) return undefined;

    let cancelled = false;
    void (async () => {
      try {
        const existing = await invokeDomain<TerminalSnapshot | null>(
          IPC_DOMAINS.TERMINAL,
          'snapshot',
          { sessionId: currentSessionId },
        );
        if (!cancelled && existing?.alive) setOpenedSessionId(currentSessionId);
      } catch {
        /* 问不到就当没有，用户可以自己按「打开终端」 */
      }
    })();
    return () => { cancelled = true; };
  }, [currentSessionId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!openedSessionId || !host) return undefined;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      convertEol: false,
      theme: readThemeColors(host),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    const unsubscribe = ipcService.on(IPC_CHANNELS.TERMINAL_OUTPUT, (event) => {
      if (event.sessionId !== openedSessionId) return;
      term.write(event.data);
    });

    const keyDisposable = term.onData((data) => {
      void invokeDomain(IPC_DOMAINS.TERMINAL, 'write', { sessionId: openedSessionId, data });
    });

    void (async () => {
      try {
        const snapshot = await invokeDomain<TerminalSnapshot>(IPC_DOMAINS.TERMINAL, 'open', {
          sessionId: openedSessionId,
          cwd: workingDirectory ?? undefined,
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) return;
        // 重新挂载：先补历史画面，再接实时流（open 之后到订阅之间没有窗口——订阅先于 open）。
        if (snapshot?.data) term.write(snapshot.data);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        void invokeDomain(IPC_DOMAINS.TERMINAL, 'resize', {
          sessionId: openedSessionId,
          cols: term.cols,
          rows: term.rows,
        });
      } catch {
        /* 容器还没量出尺寸时 fit 会抛，下一次 resize 再来 */
      }
    });
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      unsubscribe?.();
      keyDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // 只卸 UI，不 close PTY：切走再切回来要能看到期间跑完的输出。
    };
  }, [openedSessionId, workingDirectory]);

  if (!openedSessionId) {
    return (
      <div
        data-testid="workbench-terminal-empty"
        className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <TerminalSquare className="h-8 w-8 text-zinc-600" />
        <p className="max-w-xs text-xs leading-5 text-zinc-500">{copy.emptyHint}</p>
        <Button size="sm" onClick={openTerminal} disabled={!currentSessionId} data-testid="workbench-terminal-open">
          {copy.openAction}
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="workbench-terminal-live" className="flex h-full min-h-0 flex-col">
      {error && <div className="px-3 py-1.5 text-[11px] text-red-400">{error}</div>}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />
    </div>
  );
};
