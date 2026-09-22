// ============================================================================
// CompanionPairRequestCard - 手机「登录找回电脑」的全局配对卡片（N-COMPANION-RELAY-ACCOUNT-RECOVER）
// ============================================================================
// 订阅 companion:pair-request 广播（AgentNoticeToast 同款范式，全局挂载，不只在设置页里）：
// 手机经账号中继发起找回配对时，电脑弹出「新手机请求连接 · 4 位核对码」卡片。核对码两端各自
// 从同一份 Noise XX 握手材料派生——人眼比对通过再点同意（D2：找回必须电脑点同意）。

import { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CompanionPairRequestEvent } from '@shared/ipc';
import { COMPANION_MANAGE_CHANNEL } from '@shared/constants/companion';
import { formatRelayPairVerify } from '@shared/companion/relayPairVerify';
import { ipcService } from '../services/ipcService';
import { useI18n } from '../hooks/useI18n';
import { companionText } from '../i18n/companion';
import { toast } from '../hooks/useToast';
import { Modal } from './primitives/Modal';
import { Button } from './primitives/Button';

export function CompanionPairRequestCard() {
  const { language } = useI18n();
  const text = companionText[language];
  const showToast = toast.show;
  const [pending, setPending] = useState<{ requestId: string; code: string; expiresAt: number; scopeEmpty: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.COMPANION_PAIR_REQUEST, (event: CompanionPairRequestEvent) => {
      if (event.type === 'request' && event.code && event.expiresAt) {
        setPending({ requestId: event.requestId, code: event.code, expiresAt: event.expiresAt, scopeEmpty: event.scopeEmpty === true });
      } else if (event.type === 'gone') {
        setPending(current => current?.requestId === event.requestId ? null : current);
      }
    });
    return unsubscribe;
  }, []);

  // 卡片到点自收：host 侧超时会推 gone，这里按本地期限兜底（时钟偏差/host 重启收尾失败）。
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), Math.max(0, pending.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pending]);

  const respond = async (approve: boolean) => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      // 表态送达即收卡：ok=false（挂起态已被超时/断连收走）与 ok=true（等手机补完握手）对用户
      // 都是「已处理」——后续的完成/超时由 host 侧自己收尾，不再需要人盯着。
      await ipcService.invoke(COMPANION_MANAGE_CHANNEL, {
        action: 'pair.respond', requestId: pending.requestId, approve,
      });
      setPending(null);
    } catch (error) {
      // IPC 失败时表态没送达（ai-review R4 Nit1）：同样收卡 + 兜底提示，别把 rejection 晾成
      // unhandled；挂起态本身有 relay/Host 侧超时收尾，卡片到点也会自隐。
      console.error('[CompanionPairRequestCard] pair respond failed', error);
      setPending(null);
      showToast('error', text.pairRequestFailed);
    } finally {
      setBusy(false);
    }
  };

  if (!pending) return null;
  return <Modal isOpen onClose={() => { /* 必须表态或等到期：误点背景不收卡 */ }} closeOnBackdropClick={false}
    closeOnEsc={false} showCloseButton={false} size="sm"
    title={text.pairRequestTitle} headerIcon={<Smartphone className="w-5 h-5" />}
    footer={<>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void respond(false)}>{text.pairRequestDeny}</Button>
      <Button variant="primary" size="sm" loading={busy} disabled={pending.scopeEmpty} onClick={() => void respond(true)}>{text.pairRequestApprove}</Button>
    </>}>
    <div className="space-y-3" data-testid="companion-pair-card">
      {/* 零库电脑（R2 Important②）：同意置灰 + 「先建项目」出路文案——同意只会登记零授权设备。 */}
      <p className="text-sm text-zinc-300">{pending.scopeEmpty ? text.pairRequestNoScope : text.pairRequestHint}</p>
      <div className="space-y-1">
        <p className="text-xs text-zinc-500">{text.pairRequestCodeLabel}</p>
        <p className="font-mono text-3xl tracking-[0.35em] text-zinc-100" data-testid="companion-pair-code">
          {formatRelayPairVerify(pending.code)}
        </p>
      </div>
    </div>
  </Modal>;
}
