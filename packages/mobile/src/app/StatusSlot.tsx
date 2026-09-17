import type { messages } from '../i18n';
import { connectionDiagnosis } from './connectionDiagnosis';

/**
 * 输入区唯一的状态位（N-MOBILE-STATUS-NOISE，design.md §12，爸 2026-09-17 选 A）。
 * build 50 真机：一次「电脑没回应」在输入框上方叠出四行（连接胶囊 / 未确认送达 / 读取失败 / 会话没建成），
 * 左沿各不相同还压字。现在只有这一个位置：同一时刻一条、一条一个动作、没有状态不占高度。
 *
 * rank 越小越急（§12 优先级）：1 草稿没存上 > 2 连不上电脑 > 3 语音失败 > 4 刚才的操作没成功
 * > 5 项目和历史没读全 > 6 还没收到电脑确认 > 7 正在转写。
 */
export type StatusItem = {
  rank: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  message: string;
  /** 点文字打开的解释（连接类 = 连接电脑弹层，原因诊断都在那里）。 */
  open?(): void;
  action?: { label: string; run(): void; disabled?: boolean };
  /** 进度类（正在连接 / 等确认 / 正在转写）用灰点，不是警示。 */
  neutral?: boolean;
  /** 真实错误码只进 data-reason 供取证，用户面不出现。 */
  reason?: string;
};

export function StatusSlot({ items }: { items: (StatusItem | null)[] }) {
  const item = items.reduce<StatusItem | null>((top, next) => next && (!top || next.rank < top.rank) ? next : top, null);
  if (!item) return null;
  return <div className="status-slot" role="status" data-testid="status-slot" data-rank={item.rank} data-neutral={item.neutral || undefined} data-reason={item.reason}>
    <span className="dot" aria-hidden="true" />
    {item.open
      ? <button className="status-text" data-testid="status-open" onClick={item.open}>{item.message}</button>
      : <span className="status-text">{item.message}</span>}
    {item.action && <button className="status-action" data-testid="status-action" disabled={item.action.disabled} onClick={item.action.run}>{item.action.label}</button>}
  </div>;
}

/**
 * 命令被拒的一句话（按错误码）。session.create 的失败要点名「会话没建成」（fix6-②，build 37「点了没反应」）：
 * 错误码只说原因，不点名的话用户不知道是新会话没建起来。
 * 预览面板里的保存失败也用它——那里被模态弹层盖着，状态位看不到。
 */
export function commandNoticeCopy(
  text: ReturnType<typeof messages>,
  companion: { commandError: string | null; commandErrorAction: string | null },
  voiceFailureShown: boolean,
): string | null {
  const named = (copy: string) => companion.commandErrorAction === 'session.create' ? `${text.sessionCreateFailed}：${copy}` : copy;
  const error = companion.commandError;
  if (error === 'COMPANION_NOT_CONNECTED') return named(text.cannotReachComputer);
  // 槽被上一条未结算命令占着：说的是在飞的那条，不是这次点按。
  if (error === 'COMPANION_COMMAND_IN_FLIGHT') return named(text.commandInFlight);
  // 旧 Host 不认这条命令/参数时，按「电脑太旧」给人话，不报笼统的「拒绝了这条操作」。
  if (error === 'COMPANION_UNSUPPORTED_ACTION') return named(text.hostTooOld);
  const base = (): string | null => {
    if (error === 'UPLOAD_TOO_LARGE') return text.uploadTooLarge;
    if (error === 'COMPANION_FILE_TYPE_DENIED') return text.fileTypeDenied;
    if (error === 'STORAGE_FULL') return text.storageFull;
    if (error === 'COMPANION_EXPORT_FAILED') return text.exportFailed;
    if (error === 'ARTIFACT_MISSING') return text.artifactMissing;
    if (error === 'PROJECT_SOURCE_MISSING') return text.projectSourceMissing;
    if (error === 'PROJECT_SOURCE_CHANGED') return text.projectSourceChanged;
    if (error === 'PROJECT_SOURCE_UNTRUSTED') return text.projectSourceUntrusted;
    if (error === 'MODEL_AUTH') return text.modelAuthMissing;
    if (error === 'scope_denied' || error === 'COMPANION_SCOPE_DENIED') return text.commandScopeDenied;
    if (error === 'COMPANION_PROJECT_UNAVAILABLE') return text.projectUnavailable;
    if (error === 'COMPANION_PROJECT_CHANGED') return text.projectChanged;
    if (error === 'COMPANION_MODEL_UNAVAILABLE') return text.modelUnavailable;
    if (error === 'COMPANION_SESSION_BUSY') return text.sessionBusy;
    if (error === 'RUN_FAILED') return text.runFailed;
    if (error && ['COMPANION_TRANSFER_INTERRUPTED', 'ATTACHMENT_INCOMPLETE', 'COMPANION_INTERRUPTED', 'COMPANION_NETWORK_UNAVAILABLE', 'COMPANION_CHANNEL_CLOSED'].includes(error)) return text.transferInterrupted;
    // 转写失败由输入区的语音那条负责（它带阶段和真实错误码）；按**动作**让位而不是按码名列白名单。
    // 只有输入区**真的在显示**它时才让位：切会话会把输入区重挂，那时输入区手里没有这条失败。
    if (companion.commandErrorAction === 'voice.transcribe' && voiceFailureShown) return null;
    return error ? text.commandRejected : null;
  };
  const copy = base();
  return copy === null ? null : named(copy);
}

/**
 * MobileRoot 手里的状态候选（语音失败在 Composer 里，那条由它自己补进同一个位）。
 * 断连期间连带后果不说（§12）：未确认送达、读取失败、命令卡住、没连上点发送都是断连造成的，
 * 只显示断连那一条——rank 本来就压得住它们，但后台暂停（paused）时连接那条不出，
 * 不在这里一起挡掉的话，暂停期间它们会冒出来。已连接不显示任何连接状态。
 */
export function composerStatusItems(
  text: ReturnType<typeof messages>,
  s: {
    saveError: boolean; nativeError: boolean; sendAttempted: boolean;
    binding: boolean; status: string; paused: boolean; connectionError: string | null; busy: boolean;
    commandError: string | null; commandErrorAction: string | null; voiceFailureShown: boolean; sessionId: string | null;
    libraryError: boolean; pending: boolean; pendingAction: string | null; pendingSlow: boolean;
  },
  act: { flush(): void; reconnect(): void; scan(): void; openRemote(): void; retryCreate: (() => void) | null; switchModel(): void },
): StatusItem[] {
  const items: StatusItem[] = [];
  if (s.saveError) items.push({ rank: 1, message: text.saveError, action: { label: text.retry, run: act.flush } });
  if (s.nativeError) items.push({ rank: 1, message: text.nativeError });
  const live = s.status === 'connected';
  if (s.binding && !live && !s.paused) {
    const open = act.openRemote;
    const reconnect = { label: text.reconnect, run: act.reconnect, disabled: s.busy };
    items.push(s.status === 'connecting' ? { rank: 2, message: text.connecting, neutral: true, open }
      : s.status === 'rejected' || connectionDiagnosis(text, s).action === 'scan' ? { rank: 2, message: text.rescanNeeded, open, action: { label: text.scanShort, run: act.scan, disabled: s.busy } }
      : s.connectionError === 'connectionRefused' ? { rank: 2, message: text.neoNotRunning, open, action: reconnect }
      : { rank: 2, message: text.cannotReachComputer, open, action: reconnect });
  } else if (!s.binding && s.sendAttempted) {
    // 从没配对过就点发送：唯一的出路是去连电脑。
    items.push({ rank: 2, message: text.cannotReachComputer, action: { label: text.remote, run: act.openRemote } });
  }
  if (!live) return items;
  const command = s.commandError === 'COMPANION_NOT_CONNECTED' ? null : commandNoticeCopy(text, s, s.voiceFailureShown);
  if (command) {
    const action = s.commandErrorAction === 'session.create' && s.commandError !== 'COMPANION_COMMAND_IN_FLIGHT' && act.retryCreate ? { label: text.retry, run: act.retryCreate }
      : s.commandError === 'MODEL_AUTH' && s.sessionId ? { label: text.switchModel, run: act.switchModel }
      : undefined;
    items.push({ rank: 4, message: command, action, reason: s.commandError ?? undefined });
  }
  if (s.libraryError) items.push({ rank: 5, message: text.libraryError, action: { label: text.reload, run: act.reconnect, disabled: s.busy } });
  if (s.pending && s.pendingAction === 'voice.transcribe') items.push({ rank: 7, message: `${text.transcribing}…`, neutral: true });
  // 正常 ack 几十毫秒就回来：慢过阈值才说（N-MOBILE-PENDING-NOISE）。「请勿重复发送」删了——确认前发送键本就不可点。
  else if (s.pending && s.pendingSlow) items.push({ rank: 6, message: text.pendingCommand, neutral: true });
  return items;
}
