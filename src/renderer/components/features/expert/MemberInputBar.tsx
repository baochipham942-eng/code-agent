// ============================================================================
// MemberInputBar - 成员视图底部的输入条（N-SUBAGENT-INPUT）
// ----------------------------------------------------------------------------
// 与主输入框同手势：Enter 补话（成员下一步读到，不打断手头的工具）、⌘/Ctrl+Enter 改道、
// Shift+Enter 换行。只调一个 IPC（domain:agent · sendMemberInput），成员类型的三分路由在宿主。
// 回执三态（同一事件一屏一个信号）：已送到 / 已读到 / 没送到：原因。已收工的成员不给输入框，
// 只留一句「回主会话再派」——不排队，与 N-TASKWAKE 取舍一致。
// 切换成员/会话时清草稿、丢弃旧发送的结果（scope token），与团队面板旧输入框同一契约。
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { MemberInputKind, MemberInputReceipt } from '@shared/contract/memberInput';
import type { RuntimeInputMode } from '@shared/contract/conversationEnvelope';
import { generateMessageId } from '@shared/utils/id';
import ipcService from '../../../services/ipcService';
import { useI18n } from '../../../hooks/useI18n';
import { useSessionStore } from '../../../stores/sessionStore';

export interface MemberInputTarget {
  key: string;
  kind: MemberInputKind;
  name: string;
  /** 还在干活（能收话）；收工/失败/取消 = false */
  live: boolean;
}

type ReceiptState = 'delivered' | 'read' | 'queued' | 'redirect_next' | 'rejected' | 'failed';

interface LocalReceipt {
  id: string;
  content: string;
  state: ReceiptState;
  detail?: string;
}

function receiptOf(receipt: MemberInputReceipt, mode: RuntimeInputMode): Pick<LocalReceipt, 'state' | 'detail'> {
  if (receipt.outcome === 'rejected') return { state: 'rejected', detail: receipt.reason };
  if (receipt.effect === 'now') return { state: 'read' };
  if (receipt.effect === 'queued') return { state: 'queued' };
  return { state: mode === 'redirect' ? 'redirect_next' : 'delivered' };
}

export const MemberInputBar: React.FC<{
  sessionId: string | null;
  runId?: string;
  member: MemberInputTarget;
}> = ({ sessionId, runId, member }) => {
  const { t } = useI18n();
  const text = t.expert.memberBar;
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [receipts, setReceipts] = useState<LocalReceipt[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const scopeKey = `${sessionId}:${runId ?? ''}:${member.key}`;
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;

  useEffect(() => {
    setValue('');
    setReceipts([]);
    setHint(null);
    setSending(false);
  }, [scopeKey]);

  const send = async (mode: RuntimeInputMode) => {
    const content = value.trim();
    if (!content || !sessionId || sending || !member.live) return;
    const requestScope = scopeKey;
    const messageId = generateMessageId();
    const timestamp = Date.now();
    setSending(true);
    setHint(null);
    try {
      const receipt = await ipcService.invokeDomain<MemberInputReceipt>(IPC_DOMAINS.AGENT, 'sendMemberInput', {
        sessionId,
        runId,
        memberId: member.key,
        memberName: member.name,
        kind: member.kind,
        message: content,
        mode,
        messageId,
        timestamp,
      });
      if (activeScopeRef.current !== requestScope) return;
      const local = receiptOf(receipt, mode);
      setReceipts((prev) => [...prev, { id: messageId, content, ...local }]);
      if (receipt.outcome !== 'delivered') return;
      // delivered 就清草稿：即使主会话没记下，重发也会让成员执行两次
      setValue('');
      if (member.kind !== 'task') {
        if (!receipt.persisted) {
          setHint(text.sentNotRecorded);
        } else if (useSessionStore.getState().currentSessionId === sessionId) {
          // 主对话里落同一条记录（团队路径宿主已落库，这里只做即时显示；重载后以宿主那条为准）
          useSessionStore.getState().addMessage({
            id: messageId,
            role: 'user',
            content,
            timestamp,
            metadata: {
              workbench: { routingMode: 'direct', targetAgentIds: [member.key], runtimeInputMode: mode },
              memberInput: { memberId: member.key, memberName: member.name, mode },
            },
          });
        }
      }
    } catch {
      if (activeScopeRef.current !== requestScope) return;
      setReceipts((prev) => [...prev, { id: messageId, content, state: 'failed' }]);
    } finally {
      if (activeScopeRef.current === requestScope) setSending(false);
    }
  };

  const stateLabel = (receipt: LocalReceipt): string => {
    switch (receipt.state) {
      case 'read': return text.receiptRead;
      case 'queued': return text.receiptQueued;
      case 'redirect_next': return text.receiptRedirectNextStep;
      case 'rejected':
        return `${text.receiptRejected}：${receipt.detail === 'finished' ? text.rejectFinished : text.rejectNotFound}`;
      case 'failed': return `${text.receiptRejected}：${text.sendFailed}`;
      default: return text.receiptDelivered;
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 三重检查：isComposing（标准）+ keyCode 229（IME 标准信号），与主输入框同款
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send(event.metaKey || event.ctrlKey ? 'redirect' : 'supplement');
  };

  return (
    <div data-testid="member-input-bar" className="mx-auto w-full max-w-3xl px-4 pb-4 pt-2">
      {receipts.length > 0 && (
        <ul className="mb-2 space-y-1.5" data-testid="member-input-receipts">
          {receipts.map((receipt) => (
            <li key={receipt.id} data-testid="member-input-receipt" data-state={receipt.state} className="flex flex-col items-end gap-0.5">
              <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100">
                {receipt.content}
              </p>
              <span className={`text-[11px] ${receipt.state === 'rejected' || receipt.state === 'failed' ? 'text-badge-danger' : 'text-zinc-500'}`}>
                {stateLabel(receipt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hint && <p role="status" className="mb-1.5 text-[11px] text-badge-warning">{hint}</p>}
      {member.live ? (
        <div className="composer-elevated flex items-end gap-2 rounded-2xl px-3 py-2">
          <textarea
            data-testid="member-input"
            aria-label={text.inputAriaLabel.replace('{name}', member.name)}
            rows={1}
            value={value}
            disabled={sending}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={text.inputPlaceholder.replace('{name}', member.name)}
            className="max-h-32 min-h-[28px] flex-1 resize-none bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none"
          />
          <button /* ds-allow:button: 输入条内的图标发送键，与主输入框同档紧凑变体 */
            type="button"
            data-testid="member-input-send"
            aria-label={text.send}
            disabled={!value.trim() || sending}
            onClick={() => { void send('supplement'); }}
            className="rounded-lg p-1.5 text-badge-accent transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Send className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <p data-testid="member-input-finished" className="rounded-2xl bg-zinc-900/60 px-3 py-2 text-center text-xs text-zinc-500">
          {text.finishedHint.replace('{name}', member.name)}
        </p>
      )}
    </div>
  );
};
