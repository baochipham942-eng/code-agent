import type { CompanionArtifact, CompanionArtifacts, CompanionLibrary, CompanionHistory } from '../../../../src/shared/contract/companionLibrary';
import { createStore } from 'zustand/vanilla';
import { createIdentity } from '../../../../src/shared/companion/noiseChannel';
import { fromHex, toHex, parseInvitation, type LanBinding } from '../../../../src/shared/companion/lanProtocol';
import type { CompanionCommand, CompanionCommandRecord, CompanionEvent, CompanionSyncResult } from '../../../../src/shared/contract/companion';
import type {
  CompanionDictationFrameResult,
  CompanionDictationOpenResult,
} from '../../../../src/shared/contract/companionDictation';
import type { CompanionPushRegister, CompanionPushRegisterResult, CompanionPushOpenResult } from '../../../../src/shared/contract/companionPush';
import { companionCommandSchema } from '../../../../src/shared/contract/companion';
import { parseCompanionRelayRoute, type CompanionRelayRoute } from '../../../../src/shared/contract/companionRelay';
import { LanCompanionClient } from '../platform/lanCompanionClient';
import { RelayCompanionClient, browserRelayDial } from '../platform/relayCompanionClient';
import type { FilePorts, PlatformPorts, PickedFile } from '../platform/ports';
import { companionFileMime, companionFileRetryable, COMPANION_LIMITS } from '../../../../src/shared/constants/companion';
import { base64ToBytes, bytesToBase64, sha256Hex, type CacheInspect } from '../platform/fileCache';
import { HistoryCache } from '../platform/historyCache';
import { mdnsRefreshedEndpoint } from '../platform/mdnsEndpoint';
import { connectionBlocksAutoRetry, handshakeNeedsRescan, phoneReconnectDelayMs, phoneReconnectJitterMs } from '../app/phoneReconnect';

interface Saved {
  version: 1; publicKey: string; secretKey: string;
  candidate?: { endpoint: string; altEndpoint?: string; hostKey: string }; binding?: LanBinding; pending?: CompanionCommand;
  /** LAN 连着时从 Host 拿到的 relay 路由（含共享凭据，随整份配对记录进 Keychain）。 */
  relay?: CompanionRelayRoute;
}
type ConnectionError = 'connectionQrInvalid' | 'connectionScanFailed' | 'connectionRejected' | 'connectionRefused' | 'connectionUnavailable' | 'connectionFailed'
  | 'connectionRelayUnavailable' | 'connectionRelayRejected';
/** 双径（N-MOBILE-RELAY-PHONE）：LAN 直连优先；relay 是跨网回落路。UI 据此区分「经中继」。 */
type CompanionTransport = 'lan' | 'relay';

/**
 * 只有这几种 reason 说的是「这台设备不能用了」——撤销、主机不认、授权不覆盖、epoch 已翻篇，
 * 四者都要重新配对/重连才能恢复。其余（approval_conflict 抢答、payload 不符、动作不支持…）
 * 都只是**这一条命令**没成，连接本身照旧可用。
 * `status` 描述连接，命令结果写 `commandError`；两条 ack 路径共用这一个判据，别再各判各的。
 */
const DEVICE_LEVEL_REASONS = new Set(['device_revoked', 'device_unknown', 'scope_denied', 'scope_epoch_mismatch']);

/**
 * 一条转写命令的结局，**带着它是哪一条**。
 * 之前这里是个粘着的 `voiceOutcome: 'done'|'error'|null`：上一次录音、上一个会话留下的电平，
 * 下一次录音照样读得到，于是每加一条修法就多一道交叉判据（七轮 ai-review 的共因）。
 * 认 commandId 之后，陈旧结果连匹配都匹配不上，不需要谁负责去清它。
 */
export type VoiceResult = { commandId: string; outcome: 'done' | 'error' | 'silent'; code?: string };

/**
 * 输入区附件 chip 的瞬态传输状态。进度从 upload() 既有 prepare/chunk/commit 循环导出，
 * 不进 persist(Saved)——进程被杀后用户重新选文件即可，把 bytes 写进配对盘没有意义。
 */
export type UploadProgress = {
  id: string;
  name: string;
  totalBytes: number;
  sentBytes: number;
  phase: 'preparing' | 'transferring' | 'complete' | 'failed';
  error?: string;
  retryable?: boolean;
};

interface State {
  voiceResult: VoiceResult | null;
  /** 返回这条命令的 commandId（已进待确认槽）；没发出去回 null，分片队列据此重排队，不静默丢片。 */
  transcribe(audio: { audioData: string; mimeType: string; durationMs: number }, sessionId: string, hostKey: string, continuation?: boolean, take?: string | null): Promise<string | null>;
  /** 取消这次录音：晚到的结果不进草稿。按录音代号点名。 */
  discardPendingTranscript(take: string): void;
  dictationOpen(): Promise<CompanionDictationOpenResult>;
  dictationAudio(streamId: string, pcm: string): Promise<CompanionDictationFrameResult>;
  dictationStop(streamId: string): Promise<CompanionDictationFrameResult>;
  dictationClose(): Promise<void>;
  commitDictation(text: string, continuation: boolean, take: string, sentenceId: number): Promise<void>;
  library: CompanionLibrary | null; history: Record<string, CompanionHistory>; libraryError: boolean;
  refreshLibrary(more?: boolean): Promise<void>; loadHistory(id: string, more?: boolean): Promise<void>;
  /** 只刷新模型表（含「最近调用失败」），不动会话分页——refreshLibrary 会按第一页整表替换会话。 */
  refreshModels(): Promise<void>;
  manage(action: 'session.create' | 'session.rename' | 'session.archive' | 'session.delete' | 'session.model', payload: Record<string, unknown>, target?: string): Promise<void>;
  connectionError: ConnectionError | null;
  /** Why the last command was refused. Connection-level standing stays in `status`. */
  commandError: string | null;
  /**
   * 这条 commandError 是哪种命令产生的。
   * 输入区那条带阶段的失败提示只负责转写，通用提示条据此让位——按**动作**分，
   * 不是按码名列白名单：结算原样带回真实错误码之后，白名单外的转写失败会叠出两句
   * （grok ai-review Nit，正是 09-12 消掉的那个双重提示从新门回来）。
   */
  commandErrorAction: CompanionCommand['action'] | null;
  status: 'unpaired' | 'connecting' | 'connected' | 'offline' | 'storageError' | 'rejected';
  /** 这次连接走的是哪条路：LAN 直连还是 relay 中继（null = 未连接）。 */
  transport: CompanionTransport | null;
  /**
   * 「是我们自己把一条活连接停了」——app 退到后台时 pause() 会关掉客户端。
   * 这与「连不上电脑」在 status 上都是 offline，但对用户是两件事：后台期间没有任何事
   * 需要他做，报「电脑尚未连接，请重试」是假警报，而 iOS 的应用切换器快照恰好拍在这一刻
   * （2026-09-12 爸真机反馈：Neo 还没关，卡片上就写着未连接）。
   */
  paused: boolean;
  binding: LanBinding | null; sessionId: string | null; pending: boolean; busy: boolean;
  /** 待确认命令是哪一条：状态行的文案按它分——语音转写不是「发送」，不该提醒「请勿重复发送」。 */
  pendingAction: CompanionCommand['action'] | null;
  /**
   * 这一槽是不是 hydrate 从盘上捡回来的（而不是本次会话里刚发出去的）。捡回来的已经等了
   * 不知道多久，UI 那边不该再从 0 憋一遍延迟（N-MOBILE-PENDING-NOISE / grok Nit②）。
   * 放在 store 而不是 UI 侧推断：store 初始 pending 恒为 false，UI 用「第一次见到 pending」
   * 这种时序推断必然落空——实测就是这么落空的。
   */
  pendingAdopted: boolean;
  events: CompanionEvent[]; runId: string | null; terminal: 'complete' | 'stopped' | 'failed' | null;
  hydrate(): Promise<void>; pair(raw?: string): Promise<void>;
  /** `resetBackoff`：点「重新连接」立即试并重置节奏。回前台不传，只立即试、10 分钟钟继续走。 */
  reconnect(opts?: { resetBackoff?: boolean }): Promise<void>; forget(): Promise<void>; pause(): void;
  /** 前台断线后正在按退避自动重试。状态位据此保持「正在自动重试」，不闪「正在连接…」。 */
  autoRetrying: boolean;
  /**
   * 眼下占着 busy 的连接尝试是不是自动发起的（重试定时器/冷启动/回前台）。自动尝试在途
   * 不锁「重新连接/扫描电脑二维码」两个按钮（N-MOBILE-AUTO-RECONNECT-R3 D3）：在途 hello
   * 可达 10s，照旧置灰等于八成时间没给用户逃生口。手动点按（扫码、手动重连）仍占 busy 锁键。
   */
  autoAttempt: boolean;
  /** 扫码重新配对时丢掉了未确认操作：状态位一次性「上一条操作没送到…」直到点「知道了」。 */
  abandonedPending: boolean;
  dismissAbandonedPending(): void;
  respond(requestId: string, decision: 'approved' | 'rejected'): Promise<void>;
  respondQuestion(requestId: string, answers: Record<string, string | string[]>, declined?: boolean, reason?: string): Promise<void>;
  respondPlan(requestId: string, decision: 'approved' | 'rejected', feedback?: string): Promise<void>;
  routeError: string | null;
  registerPush(input: CompanionPushRegister): Promise<CompanionPushRegisterResult>;
  unregisterPush(): Promise<void>;
  openRoute(routeToken: string): Promise<void>;
  /** 推送属于哪条会话：只查不跳转（前台抑制用）。查不到、没连着、走 relay 时给 null。 */
  resolveRoute(routeToken: string): Promise<string | null>;
  selectSession(id: string): void; send(text: string): Promise<void>; stop(): Promise<void>; sync(): Promise<void>;
  artifacts: CompanionArtifact[]; preview: (CompanionArtifact & { bytes: Uint8Array }) | null; savedPreview: boolean; savedPreviewName: string | null;
  cacheUsage: CacheInspect | null;
  /** Last successful sync that wrote the conversation cache. Null until a sync lands. */
  lastSyncAt: number | null;
  /** 输入区附件 chip。瞬态，不进 persist(Saved)。 */
  uploadProgress: UploadProgress[];
  upload(file: PickedFile, transferId?: string): Promise<void>;
  retryUpload(id: string): Promise<void>;
  removeUpload(id: string): void;
  previewArtifact(artifactId: string): Promise<void>;
  closePreview(): void;
  savePreview(): Promise<void>;
  refreshArtifacts(): Promise<void>;
  clearCache(): CacheInspect;
}

/**
 * 「这条命令此刻有没有一个可寻址的会话」——send / transcribe / respond 三处共用的判据。
 * 任何一项不满足时它们都是**静默 return**，所以界面不能只看 status==='connected'：
 * 全量 project 授权（或旧的只授权项目）配对后 sessionId 为 null，必须先从库列表选会话。
 */
export function canAddressSession(state: Pick<State, 'status' | 'sessionId'>): boolean {
  return state.status === 'connected' && Boolean(state.sessionId);
}

/** 连着但没有会话（只授权项目的配对、或还没选会话）：发送时先在默认项目建会话（N-MOBILE-DEFAULT-PROJECT），不弹选择项目。 */
export function needsLibraryPick(state: Pick<State, 'status' | 'sessionId'>): boolean {
  return state.status === 'connected' && !state.sessionId;
}

/** Receipt identity: a status/result from a different command must not settle this one. */
export function companionAckMatches(
  pending: Pick<CompanionCommand, 'commandId' | 'deviceId' | 'sessionId' | 'action'>,
  record: Pick<CompanionCommandRecord, 'commandId' | 'deviceId' | 'sessionId' | 'action'>,
): boolean {
  return record.commandId === pending.commandId && record.deviceId === pending.deviceId
    && record.sessionId === pending.sessionId && record.action === pending.action;
}

/** LAN 与 relay 两个客户端共同的最小面：所有 store 路径只认这两个动作。 */
interface CompanionChannel {
  request(payload: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export function createCompanionStore(port: PlatformPorts['companion'], onAccepted: (text: string, sessionId: string, hostKey: string) => void | Promise<void>, onTranscript?: (text: string, sessionId: string, hostKey: string, commandId: string, continuation: boolean) => Promise<void>, files?: FilePorts, historyCache?: HistoryCache, options?: {
  /** 这台电脑上次打开的会话。`''` = 欢迎页；缺省 = 沿用 scope 里第一条会话（旧客户端）。 */
  lastSession?(hostKey: string): string | undefined;
  rememberSession?(hostKey: string, sessionId: string | null): void;
  /** 会话删除清一条、配对撤销/忘掉电脑清整台的标题记忆（sessionTitles 只增不删的补口）。 */
  forgetSessionTitles?(hostKey: string, sessionId?: string): void;
}) {
  let saved: Saved | null = null;
  let client: CompanionChannel | null = null;
  /** 双径不双跑：任一时刻只有一条活通道，另一条的句柄只用来收尾 close。 */
  let relayClient: RelayCompanionClient | null = null;
  let epoch = 1; let cursor = 0;
  let syncing = false;
  /** 在飞的这条转写是不是「同一次录音的后续分片」——只影响草稿里要不要换行，故不持久化。 */
  let transcriptContinuation = false;
  /**
   * 在飞那条语音命令属于**哪一次录音**，以及**哪一次录音**已被用户取消；两者都非空且相等
   * ⇒ 这是晚到结果，不进草稿。
   * 记录音代号而不是 commandId：取消可能正好落在 transcribe 已过守卫、还没 persist 的那一刻，
   * 那时根本还没有 commandId 可记，而代号在进 transcribe 时就由输入区给定了（grok ai-review Nit）。
   * `voiceTake` 初始为 null 且要求非空匹配：进程重启后重放那条 pending 命令时代号已经没了，
   * 那时必须当「没被取消」处理，否则用户上次说的话会被无声吞掉。
   * 取消侧必须是**集合**不是单槽：协议一次只放一条命令，所以「取消 A（A 的分片已进槽、ack 还
   * 在路上）→ 再录 B（发不出去，槽被 A 占着）→ 再取消 B」这条真机时序里，后一次取消会把前一次
   * 的代号盖掉，A 的晚到结果就漏网写进草稿（grok ai-review Important）。
   * 集合在下一条命令进槽时清空——那时槽是空的，先前被取消的那些必然已经结算完了。
   */
  let voiceTake: string | null = null;
  const discardedTakes = new Set<string>();
  /** 失败重传要用原文件；不进 Zustand/Saved，避免把 bytes 写进配对盘。 */
  const heldAttachments = new Map<string, PickedFile>();
  const history = historyCache ?? new HistoryCache();

  const store = createStore<State>((set, get) => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    let retryStartedAt: number | null = null;
    let retryGeneration = 0;
    let appInBackground = false;
    /**
     * 在途 reconnect 的**计数**而不是布尔：重连在途时再调一次 reconnect()（回前台等）会在
     * safely 的 busy 守卫处早退，早退那次的 finally 若把共享布尔清掉，真正在途的尝试失败时
     * 就被当成「不是重连失败」——0 延迟重试且不升退避档（ai-review Nit）。计数到 0 才算没有。
     */
    let reconnectDepth = 0;
    /**
     * 连接尝试代号（pair / reconnect 各领一个）：手动「重新连接」/扫码抢过在途的自动尝试后，
     * 旧尝试迟到的失败/成功都按代号丢弃——不打回 offline、不关新客户端、不释放新尝试的 busy
     * （N-MOBILE-AUTO-RECONNECT-R3 D3）。
     */
    let connectSeq = 0;
    /** 用户正在扫码配对：自动重连不得清 busy、不得把 status 打回 offline。 */
    let userPairing = false;
    /** 这次连接已经成功 sync 过。握手成功不算数，否则 sync 一失败就会把档位清零再 0 延迟重连。 */
    let syncOk = false;
    const clearRetryTimer = () => {
      if (retryTimer === null) return;
      clearTimeout(retryTimer);
      retryTimer = null;
    };
    const stopAutoRetry = () => {
      retryGeneration += 1;
      clearRetryTimer();
      retryAttempt = 0;
      retryStartedAt = null;
      syncOk = false;
      if (get().autoRetrying) set({ autoRetrying: false });
    };
    const markSyncOk = () => {
      stopAutoRetry();
      syncOk = true;
    };
    const remember = (sessionId: string | null) => {
      const hostKey = saved?.binding?.hostKey ?? get().binding?.hostKey;
      if (hostKey) options?.rememberSession?.(hostKey, sessionId);
    };
    /**
     * `ignoreBlocked`：有原绑定时「扫码本身失败」（二维码解不开/扫码取消）后重挂用的——
     * connectionQrInvalid/ScanFailed 本该停机，但那是给**没有原绑定**的首扫失败定的规矩；
     * 「这次扫码没成」不等于「这台电脑不能重试」。提示不靠重挂节奏续命：safely 的静默保留
     * 让它活到这次重试自己给出新结论（新错误码或连上）为止。
     */
    const armAutoRetry = (fromFailedAttempt: boolean, ignoreBlocked = false) => {
      if (userPairing) return;
      const blocked = connectionBlocksAutoRetry(get().status, get().connectionError) || !saved?.binding;
      if (appInBackground || (blocked && !ignoreBlocked)) {
        if (blocked && !ignoreBlocked) stopAutoRetry();
        else { retryGeneration += 1; clearRetryTimer(); if (get().autoRetrying) set({ autoRetrying: false }); }
        return;
      }
      if (!fromFailedAttempt && !get().autoRetrying) {
        retryAttempt = 0;
        retryStartedAt = Date.now();
      }
      if (fromFailedAttempt) retryAttempt += 1;
      if (retryStartedAt == null) retryStartedAt = Date.now();
      set({ autoRetrying: true });
      const wait = fromFailedAttempt
        ? phoneReconnectJitterMs(phoneReconnectDelayMs(retryAttempt, Date.now() - retryStartedAt))
        : 0;
      const schedule = (delay: number) => {
        clearRetryTimer();
        const gen = retryGeneration;
        retryTimer = setTimeout(() => {
          if (gen !== retryGeneration || appInBackground) return;
          retryTimer = null;
          // 扫码等 safely 占着时这一拍不能空消耗：不递增档位，按当前等待再挂一次。
          if (get().busy) {
            schedule(delay || phoneReconnectJitterMs(phoneReconnectDelayMs(Math.max(retryAttempt, 1), Date.now() - (retryStartedAt ?? Date.now()))));
            return;
          }
          void get().reconnect();
        }, delay);
      };
      schedule(wait);
    };
    const inspectBoth = (): CacheInspect => {
      const preview = files?.cache.inspect() ?? { previewBytes: 0, conversationBytes: 0, protectedBytes: 0 };
      return { previewBytes: preview.previewBytes, conversationBytes: history.inspect().conversationBytes, protectedBytes: preview.protectedBytes };
    };
    const wipeHistoryCache = () => {
      const freed = history.clear();
      set({ history: {}, events: [], lastSyncAt: null, cacheUsage: inspectBoth() });
      return freed;
    };
    const explicitSessionIds = (scope: readonly string[]) => scope.filter(id => !id.startsWith('project:'));
    const applyHistoryView = (historyState: Record<string, CompanionHistory>, events: CompanionEvent[], sessionId: string | null) => {
      set({ history: historyState, events, lastSyncAt: history.snapshot().lastSyncAt, cacheUsage: inspectBoth(), sessionId });
    };
    const pruneUnscopedHistory = (previousScope: readonly string[], nextScope: readonly string[]) => {
      const nextExplicit = new Set(explicitSessionIds(nextScope));
      const droppedExplicit = explicitSessionIds(previousScope).filter(id => !nextExplicit.has(id));
      const lostProject = previousScope.some(id => id.startsWith('project:') && !nextScope.includes(id));
      for (const id of droppedExplicit) history.dropSession(id);
      if (lostProject) history.retainSessions(nextExplicit);
      if (!droppedExplicit.length && !lostProject) return;
      const drop = new Set(droppedExplicit);
      const allowed = lostProject ? nextExplicit : null;
      const keep = (id: string) => (allowed ? allowed.has(id) : !drop.has(id));
      const nextHistory = Object.fromEntries(Object.entries(get().history).filter(([id]) => keep(id)));
      const nextEvents = get().events.filter(event => !event.sessionId || keep(event.sessionId));
      const current = get().sessionId;
      applyHistoryView(nextHistory, nextEvents, current && !keep(current) ? (explicitSessionIds(nextScope)[0] ?? null) : current);
    };
    const persist = async (next: Saved) => {
      if (!port) throw new Error('COMPANION_NATIVE_REQUIRED');
      // 只写 Saved 的已知字段：hydrate 的 JSON.parse 可能带上盘里多出来的键
      // （比如误写入的 uploadProgress），spread next 会把瞬态字段写进配对盘。
      const record: Saved = {
        version: 1, publicKey: next.publicKey, secretKey: next.secretKey,
        ...(next.candidate ? { candidate: next.candidate } : {}),
        ...(next.binding ? { binding: next.binding } : {}),
        ...(next.pending ? { pending: next.pending } : {}),
        ...(next.relay ? { relay: next.relay } : {}),
      };
      // 待确认槽被清掉、而这条语音还没有任何结论 ⇒ 给它一个终局。
      // 清槽的路不止「结算」一条：被拒（scope_denied / scope_epoch_mismatch…）、抢答冲突、
      // reconciling 超时回收，都在别处清槽而不写结果；分片队列等的就是这条命令的结果，
      // 等不到就一直 awaiting，语音面板永不收口（grok ai-review Important）。
      // 结算那条路在调用本函数之前已经给**这个 commandId**写好结果了，不会被这里覆盖。
      const orphanVoice = saved?.pending?.action === 'voice.transcribe' && !next.pending
        && get().voiceResult?.commandId !== saved.pending.commandId ? saved.pending.commandId : null;
      try {
        await port.write(JSON.stringify(record)); saved = record;
        // 落盘记录是待确认命令的唯一真源，派生放在这一处，省得九个 set({pending}) 各自同步。
        // 两个字段必须同一拍置起：只改 pendingAction 的话，结算那一帧会是
        // pending=true + pendingAction=null，状态行闪回「请勿重复发送」——正是本单要消掉的那句。
        set({ pending: Boolean(next.pending), pendingAction: next.pending?.action ?? null, pendingAdopted: false,
          ...(orphanVoice ? { voiceResult: { commandId: orphanVoice, outcome: 'error' as const } } : {}) });
      }
      catch (error) { client?.close(); set({ status: 'storageError' }); throw error; }
    };
    const patchUpload = (id: string, partial: Partial<UploadProgress>) => {
      set({ uploadProgress: get().uploadProgress.map(item => item.id === id ? { ...item, ...partial } : item) });
    };
    /**
     * 待确认槽里那条语音命令，是不是用户已经撤掉的那次录音的。
     * 清槽的路有三条（结算被拒 / deliver 当场被拒 / reconciling 超时回收），三条都会写
     * `commandError`；撤掉的动作不该再报错，所以判据抽在这里一处，别只堵住其中一条
     *（grok ai-review Nit：只补了结算那条，另外两条照样冒「电脑那边拒绝了这条操作」）。
     * 必须在 persist 清掉 `saved.pending` **之前**取值。
     */
    const pendingVoiceDiscarded = () => saved?.pending?.action === 'voice.transcribe'
      && voiceTake !== null && discardedTakes.has(voiceTake);
    const createClient = (): LanCompanionClient => {
      if (!saved || !port) throw new Error('COMPANION_NATIVE_REQUIRED');
      client?.close();
      const lan = new LanCompanionClient({ publicKey: fromHex(saved.publicKey, 32), secretKey: fromHex(saved.secretKey, 32) }, port.post);
      client = lan;
      return lan;
    };
    /**
     * 落 relay（N-MOBILE-RELAY-PHONE）：用配对时缓存的路由拨 WSS、IK 握手回 Host。
     * 绑定身份以 LAN 配对时的缓存为准逐字段校验——relay 只换路，不换身份；
     * resume 成功后 `client` 指到 relay 通道，LAN 客户端此刻必然已关（recover 失败即关）。
     */
    const dialRelay = async (attempt?: number): Promise<RelayCompanionClient> => {
      if (!saved?.relay || !saved.binding) throw new Error('COMPANION_RELAY_UNCONFIGURED');
      relayClient?.close();
      const relay = new RelayCompanionClient({
        identity: { publicKey: fromHex(saved.publicKey, 32), secretKey: fromHex(saved.secretKey, 32) },
        route: saved.relay,
        deviceRef: saved.binding.deviceId,
        dial: port?.dialRelay ?? browserRelayDial,
        onRevoked: () => {
          relayClient?.close();
          client?.close();
          wipeHistoryCache();
          stopAutoRetry();
          remember(null);
          // 撤销即清这台电脑的标题记忆：会话已不属于这台手机，重新配对后随使用再记。
          const revokedHostKey = saved?.binding?.hostKey;
          if (revokedHostKey) options?.forgetSessionTitles?.(revokedHostKey);
          set({ status: 'rejected', connectionError: 'connectionRejected', transport: null, sessionId: null });
        },
      });
      await relay.connect();
      await relay.resume({ hostKey: saved.binding.hostKey, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch, scope: saved.binding.scope });
      // 拨号期间被更新的尝试抢占了：这条通道不留（同一时刻只有一条活通道），交给抢占者。
      if (attempt !== undefined && attempt !== connectSeq) {
        relay.close();
        throw new Error('COMPANION_ATTEMPT_PREEMPTED');
      }
      relayClient = relay;
      client = relay;
      return relay;
    };
    /** 趁 LAN 连着刷新缓存的 relay 路由（Host 重启会换 routeToken）。尽力而为，不许打断 LAN 会话。 */
    const refreshRelayRoute = async () => {
      if (!client || client === relayClient || !saved?.binding || !port) return;
      // 路由探针走自己的一条短命 resume 通道，绝不碰会话通道：relay.route 是新动作，旧 Host
      // 的 exchange 对未知动作的处置是「关 channel」——在会话通道上问一句，整条会话陪葬
      // （2026-09-15 真机首验：配对后首次 sync 即掉线，重连-再陪葬死循环，relay 永远没机会开火）。
      // 探针死了只是没路由可缓存；会话通道毫发无损。
      const probe = new LanCompanionClient({ publicKey: fromHex(saved.publicKey, 32), secretKey: fromHex(saved.secretKey, 32) }, port.post);
      try {
        await probe.recover(saved.binding);
        const result = await probe.request({ action: 'relay.route' }) as { kind?: unknown; url?: unknown; routeToken?: unknown; credential?: unknown };
        if (result?.kind !== 'ok' || typeof result.url !== 'string' || typeof result.routeToken !== 'string' || typeof result.credential !== 'string') return;
        const route = parseCompanionRelayRoute({ v: 1, url: result.url, routeToken: result.routeToken, credential: result.credential });
        if (saved.relay?.url === route.url && saved.relay.routeToken === route.routeToken) return;
        await persist({ ...saved, relay: route });
      } catch { /* 路由刷新失败不影响 LAN 会话；下一次重连再试 */ }
      finally { probe.close(); }
    };
    const accepted = async (record: CompanionCommandRecord) => {
      const pending = saved?.pending;
      /** 这条是被用户取消掉的那次录音的——被拒时不要再弹通用报错，那个动作他已经撤了。 */
      const discardedVoice = pendingVoiceDiscarded();
      /** 这条转写回的是「这段没人说话」——同样不该弹通用报错（2026-09-13 真机 43% 的段都是它）。 */
      let silentVoice = false;
      if (!pending || !companionAckMatches(pending, record)) throw new Error('COMPANION_INVALID_ACK');
      if (record.state === 'reconciling') return;
      if (!['accepted', 'resolved', 'rejected', 'conflict'].includes(record.state)) throw new Error('COMPANION_INVALID_ACK');
      if (record.state !== 'rejected' && record.state !== 'conflict' && pending.action === 'message.send') {
        // Retain the command reservation until the draft has durably cleared.
        await onAccepted(pending.payload.text, pending.sessionId, saved!.binding!.hostKey);
      }
      if (pending.action === 'voice.transcribe') {
        // 用户已经取消了这次录音：这条是晚到结果，不许再往草稿里写（screen-contract「取消过滤晚到结果」）。
        // 代号不在这里清：一次取消可能有好几段在飞/在途，被第一条 ack 消耗掉的话，
        // 后面那几段照样写进草稿（grok ai-review Important）。下一段自带新代号，不会误伤。
        if (record.state === 'accepted' && typeof record.result.text === 'string' && onTranscript && !discardedVoice) {
          await onTranscript(record.result.text, pending.sessionId, saved!.binding!.hostKey, pending.commandId, transcriptContinuation);
          set({ voiceResult: { commandId: pending.commandId, outcome: 'done' } });
        } else {
          // 「这段没人说话」是第三种结局：分片下停顿段本来就是空的，当失败就是每隔几秒报一次错。
          const code = typeof record.result.code === 'string' ? record.result.code : undefined;
          // 「这段没人说话」由主机在结算时给出结论（`silent`），手机不自己再判一次码——
          // 两边各判各的，码一变就漂。
          silentVoice = record.result.silent === true;
          set({ voiceResult: { commandId: pending.commandId, outcome: silentVoice ? 'silent' : 'error', code } });
        }
      }
      await persist({ ...saved!, pending: undefined });
      set({ pending: false });
      if (record.state === 'rejected' || record.state === 'conflict') {
        // 单条命令被拒（转写失败 / RUN_NOT_ACTIVE / 审批被抢答）不代表这台设备不能用了。
        // 置成 status:'rejected' 会挡住 sync 和后续每一条命令，事件流从此停摆到手动重连。
        // 已取消的那次录音被拒不报：再弹一句「电脑那边拒绝了这条操作」，说的是用户刚撤掉的动作
        // （grok ai-review Nit）。
        if (!discardedVoice && !silentVoice) set({ commandError: typeof record.result.code === 'string' ? record.result.code : 'COMPANION_COMMAND_REJECTED', commandErrorAction: pending.action });
        return;
      }
      if (pending.action === 'session.create' && typeof record.result.sessionId === 'string') set({ sessionId: record.result.sessionId, runId: null, terminal: null });
      if (pending.action === 'session.delete') {
        // 会话真删掉了：标题记忆跟着清，否则 sessionTitles 随历史会话数无限增长（ai-review Nit）。
        const deletedHostKey = saved?.binding?.hostKey;
        if (deletedHostKey) options?.forgetSessionTitles?.(deletedHostKey, pending.sessionId);
        if (get().sessionId === pending.sessionId) set({ sessionId: null, runId: null, terminal: null });
      }
      if (pending.action.startsWith('session.')) await get().refreshLibrary();
      if (pending.action === 'message.send' && get().sessionId === pending.sessionId) {
        const runId = typeof record.result.runId === 'string' ? record.result.runId : null;
        const terminal = get().events.filter(event => event.payload.runId === runId && ['agent_complete', 'agent_cancelled', 'error'].includes(event.kind)).at(-1);
        set({ runId: terminal ? null : runId, terminal: terminal ? terminal.kind === 'agent_complete' ? 'complete' : terminal.kind === 'agent_cancelled' ? 'stopped' : 'failed' : null });
      }
    };
    const recoverStalePending = async (record: CompanionCommandRecord | null) => {
      const pending = saved?.pending;
      if (!pending || !record || record.state !== 'reconciling') return false;
      if (Date.now() - record.createdAt < COMPANION_LIMITS.reconcilingRecoveryMs) return false;
      // Do not redispatch an uncertain command. Release the UI lock while
      // leaving the user's draft untouched (the command payload is separate
      // from the draft store); the host reservation is never reused.
      const discardedVoice = pendingVoiceDiscarded();
      await persist({ ...saved!, pending: undefined });
      set({ pending: false, ...(discardedVoice ? {} : { commandError: 'COMPANION_COMMAND_RECONCILING_TIMEOUT', commandErrorAction: pending.action }) });
      return true;
    };
    const deliver = async (): Promise<CompanionCommandRecord | null> => {
      if (!saved?.pending || !client) return null;
      const result = await client.request({ action: 'command', command: saved.pending }) as { kind: string; reason?: string; command?: CompanionCommandRecord };
      if (['accepted', 'replayed'].includes(result.kind) && result.command) {
        await accepted(result.command);
        return result.command;
      }
      if (['rejected', 'conflict', 'approval_conflict'].includes(result.kind)) {
        // 拒绝理由要跟着这条命令的结果走，否则输入区只拿得到 persist 那道兜底的通用码。
        const voice = saved.pending?.action === 'voice.transcribe' ? saved.pending.commandId : null;
        const discardedVoice = pendingVoiceDiscarded();
        // 动作也要在 persist 清槽**之前**捕获：清完再读恒是 null，按动作让位在这条路上直接失效
        //（grok ai-review Nit；同 voice / discardedVoice 一个纪律，我漏了这一个）。
        const rejectedAction = saved.pending?.action ?? null;
        await persist({ ...saved, pending: undefined });
        // 按语义分，不按「它是不是 rejected」分。桌面或另一台手机先批了同一条审批时，
        // 网关回的是 approval_conflict——那是正常抢答，把整台设备停掉是错的。
        if (typeof result.reason === 'string' && DEVICE_LEVEL_REASONS.has(result.reason)) {
          // 设备级的拒绝照报：那是「这台设备不能用了」，与用户撤没撤这次录音无关。
          wipeHistoryCache();
          stopAutoRetry();
          remember(null);
          const revokedHostKey = saved?.binding?.hostKey;
          if (revokedHostKey) options?.forgetSessionTitles?.(revokedHostKey);
          set({ pending: false, status: 'rejected', connectionError: 'connectionRejected', transport: null, sessionId: null });
        } else if (discardedVoice) {
          set({ pending: false });
        } else {
          set({ pending: false, commandError: result.kind === 'approval_conflict' ? 'COMPANION_APPROVAL_CONFLICT' : result.reason ?? 'COMPANION_COMMAND_REJECTED', commandErrorAction: rejectedAction });
        }
        if (voice) set({ voiceResult: { commandId: voice, outcome: 'error', code: get().commandError ?? undefined } });
        return result.command ?? null;
      }
      throw new Error('COMPANION_INVALID_ACK');
    };
    const releasePending = async () => {
      if (saved?.pending) await persist({ ...saved, pending: undefined });
      set({ pending: false });
    };
    const safely = async <T>(work: (attempt: number | undefined) => Promise<T>, opts?: {
      preempt?: boolean;
      /** 连接尝试（pair/reconnect）传 true：过 busy 守卫后领代号，work 收到自己的代号。 */
      claim?: boolean;
      /** 这次 busy 是自动发起的尝试（D3）：UI 据此不锁「重新连接/扫码」按钮。 */
      autoAttempt?: boolean;
    }): Promise<T | undefined> => {
      if (get().busy && !opts?.preempt) return undefined;
      const attempt = opts?.claim === true ? (connectSeq += 1) : undefined;
      // 静默自动重试不清「二维码无效/扫码失败」：这两句说的是用户上一次扫码，重连本身推翻不了
      // 它——保留到这次重试自己产生新的错误码（catch 整拍覆盖）或连上（成功路径显式清）为止。
      // 否则已配对用户扫到非 Neo 码，提示只在 0 延迟重挂那一拍存在，随即被清成「电脑没回应」
      // （ai-review Important，相对 main 的回归）。
      const heldError = opts?.autoAttempt === true
        && (get().connectionError === 'connectionQrInvalid' || get().connectionError === 'connectionScanFailed')
        ? get().connectionError : null;
      set({ busy: true, autoAttempt: opts?.autoAttempt === true, connectionError: heldError, commandError: null, commandErrorAction: null });
      try { return await work(attempt); } catch (error) {
        // 被更新的尝试抢占了：迟到的旧失败整体作废——不关新客户端、不打回 offline、不挂重试、不释放新尝试的 busy。
        if (attempt !== undefined && attempt !== connectSeq) return;
        // 扫码抢占后，过期的自动重连失败不能把刚配上的连接打回 offline。
        // 「自己已连上后的失败」（如核对待确认命令超时）不再吞：代号比对已覆盖抢占场景，
        // 吞掉会让一条死通道停在 connected（ai-review Nit）。
        if (!opts?.preempt && userPairing) return;
        client?.close();
        // 设备已被撤销/拒绝（rejected）时，这条失败只是撤销的连带（relay revoke 帧先 drop 再
        // onRevoked，sync 的失败随后到）：不把 rejected 打回 offline、不挂自动重试，否则状态位
        // 先闪「正在自动重试」再变回「需要重新扫码」（N-MOBILE-AUTO-RECONNECT-R3 O2）。
        // 但 safely 进场已把 connectionError 清成 null，不补回的话，被撤销后扫到非 Neo 二维码，
        // 连接页诊断会从「需要重新扫码」变成「电脑没回应」（ai-review Nit）。
        if (get().status === 'rejected') { set({ connectionError: 'connectionRejected' }); return; }
        const code = error instanceof Error ? error.message : '';
        // 三分类（fix4-②）+ relay 档（N-MOBILE-RELAY-PHONE）：握手/身份失败、连接被拒绝、
        // 超时/无响应、relay 路失败（连不上/凭据被拒）——其余网络码都归「没回应」那一类，
        // UI 按类给人话，不再一律「无法连接电脑」。
        const connectionError: ConnectionError = code === 'COMPANION_INVALID_INVITATION' ? 'connectionQrInvalid'
          : code === 'COMPANION_SCAN_FAILED' ? 'connectionScanFailed'
          : code === 'COMPANION_PAIRING_REJECTED' || handshakeNeedsRescan(code) ? 'connectionRejected'
          : code === 'COMPANION_CONNECTION_REFUSED' ? 'connectionRefused'
          : code === 'COMPANION_RELAY_AUTH_REJECTED' ? 'connectionRelayRejected'
          : code === 'COMPANION_RELAY_UNAVAILABLE' || code === 'COMPANION_RELAY_CONNECT_TIMEOUT' ? 'connectionRelayUnavailable'
          : code === 'COMPANION_NETWORK_UNAVAILABLE' || code === 'COMPANION_NO_RESPONSE' ? 'connectionUnavailable' : 'connectionFailed';
        if (get().status !== 'storageError') set({ status: 'offline', connectionError, transport: null });
        armAutoRetry(reconnectDepth > 0);
      }
      finally {
        if (attempt !== undefined && attempt !== connectSeq) return;
        if (!(userPairing && !opts?.preempt)) set({ busy: false });
      }
    };
    /** （重）连上后结算待确认命令：两条路（LAN/relay）共用同一套 status 查询与补投。 */
    const reconcilePending = async () => {
      if (!saved?.pending || !client) return;
      const record = await client.request({ action: 'status', commandId: saved.pending.commandId }) as CompanionCommandRecord | null;
      if (record && !(await recoverStalePending(record))) await accepted(record);
      else if (!record) await deliver();
    };
    return {
      voiceResult: null, library: null, history: {}, libraryError: false,
      connectionError: null, commandError: null, commandErrorAction: null, routeError: null, status: 'unpaired', paused: false, transport: null, binding: null, sessionId: null, busy: false, pending: false, pendingAction: null, pendingAdopted: false, autoRetrying: false, autoAttempt: false, abandonedPending: false, events: [], runId: null, terminal: null,
      artifacts: [], preview: null, savedPreview: false, savedPreviewName: null, cacheUsage: inspectBoth(), lastSyncAt: null,
      uploadProgress: [],
      hydrate: async () => {
        if (!port || get().busy) return;
        set({ busy: true });
        try {
          const raw = await port.read();
          if (!raw) {
            wipeHistoryCache();
            set({ busy: false });
            return;
          }
          const value = JSON.parse(raw) as Saved;
          if (value.version !== 1) throw new Error('COMPANION_INVALID_STORAGE');
          fromHex(value.publicKey, 32); fromHex(value.secretKey, 32);
          if (value.pending) companionCommandSchema.parse(value.pending);
          // 缓存的 relay 路由不整份拒绝配对盘：坏一条路由丢一条，配对身份不该跟着陪葬。
          try { if (value.relay) value.relay = parseCompanionRelayRoute(value.relay); }
          catch { delete value.relay; }
          saved = value;
          try { await history.hydrate(); } catch { /* conversation cache is best-effort and must not fail pairing identity */ }
          const restored = history.snapshot();
          const last = value.binding ? options?.lastSession?.(value.binding.hostKey) : undefined;
          const fromScope = value.binding?.scope.find(id => !id.startsWith('project:')) ?? null;
          const sessionId = last === '' ? null : (last || fromScope);
          set({
            busy: false, binding: value.binding ?? null,
            sessionId,
            pending: !!value.pending, pendingAction: value.pending?.action ?? null, pendingAdopted: !!value.pending,
            history: restored.history, events: restored.events, lastSyncAt: restored.lastSyncAt, cacheUsage: inspectBoth(),
          });
          if (value.candidate || value.binding) await get().reconnect();
        } catch { set({ busy: false, status: 'storageError' }); }
      },
      pair: async (raw?: string) => {
        // 扫码前原本就有的绑定：握手失败时恢复它，前台退避自动重连接着跑（D1）——
        // 用户只是扫了一下码，不该把原本能用的配对弄丢后卡死在「电脑没回应」。
        const previousBinding = saved?.binding;
        // 扫码必须抢过自动重连占着的 busy：否则扫完 finishPair→pair 被静默丢掉。
        userPairing = true;
        stopAutoRetry();
        appInBackground = false;
        set({ paused: false, autoRetrying: false });
        client?.close();
        let attempt = 0;
        try {
          return await safely(async seq => {
            attempt = seq ?? 0;
            if (!port) return;
            const dropPending = Boolean(saved?.pending);
            const payload = raw ?? await port.scan().catch(() => { throw new Error('COMPANION_SCAN_FAILED'); });
            // 原生扫码与每次落盘都是可被抢占的窗口（再扫一次/手动重连会领新代号）：守卫不过就
            // 整体作废，迟到的旧扫码不得覆盖抢占者的状态，更不得 createClient() 关掉抢占者
            // 刚建立的活客户端（ai-review Important，与 reconnect 的 mDNS 窗口同一条纪律）。
            if (seq !== undefined && seq !== connectSeq) return;
            let invitation;
            try { invitation = parseInvitation(payload); } catch { throw new Error('COMPANION_INVALID_INVITATION'); }
            set({ status: 'connecting' });
            if (!saved) {
              const identity = createIdentity();
              await persist({ version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey) });
              identity.secretKey.fill(0);
            }
            if (seq !== undefined && seq !== connectSeq) return;
            await persist({ ...saved!, candidate: { endpoint: invitation.endpoint, ...(invitation.altEndpoint ? { altEndpoint: invitation.altEndpoint } : {}), hostKey: invitation.hostKey }, binding: undefined });
            if (seq !== undefined && seq !== connectSeq) return;
            const binding = await createClient().pair(payload);
            if (seq !== undefined && seq !== connectSeq) return;
            await persist({ ...saved!, binding, candidate: undefined, pending: undefined });
            if (seq !== undefined && seq !== connectSeq) return;
            epoch = binding.scopeEpoch; cursor = 0;
            heldAttachments.clear();
            wipeHistoryCache();
            stopAutoRetry();
            remember(null);
            set({ status: 'connected', transport: 'lan', binding, sessionId: null, library: null, history: {}, events: [], artifacts: [], preview: null, savedPreviewName: null, runId: null, terminal: null, uploadProgress: [], lastSyncAt: null, abandonedPending: dropPending });
            await refreshRelayRoute();
          }, { preempt: true, claim: true });
        } finally {
          userPairing = false;
          // 配对没成（offline）且回不到原绑定：恢复原绑定并继续前台退避自动重试（D1）。
          // 原本就没有绑定的（首次扫码失败）不进这里——停在扫码失败态，不空转。
          // 已有更新的连接尝试（再扫一次/手动重连）时不抢它的状态。safely 失败那拍的
          // armAutoRetry 因 userPairing 直接 return 了，重挂只能补在这里。
          // 扫码阶段的失败（二维码解不开/取消）没走到清绑定那步，原绑定还在：connectionQrInvalid/
          // ScanFailed 会挡住 armAutoRetry，但「这次扫码没成」不等于「这台电脑不能重试」——同样
          // 重挂（ai-review Nit：否则有原绑定时前台自动重连被一次误扫永久停掉）。
          // 按失败尝试计档（首拍约 2s ±50%），不再 0 延迟：提示交给 safely 的静默保留机制
          // 存活到这次重试自己给出新结论，用 0 延迟换「提示多留一拍」只会把它瞬间清掉
          // （ai-review Important）。
          const scanStageFailure = Boolean(saved?.binding)
            && (get().connectionError === 'connectionQrInvalid' || get().connectionError === 'connectionScanFailed');
          if (previousBinding && attempt !== 0 && attempt === connectSeq && saved && get().status === 'offline'
            && (!saved.binding || scanStageFailure)) {
            try {
              if (!saved.binding) await persist({ ...saved, binding: previousBinding, candidate: undefined });
              armAutoRetry(true, scanStageFailure);
            } catch { /* persist 失败已把状态打成 storageError；停在失败态 */ }
          }
        }
      },
      /**
       * 丢掉本机存的配对，回到「尚未连接电脑」。留着身份密钥对——它是这台手机的身份，
       * 重新扫码时照样用；要丢的只是「配的是哪台电脑」。
       *
       * 存在的理由（爸 2026-09-16 build 42 真机）：endpoint/altEndpoint 都在配对那一刻写死，
       * 换网后两个地址一起死，reconnect 与 pair 都可能过不去；没有这条路时，用户唯一的出路是
       * 删 app 重装（靠 nativeCompanion.ts 的 INSTALL_KEY 标记去清 Keychain）。
       */
      forget: () => {
        // 与另两个逃生口同一纪律（D3）：自动尝试占着 busy 时「忘记这台电脑」也必须真能执行——
        // 只放开按钮置灰会是死键（safely 的 busy 守卫把点按静默吞掉）。抢占 + 领代号：在途尝试
        // 迟到的失败/成功按代号丢弃，不把刚清干净的未配对态打回 offline。
        const preempt = get().busy && get().autoAttempt;
        return safely(async () => {
          stopAutoRetry();
          appInBackground = false;
          remember(null);
          // 忘掉这台电脑：标题记忆一并清（此刻 saved 还没被下面的 persist 重写，hostKey 先取）。
          const forgottenHostKey = saved?.binding?.hostKey;
          if (forgottenHostKey) options?.forgetSessionTitles?.(forgottenHostKey);
          client?.close(); client = null;
          if (saved) await persist({ version: 1, publicKey: saved.publicKey, secretKey: saved.secretKey });
          wipeHistoryCache();
          // 输入区那几样也要跟着清（grok ai-review Nit①）：附件 chip / 上传进度 / 语音结果都绑在
          // 上一台电脑那条会话上，留着就会在「尚未连接电脑」页底下挂着一台已经忘掉的电脑的东西。
          heldAttachments.clear();
          set({ status: 'unpaired', binding: null, sessionId: null, transport: null,
            paused: false, connectionError: null, library: null, libraryError: false, runId: null, terminal: null,
            artifacts: [], preview: null, savedPreview: false, savedPreviewName: null, routeError: null,
            uploadProgress: [], voiceResult: null, autoRetrying: false, abandonedPending: false });
        }, preempt ? { preempt: true, claim: true } : undefined);
      },
      dismissAbandonedPending: () => set({ abandonedPending: false }),
      reconnect: async (opts) => {
        appInBackground = false;
        const manual = Boolean(opts?.resetBackoff);
        // 手动「重新连接」立即发起新尝试并抢过自动重试的在途连接（D3）：旧尝试迟到的失败/
        // 成功按代号丢弃。busy 被手动操作（扫码、上一次手动重连）占着时不抢——safely 的
        // 去重守卫照旧拦重复点按。此态下面 manual 分支已清定时器而 safely 随后放弃、不重挂；
        // 不变式靠 UI 撑着——连接页按钮在手动 busy 期间置灰，用户点不到（ai-review Nit，
        // 按原样保留）。
        const preempt = manual && get().busy && get().autoAttempt;
        if (manual) {
          retryGeneration += 1;
          clearRetryTimer();
          retryAttempt = 0;
          retryStartedAt = Date.now();
          set({ autoRetrying: true });
        }
        reconnectDepth += 1;
        try {
          return await safely(async attempt => {
        const savedTarget = saved?.binding ?? saved?.candidate;
        if (!savedTarget) return;
        // mDNS 重解析治旧 IP（fix4-⑤）：先用绑定里的主机名重新解析，解析到则用新地址拨，
        // 解析不到回退旧地址。recover 成功后 binding.endpoint 就是这次拨通的地址，
        // persist 会把它写回绑定——地址更新、身份不动（hostKey/deviceId/scope 照旧校验）。
        const target = await mdnsRefreshedEndpoint(port, savedTarget) ?? savedTarget;
        // 解析挂起期间被抢占（扫码/手动重连领了新代号）：迟到的旧尝试到此为止——再往下
        // createClient() 会关掉抢占者刚建立的活客户端，有效扫码被 COMPANION_CHANNEL_CHANGED
        // 拖死，一次性邀请已被 hello 消耗（ai-review Important）。
        if (attempt !== undefined && attempt !== connectSeq) return;
        const previousScope = get().binding?.scope ?? saved?.binding?.scope ?? [];
        // 已在自动重试 / 点了「重新连接」才保持 offline 文案。从后台恢复（pause 留下
        // status=offline + paused）必须走 connecting：否则健康连接回前台也会报「正在自动重试」。
        const silent = get().autoRetrying || Boolean(opts?.resetBackoff)
          || (get().status === 'offline' && !get().paused);
        if (silent) set({ paused: false, autoRetrying: true });
        else set({ status: 'connecting', paused: false });
        let binding: LanBinding;
        try {
          binding = await createClient().recover(target, saved?.binding);
        } catch (lanError) {
          // 被更新的尝试抢占了：这次失败交给抢占者结算，这里不再落 relay。
          if (attempt !== undefined && attempt !== connectSeq) return;
          // 双径（N-MOBILE-RELAY-PHONE）：LAN 失败/不可达且有缓存路由时落 relay。
          // recover 失败已把 LAN 客户端关掉，此刻起只有 relay 一条活通道——不双跑。
          // 没有路由就原样抛 LAN 的错误：那是用户看得懂的那句。
          // 身份变化不是网络问题：落 relay 同一身份也会被拒，且会让自动重连空转。
          const lanCode = lanError instanceof Error ? lanError.message : '';
          if (handshakeNeedsRescan(lanCode) || !saved?.relay || !saved?.binding) throw lanError;
          await dialRelay(attempt);
          // relay 握手期间也可能被抢占：这次成功不落状态。
          if (attempt !== undefined && attempt !== connectSeq) return;
          // 静默重试保留到「连上为止」的那两句（二维码无效/扫码失败）在这里清。
          set({ status: 'connected', transport: 'relay', paused: false, connectionError: null });
          await reconcilePending();
          return;
        }
        // 被更新的尝试抢占了：迟到的成功作废——不落盘、不打 connected、不动 relay 记账（D3）。
        if (attempt !== undefined && attempt !== connectSeq) return;
        // LAN 恢复即收敛到直连：createClient 的 client?.close() 已把 relay 通道关掉
        //（同一时刻只有一条活通道），这里只清记账。
        relayClient = null;
        await persist({ ...saved!, binding, candidate: undefined });
        // 落盘是又一次可被抢占的窗口：不校验的话，抢占者刚置好的状态会被这拍覆盖。
        if (attempt !== undefined && attempt !== connectSeq) return;
        epoch = binding.scopeEpoch;
        pruneUnscopedHistory(previousScope, binding.scope);
        // lastSession === '' 是欢迎页记忆；null ?? scope 第一条会把它盖掉。
        const remembered = options?.lastSession?.(binding.hostKey);
        set({
          status: 'connected', transport: 'lan', binding, connectionError: null,
          sessionId: get().sessionId ?? (remembered === '' ? null : (binding.scope.find(id => !id.startsWith('project:')) ?? null)),
        });
        await refreshRelayRoute();
        // 路由刷新期间被抢占：收尾不再触碰抢占者的通道（reconcilePending 会在当前 client 上发请求）。
        if (attempt !== undefined && attempt !== connectSeq) return;
        await reconcilePending();
          }, { preempt, claim: true, autoAttempt: !manual });
        } finally {
          reconnectDepth -= 1;
        }
      },
      pause: () => {
        // 后台/锁屏不跑自动重连定时器（N-MOBILE-AUTO-RECONNECT ②），与「paused 假警报」是两件事：
        // 已经 offline 时 paused 仍是 false（断连文案要留着），但定时器必须停。
        appInBackground = true;
        retryGeneration += 1;
        clearRetryTimer();
        // 只有「本来连着」才算暂停：原本就断着的话，报错该继续留在界面上。
        // 必须幂等：iOS 退后台会连发两次生命周期回调，第二次时 status 已经是 offline，
        // 按「当前是否连着」重算就会把 paused 打回 false——爸报的那个假警报原样回来
        // （grok ai-review Nit）。暂停标记只由 pair / reconnect 清。
        const live = get().status === 'connected' || get().paused;
        // client 即当前活通道（LAN 或 relay），关它就够；relayClient 只是记账。
        client?.close();
        relayClient = null;
        if (get().binding) set({ status: 'offline', paused: live, transport: null, autoRetrying: false });
      },
      refreshLibrary: async (more = false) => {
        if (!client || get().status !== 'connected') return;
        try {
          const library = await client.request({ action: 'read', query: { kind: 'library', offset: more ? get().library?.nextOffset ?? 0 : 0 } }) as CompanionLibrary;
          if (!library || !Array.isArray(library.sessions) || !Array.isArray(library.projects) || !Array.isArray(library.models)) throw new Error('COMPANION_INVALID_LIBRARY');
          const previous = get().library;
          const current = get().sessionId;
          const sessions = new Map((more ? previous?.sessions ?? [] : []).map(s => [s.id, s]));
          for (const session of library.sessions) sessions.set(session.id, session);
          set({ library: { ...library, sessions: [...sessions.values()] }, libraryError: false });
          // 连上后发现当前会话已在电脑删除：静默回欢迎页（N-MOBILE-RESUME-LAST-SESSION ④）。
          if (current && !more && !sessions.has(current) && library.nextOffset == null) {
            const previousHad = previous?.sessions.some(s => s.id === current) === true;
            const coldMiss = !previous;
            if (previousHad || coldMiss) {
              remember(null);
              set({ sessionId: null, runId: null, terminal: null, artifacts: [], preview: null, savedPreview: false, savedPreviewName: null, uploadProgress: [] });
            }
          }
        } catch { set({ libraryError: true }); }
      },
      refreshModels: async () => {
        if (!client || get().status !== 'connected') return;
        try {
          const fresh = await client.request({ action: 'read', query: { kind: 'library', offset: 0 } }) as CompanionLibrary;
          const current = get().library;
          // 只换 models：已「加载更多」进来的较旧会话不能被第一页冲掉，否则当前会话从库里消失、胶囊跟着没了（grok ai-review PR#1906 Important）。
          if (fresh && Array.isArray(fresh.models) && current) set({ library: { ...current, models: fresh.models } });
        } catch { /* 刷不到就用手里那份，模型屏照常能用 */ }
      },
      loadHistory: async (id, more = false) => {
        if (!client || get().status !== 'connected') return;
        try {
          const old = get().history[id];
          if (more && old?.nextOffset === null) return;
          const page = await client.request({ action: 'read', query: { kind: 'history', sessionId: id, offset: more ? old?.nextOffset ?? 0 : 0 } }) as CompanionHistory;
          if (page.sessionId !== id || !Array.isArray(page.messages)) throw new Error('COMPANION_INVALID_HISTORY');
          const messages = more ? [...page.messages, ...(old?.messages ?? [])] : page.messages;
          set({ history: { ...get().history, [id]: { ...page, messages } }, libraryError: false });
          history.putMessages(id, messages);
        } catch { set({ libraryError: true }); }
      },
      manage: (action, payload, target) => {
        // 守卫不满足时不再静默 return（fix6-②，2026-09-15 build 37「点了没反应」）：哪一档
        // 不满足就报哪一档，否则 UI 无从知道这条命令根本没发出去。判在 safely **之前**：
        // safely 进场会清 connectionError，之后再报「没连上」就连三分类诊断句一起丢掉
        //（连接胶囊的诊断也一并保住，不被这次注定失败的点按抹平）。
        // binding 在守卫里捕获：safely 的闭包不继承 saved 的窄化，而 saved 只会被重赋为非空记录。
        const binding = saved?.binding;
        if (!binding || !client || saved?.pending || get().status !== 'connected') {
          set({ commandError: get().status !== 'connected' ? 'COMPANION_NOT_CONNECTED' : 'COMPANION_COMMAND_IN_FLIGHT', commandErrorAction: action });
          return Promise.resolve();
        }
        return safely(async () => {
          const command = companionCommandSchema.parse({ version: 1, deviceId: binding.deviceId, scopeEpoch: binding.scopeEpoch,
            commandId: crypto.randomUUID(), sessionId: target ?? get().sessionId, action, payload });
          await persist({ ...saved!, pending: command }); set({ pending: true });
          try { await deliver(); }
          catch (error) {
            // 发送途中断连/超时也要点名「是这件事没成」；连接态仍交给 safely 收口（offline +
            // 三分类 connectionError），重抛不吞——pending 已持久化，重连后会照常结算。
            set({ commandError: 'COMPANION_NOT_CONNECTED', commandErrorAction: action });
            throw error;
          }
        });
      },
      selectSession: sessionId => {
        const known = get().library?.sessions.some(s => s.id === sessionId)
          || get().binding?.scope.includes(sessionId)
          || get().events.some(e => e.sessionId === sessionId && (e.kind === 'approval' || e.kind === 'question' || e.kind === 'plan'))
          || Boolean(get().history[sessionId]);
        if (known && !get().busy) {
          const events = get().events.filter(e => e.sessionId === sessionId);
          const last = events.filter(e => ['run_started', 'agent_complete', 'agent_cancelled', 'error'].includes(e.kind)).at(-1);
          // artifacts/preview 是当前会话作用域：切会话必须清掉，否则 offline 时
          // refreshArtifacts 提前 return，B 会话会一直显示 A 会话的成果卡（点开必 ARTIFACT_MISSING）。
          heldAttachments.clear();
          set({ sessionId, runId: last?.kind === 'run_started' ? String(last.payload.runId) : null, terminal: null, artifacts: [], preview: null, savedPreview: false, savedPreviewName: null, uploadProgress: [] });
        }
      },
      transcribe: async (audio, sessionId, hostKey, continuation = false, take = null) => {
        // 「发出去了没有」的判据是**进没进待确认槽**，不是 deliver 有没有成功：
        // 一旦 persist 成 saved.pending，这条命令重连后一定会被结算、结果会进草稿。
        // 此时若因为 deliver 抛错回 null，调用方（分片队列）会把同一段音频再发一遍，
        // 草稿里出现重复的字（grok ai-review Important）。
        let commandId: string | null = null;
        await safely(async () => {
          if (get().sessionId !== sessionId || get().binding?.hostKey !== hostKey) return;
          if (!saved?.binding || !client || saved.pending || !canAddressSession(get())) return;
          const command = companionCommandSchema.parse({ version: 1, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch,
            commandId: crypto.randomUUID(), sessionId: get().sessionId, action: 'voice.transcribe', payload: audio });
          // 这一条是不是「同一次录音的后续分片」只活在内存里：进程被杀后重放那条 pending 命令
          // 最多让草稿多一个换行，不会丢字，所以不进持久化结构。
          transcriptContinuation = continuation;
          // 代号要记在**任何 await 之前**：取消可能落在 persist 中间，那时还没有 commandId 可认。
          // 槽此刻是空的 ⇒ 先前被取消的那几次录音都已经结算完，它们的代号可以丢了。
          discardedTakes.clear();
          voiceTake = take;
          await persist({ ...saved, pending: command }); set({ pending: true });
          commandId = command.commandId;
          await deliver();
        });
        return commandId;
      },
      /** 取消录音：在飞那条的结果属于「晚到结果」，按 screen-contract 的语音契约过滤掉，不进草稿。 */
      discardPendingTranscript: take => { discardedTakes.add(take); },
      dictationOpen: async () => {
        // relay 面不提供实时听写（Host 只在 LAN exchange 上挂 dictation 口）；回落到分段转写。
        if (!client || get().status !== 'connected' || get().transport === 'relay' || get().binding?.dictation !== true) {
          return { ok: false, code: 'COMPANION_DICTATION_UNAVAILABLE' };
        }
        return await client.request({ action: 'dictation', op: 'open' }) as CompanionDictationOpenResult;
      },
      dictationAudio: async (streamId, pcm) => {
        if (!client || get().status !== 'connected' || get().transport === 'relay') {
          return { ok: false, code: 'COMPANION_DICTATION_UNAVAILABLE', events: [] };
        }
        return await client.request({ action: 'dictation', op: 'audio', streamId, pcm }) as CompanionDictationFrameResult;
      },
      dictationStop: async streamId => {
        if (!client || get().status !== 'connected' || get().transport === 'relay') {
          return { ok: false, code: 'COMPANION_DICTATION_UNAVAILABLE', events: [] };
        }
        return await client.request({ action: 'dictation', op: 'stop', streamId }) as CompanionDictationFrameResult;
      },
      dictationClose: async () => {
        if (!client || get().status !== 'connected' || get().transport === 'relay') return;
        await client.request({ action: 'dictation', op: 'close' });
      },
      commitDictation: async (text, continuation, take, sentenceId) => {
        const sessionId = get().sessionId;
        if (!onTranscript || !saved?.binding || !sessionId) return;
        if (discardedTakes.has(take)) return;
        await onTranscript(text, sessionId, saved.binding.hostKey, `dictation:${take}:${sentenceId}`, continuation);
      },
      send: text => safely(async () => {
        if (!saved?.binding || !client || saved.pending || !canAddressSession(get())) return;
        const command = companionCommandSchema.parse({ version: 1, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch,
          commandId: crypto.randomUUID(), sessionId: get().sessionId, action: 'message.send', payload: { text } });
        await persist({ ...saved, pending: command }); set({ pending: true }); await deliver();
      }),
      stop: () => safely(async () => {
        if (!saved?.binding || saved.pending || !get().runId || !get().sessionId || get().status !== 'connected') return;
        const command = companionCommandSchema.parse({ version: 1, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch,
          commandId: crypto.randomUUID(), sessionId: get().sessionId, action: 'run.cancel', payload: { runId: get().runId } });
        await persist({ ...saved, pending: command }); set({ pending: true }); await deliver();
      }),
      registerPush: async input => {
        // 推送注册只在 LAN 面上提供；relay 下按「主机不支持」结算，回到 LAN 会自动补注册。
        if (!client || get().status !== 'connected' || get().transport === 'relay') return { kind: 'rejected', reason: 'unsupported_action' };
        return await client.request({ action: 'push.register', provider: input.provider, token: input.token, environment: input.environment }) as CompanionPushRegisterResult;
      },
      unregisterPush: async () => {
        if (!client || get().status !== 'connected' || get().transport === 'relay') return;
        await client.request({ action: 'push.unregister' });
      },
      openRoute: async routeToken => {
        if (!client || get().status !== 'connected') { set({ routeError: 'auth_required' }); return; }
        // relay 面没有 push.open：事件流照常同步（tap 后的 sync 会拉到新事件），只是不自动跳会话。
        if (get().transport === 'relay') { set({ routeError: 'unsupported_action' }); return; }
        const result = await client.request({ action: 'push.open', routeToken }) as CompanionPushOpenResult;
        if (result.kind === 'rejected') { set({ routeError: result.reason }); return; }
        set({ routeError: null });
        get().selectSession(result.sessionId);
        await get().sync();
      },
      resolveRoute: async routeToken => {
        // push.open 在 Host 侧是纯查询（按 routeToken 查 outbox 行的 session_id），这里只取会话、不选中不同步。
        if (!client || get().status !== 'connected' || get().transport === 'relay') return null;
        const result = await client.request({ action: 'push.open', routeToken }) as CompanionPushOpenResult;
        return result.kind === 'rejected' ? null : result.sessionId;
      },
      respond: (requestId, decision) => safely(async () => {
        if (!saved?.binding || saved.pending || !canAddressSession(get())) return;
        const latest = get().events.filter(event => event.kind === 'approval' && event.sessionId === get().sessionId && event.payload.requestId === requestId).at(-1)?.payload;
        if (!latest || latest.status !== 'pending') return;
        const command = companionCommandSchema.parse({ version: 1, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch,
          commandId: crypto.randomUUID(), sessionId: get().sessionId, action: 'approval.respond', expectedRevision: latest.revision,
          payload: { requestId, decision, operationDigest: latest.operationDigest } });
        await persist({ ...saved, pending: command }); set({ pending: true }); await deliver();
      }),
      respondQuestion: (requestId, answers, declined, reason) => safely(async () => {
        if (!saved?.binding || saved.pending || !canAddressSession(get())) return;
        const latest = get().events.filter(event => event.kind === 'question' && event.sessionId === get().sessionId && event.payload.requestId === requestId).at(-1)?.payload;
        if (!latest || latest.status !== 'pending') return;
        const command = companionCommandSchema.parse({ version: 1, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch,
          commandId: crypto.randomUUID(), sessionId: get().sessionId, action: 'question.respond', expectedRevision: latest.revision,
          payload: declined
            ? { requestId, operationDigest: latest.operationDigest, declined: true, ...(reason ? { reason } : {}) }
            : { requestId, operationDigest: latest.operationDigest, answers } });
        await persist({ ...saved, pending: command }); set({ pending: true }); await deliver();
      }),
      respondPlan: (requestId, decision, feedback) => safely(async () => {
        if (!saved?.binding || saved.pending || !canAddressSession(get())) return;
        const latest = get().events.filter(event => event.kind === 'plan' && event.sessionId === get().sessionId && event.payload.requestId === requestId).at(-1)?.payload;
        if (!latest || latest.status !== 'pending') return;
        const command = companionCommandSchema.parse({ version: 1, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch,
          commandId: crypto.randomUUID(), sessionId: get().sessionId, action: 'plan.respond', expectedRevision: latest.revision,
          payload: { requestId, decision, operationDigest: latest.operationDigest, ...(feedback ? { feedback } : {}) } });
        await persist({ ...saved, pending: command }); set({ pending: true }); await deliver();
      }),
      sync: async () => {
        if (syncing || get().busy || get().status !== 'connected' || !client) return;
        syncing = true;
        try {
          const result = await client.request({ action: 'sync', epoch, afterSeq: cursor }) as CompanionSyncResult;
          if (result.kind === 'snapshot_required') { epoch = result.epoch; cursor = 0; set({ events: [] }); markSyncOk(); return; }
          // 被撤销不是网络问题：混进通用 offline 会让这台设备一直重试、永远不知道自己已被踢。
          if (result.kind === 'revoked') {
            client?.close(); if (relayClient) { relayClient.close(); relayClient = null; } wipeHistoryCache(); stopAutoRetry(); remember(null);
            const revokedHostKey = saved?.binding?.hostKey;
            if (revokedHostKey) options?.forgetSessionTitles?.(revokedHostKey);
            set({ status: 'rejected', connectionError: 'connectionRejected', transport: null, sessionId: null });
            return;
          }
          if (result.kind !== 'events' || result.epoch !== epoch || !Number.isSafeInteger(result.nextSeq) || result.nextSeq < cursor || !Array.isArray(result.events)) throw new Error('COMPANION_INVALID_SYNC');
          set({ events: [...get().events, ...result.events] }); cursor = result.nextSeq;
          history.ingestEvents(result.events);
          set({ lastSyncAt: history.snapshot().lastSyncAt, cacheUsage: inspectBoth() });
          for (const event of result.events) if (event.sessionId === get().sessionId && (event.kind === 'run_started' || (event.kind === 'message' && event.payload.role === 'user') || !get().runId || event.payload.runId === get().runId)) {
            if ((event.kind === 'run_started' || (event.kind === 'message' && event.payload.role === 'user')) && typeof event.payload.runId === 'string') set({ runId: event.payload.runId, terminal: null });
            if (event.kind === 'agent_complete') set({ runId: null, terminal: 'complete' });
            if (event.kind === 'agent_cancelled') set({ runId: null, terminal: 'stopped' });
            if (event.kind === 'error') {
              // 执行失败不进底部提示条（N-MOBILE-EXEC-STATUS ②）：原因随 error 事件挂在那次执行下面。
              // 进 commandError 的话它一直不清，下一次任务成功后「完成」「没有完成」两句同屏并列。
              set({ runId: null, terminal: 'failed' });
            }
            if (event.kind === 'artifact' && typeof event.payload.artifactId === 'string' && typeof event.payload.name === 'string') {
              const artifact: CompanionArtifact = {
                artifactId: event.payload.artifactId, version: Number(event.payload.version ?? 1),
                name: event.payload.name, mimeType: String(event.payload.mimeType ?? ''),
                size: Number(event.payload.size ?? 0), sha256: String(event.payload.sha256 ?? ''),
                origin: event.payload.origin === 'result' ? 'result' : 'upload',
              };
              set({ artifacts: [...get().artifacts.filter(item => item.artifactId !== artifact.artifactId), artifact] });
            }
          }
          if (saved?.pending) {
            const pendingId = saved.pending.commandId;
            const record = await client.request({ action: 'status', commandId: pendingId }) as CompanionCommandRecord | null;
            if (record && saved?.pending?.commandId === pendingId && !(await recoverStalePending(record))) await accepted(record);
          }
          markSyncOk();
        } catch {
          client?.close();
          if (relayClient && client === relayClient) relayClient = null;
          // 撤销已在同一次处理里把设备翻成 rejected（relay 的 revoke 帧先 drop 再 onRevoked，
          // 这条 sync 的失败随后才到）：不得打回 offline、不得挂自动重试——否则状态位先闪
          // 「正在自动重试」再变回「需要重新扫码」（N-MOBILE-AUTO-RECONNECT-R3 O2）。
          if (get().status === 'rejected') { syncOk = false; return; }
          const escalate = !syncOk;
          syncOk = false;
          if (get().status !== 'storageError') set({ status: 'offline', connectionError: 'connectionUnavailable', transport: null });
          armAutoRetry(escalate);
        }
        finally { syncing = false; }
      },
      refreshArtifacts: async () => {
        if (!client || get().status !== 'connected' || !get().sessionId) return;
        try {
          const page = await client.request({ action: 'read', query: { kind: 'artifacts', sessionId: get().sessionId } }) as CompanionArtifacts;
          if (page.sessionId !== get().sessionId || !Array.isArray(page.artifacts)) throw new Error('COMPANION_INVALID_LIBRARY');
          set({ artifacts: page.artifacts });
        } catch { set({ libraryError: true }); }
      },
      upload: (file, existingId) => safely(async () => {
        const id = existingId ?? crypto.randomUUID();
        const totalBytes = file.bytes.byteLength;
        const visibleSince = Date.now();
        if (!existingId) {
          heldAttachments.set(id, file);
          set({ uploadProgress: [...get().uploadProgress, { id, name: file.name, totalBytes, sentBytes: 0, phase: 'preparing' }] });
        } else {
          patchUpload(id, { phase: 'preparing', sentBytes: 0, error: undefined });
        }
        const fail = (code: string) => {
          patchUpload(id, { phase: 'failed', error: code, retryable: companionFileRetryable(code) });
        };
        if (!saved?.binding || !client || saved.pending || !canAddressSession(get())) {
          fail('COMPANION_TRANSFER_INTERRUPTED'); return;
        }
        if (file.size > COMPANION_LIMITS.fileMaxBytes || file.bytes.byteLength > COMPANION_LIMITS.fileMaxBytes) {
          fail('UPLOAD_TOO_LARGE'); return;
        }
        // 扩展名权威：picker 已按扩展名归一化（归不了的是空串），这里不再信任何声明值。
        const mime = companionFileMime(file.name, '');
        if (!mime) { fail('COMPANION_FILE_TYPE_DENIED'); return; }
        const base = { version: 1 as const, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch, sessionId: get().sessionId! };
        const enqueue = async (command: CompanionCommand) => {
          await persist({ ...saved!, pending: command }); set({ pending: true });
          const record = await deliver();
          if (!record || record.state === 'rejected' || record.state === 'conflict') {
            throw new Error(typeof record?.result.code === 'string' ? record.result.code : 'COMPANION_COMMAND_REJECTED');
          }
          return record;
        };
        let transferId = '';
        try {
          const sha256 = await sha256Hex(file.bytes);
          const prepared = await enqueue(companionCommandSchema.parse({ ...base, commandId: crypto.randomUUID(), action: 'files.prepare', payload: { name: file.name, mimeType: mime, size: file.bytes.byteLength, sha256 } }));
          transferId = typeof prepared.result.transferId === 'string' ? prepared.result.transferId : '';
          if (!transferId) throw new Error('COMPANION_INVALID_ACK');
          patchUpload(id, { phase: 'transferring', sentBytes: 0 });
          for (let offset = 0; offset < file.bytes.byteLength; offset += COMPANION_LIMITS.fileChunkBytes) {
            const slice = file.bytes.subarray(offset, offset + COMPANION_LIMITS.fileChunkBytes);
            const data = bytesToBase64(slice);
            await enqueue(companionCommandSchema.parse({ ...base, commandId: crypto.randomUUID(), action: 'files.chunk',
              payload: { transferId, offset, data, sha256: await sha256Hex(slice) } }));
            patchUpload(id, { phase: 'transferring', sentBytes: Math.min(offset + slice.byteLength, totalBytes) });
          }
          const committed = await enqueue(companionCommandSchema.parse({ ...base, commandId: crypto.randomUUID(), action: 'files.commit', payload: { transferId, sha256 } }));
          if (typeof committed.result.artifactId === 'string') {
            const artifact: CompanionArtifact = {
              artifactId: committed.result.artifactId, version: Number(committed.result.version ?? 1),
              name: String(committed.result.name ?? file.name), mimeType: String(committed.result.mimeType ?? mime),
              size: Number(committed.result.size ?? file.bytes.byteLength), sha256: String(committed.result.sha256 ?? sha256),
              origin: 'upload',
            };
            set({ artifacts: [...get().artifacts.filter(item => item.artifactId !== artifact.artifactId), artifact] });
          }
          heldAttachments.delete(id);
          const hold = COMPANION_LIMITS.attachChipMinVisibleMs - (Date.now() - visibleSince);
          if (hold > 0) await new Promise(resolve => setTimeout(resolve, hold));
          patchUpload(id, { phase: 'complete', sentBytes: totalBytes, error: undefined, retryable: false });
        } catch (error) {
          if (transferId && saved?.binding && client) {
            try {
              await enqueue(companionCommandSchema.parse({ ...base, commandId: crypto.randomUUID(), action: 'files.abort', payload: { transferId } }));
            } catch { /* host expireStale/recover deletes staging if this abort cannot be delivered */ }
          }
          await releasePending();
          const code = error instanceof Error ? error.message : 'COMPANION_TRANSFER_INTERRUPTED';
          fail(companionFileRetryable(code) || code === 'UPLOAD_TOO_LARGE' || code === 'COMPANION_FILE_TYPE_DENIED' ? code : 'COMPANION_TRANSFER_INTERRUPTED');
        }
      }),
      retryUpload: id => {
        const current = get().uploadProgress.find(item => item.id === id);
        const file = heldAttachments.get(id);
        if (!current || current.phase !== 'failed' || !current.error || !companionFileRetryable(current.error) || !file) return Promise.resolve();
        return get().upload(file, id);
      },
      removeUpload: id => {
        heldAttachments.delete(id);
        set({ uploadProgress: get().uploadProgress.filter(item => item.id !== id) });
      },
      previewArtifact: artifactId => safely(async () => {
        if (!saved?.binding || !client || saved.pending || !canAddressSession(get()) || !files) return;
        const listed = get().artifacts.find(item => item.artifactId === artifactId);
        if (!listed) { set({ commandError: 'ARTIFACT_MISSING' }); return; }
        const cached = files.cache.get(artifactId);
        if (cached && cached.size === listed.size) {
          set({ preview: { ...listed, bytes: cached.bytes }, savedPreview: false, savedPreviewName: null });
          return;
        }
        const base = { version: 1 as const, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch, sessionId: get().sessionId! };
        const parts: Uint8Array[] = [];
        try {
          for (let offset = 0; offset < listed.size; offset += COMPANION_LIMITS.fileChunkBytes) {
            const command = companionCommandSchema.parse({
              ...base, commandId: crypto.randomUUID(), action: 'files.read',
              payload: { artifactId, version: listed.version, offset, length: Math.min(COMPANION_LIMITS.fileChunkBytes, listed.size - offset) },
            });
            await persist({ ...saved!, pending: command }); set({ pending: true });
            const record = await deliver();
            if (!record || record.state === 'rejected' || record.state === 'conflict' || typeof record.result.data !== 'string') {
              throw new Error(typeof record?.result.code === 'string' ? record.result.code : 'ARTIFACT_MISSING');
            }
            parts.push(base64ToBytes(record.result.data));
          }
          const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
          const bytes = new Uint8Array(total);
          let cursor = 0;
          for (const part of parts) { bytes.set(part, cursor); cursor += part.byteLength; }
          if (await sha256Hex(bytes) !== listed.sha256) throw new Error('COMPANION_INVALID_HASH');
          // 缓存满不等于成果丢失：文件已完整回传且 SHA-256 校验通过，预览与显式保存必须照常，
          // 只提示缓存不可用（STORAGE_FULL 走既有 commandError → storageFull 文案链）。
          let cacheFailed = false;
          try {
            files.cache.put(artifactId, { name: listed.name, mimeType: listed.mimeType, bytes });
          } catch {
            cacheFailed = true;
          }
          set({ preview: { ...listed, bytes }, savedPreview: false, savedPreviewName: null, cacheUsage: inspectBoth(), commandError: cacheFailed ? 'STORAGE_FULL' : null });
        } catch (error) {
          await releasePending();
          const code = error instanceof Error ? error.message : 'ARTIFACT_MISSING';
          set({ commandError: code, preview: null });
        }
      }),
      closePreview: () => set({ preview: null, savedPreview: false, savedPreviewName: null }),
      savePreview: async () => {
        const preview = get().preview;
        if (!preview || !files) return;
        const result = await files.save({ name: preview.name, mimeType: preview.mimeType, bytes: preview.bytes });
        if (result.status === 'saved') set({ savedPreview: true, savedPreviewName: result.name ?? preview.name, commandError: null });
        else if (result.status === 'cancelled') set({ savedPreview: false });
        else set({ commandError: result.code ?? 'COMPANION_EXPORT_FAILED', savedPreview: false });
      },
      clearCache: () => {
        const usage = files?.cache.clear() ?? { freedBytes: 0, remainingBytes: 0, failedEntries: [] };
        const conversation = wipeHistoryCache();
        set({ cacheUsage: inspectBoth(), preview: null, savedPreview: false });
        // previewBytes / conversationBytes 报告本次释放的字节（不是清理后的剩余——那个恒为 0）。
        return { previewBytes: usage.freedBytes, conversationBytes: conversation.freedBytes, protectedBytes: 0 };
      },
    };
  });
  return store;
}
