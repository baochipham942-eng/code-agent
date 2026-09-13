import type { CompanionArtifact, CompanionArtifacts, CompanionLibrary, CompanionHistory } from '../../../../src/shared/contract/companionLibrary';
import { createStore } from 'zustand/vanilla';
import { createIdentity } from '../../../../src/shared/companion/noiseChannel';
import { fromHex, toHex, parseInvitation, type LanBinding } from '../../../../src/shared/companion/lanProtocol';
import type { CompanionCommand, CompanionCommandRecord, CompanionEvent, CompanionSyncResult } from '../../../../src/shared/contract/companion';
import type { CompanionPushRegister, CompanionPushRegisterResult, CompanionPushOpenResult } from '../../../../src/shared/contract/companionPush';
import { companionCommandSchema } from '../../../../src/shared/contract/companion';
import { LanCompanionClient } from '../platform/lanCompanionClient';
import type { FilePorts, PlatformPorts, PickedFile } from '../platform/ports';
import { companionFileMime, companionFileRetryable, COMPANION_LIMITS } from '../../../../src/shared/constants/companion';
import { isSpeechSilentCode } from '../../../../src/shared/contract/speech';
import { base64ToBytes, bytesToBase64, sha256Hex, type CacheInspect } from '../platform/fileCache';

interface Saved {
  version: 1; publicKey: string; secretKey: string;
  candidate?: { endpoint: string; altEndpoint?: string; hostKey: string }; binding?: LanBinding; pending?: CompanionCommand;
}
type ConnectionError = 'connectionQrInvalid' | 'connectionScanFailed' | 'connectionRejected' | 'connectionUnavailable' | 'connectionFailed';

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

interface State {
  voiceResult: VoiceResult | null;
  /** 返回这条命令的 commandId（已进待确认槽）；没发出去回 null，分片队列据此重排队，不静默丢片。 */
  transcribe(audio: { audioData: string; mimeType: string; durationMs: number }, sessionId: string, hostKey: string, continuation?: boolean, take?: string | null): Promise<string | null>;
  /** 取消这次录音：晚到的结果不进草稿。按录音代号点名。 */
  discardPendingTranscript(take: string): void;
  library: CompanionLibrary | null; history: Record<string, CompanionHistory>; libraryError: boolean;
  refreshLibrary(more?: boolean): Promise<void>; loadHistory(id: string, more?: boolean): Promise<void>;
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
  events: CompanionEvent[]; runId: string | null; terminal: 'complete' | 'stopped' | 'failed' | null;
  hydrate(): Promise<void>; pair(): Promise<void>; reconnect(): Promise<void>; pause(): void;
  respond(requestId: string, decision: 'approved' | 'rejected'): Promise<void>;
  routeError: string | null;
  registerPush(input: CompanionPushRegister): Promise<CompanionPushRegisterResult>;
  unregisterPush(): Promise<void>;
  openRoute(routeToken: string): Promise<void>;
  selectSession(id: string): void; send(text: string): Promise<void>; stop(): Promise<void>; sync(): Promise<void>;
  artifacts: CompanionArtifact[]; preview: (CompanionArtifact & { bytes: Uint8Array }) | null; savedPreview: boolean; savedPreviewName: string | null;
  cacheUsage: CacheInspect | null;
  upload(file: PickedFile): Promise<void>;
  previewArtifact(artifactId: string): Promise<void>;
  closePreview(): void;
  savePreview(): Promise<void>;
  refreshArtifacts(): Promise<void>;
  clearCache(): CacheInspect;
}

/**
 * 「这条命令此刻有没有一个可寻址的会话」——send / transcribe / respond 三处共用的判据。
 * 任何一项不满足时它们都是**静默 return**，所以界面不能只看 status==='connected'：
 * 只勾了项目的二维码配对后 sessionId 为 null，手机写着「已连接」，点发送却什么都不发生
 * （无报错、无 pending、草稿不清），用户只能反复点。
 */
export function canAddressSession(state: Pick<State, 'status' | 'sessionId'>): boolean {
  return state.status === 'connected' && Boolean(state.sessionId);
}

/** Receipt identity: a status/result from a different command must not settle this one. */
export function companionAckMatches(
  pending: Pick<CompanionCommand, 'commandId' | 'deviceId' | 'sessionId' | 'action'>,
  record: Pick<CompanionCommandRecord, 'commandId' | 'deviceId' | 'sessionId' | 'action'>,
): boolean {
  return record.commandId === pending.commandId && record.deviceId === pending.deviceId
    && record.sessionId === pending.sessionId && record.action === pending.action;
}

export function createCompanionStore(port: PlatformPorts['companion'], onAccepted: (text: string, sessionId: string, hostKey: string) => void | Promise<void>, onTranscript?: (text: string, sessionId: string, hostKey: string, commandId: string, continuation: boolean) => Promise<void>, files?: FilePorts) {
  let saved: Saved | null = null;
  let client: LanCompanionClient | null = null;
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

  const store = createStore<State>((set, get) => {
    const persist = async (next: Saved) => {
      if (!port) throw new Error('COMPANION_NATIVE_REQUIRED');
      // 待确认槽被清掉、而这条语音还没有任何结论 ⇒ 给它一个终局。
      // 清槽的路不止「结算」一条：被拒（scope_denied / scope_epoch_mismatch…）、抢答冲突、
      // reconciling 超时回收，都在别处清槽而不写结果；分片队列等的就是这条命令的结果，
      // 等不到就一直 awaiting，语音面板永不收口（grok ai-review Important）。
      // 结算那条路在调用本函数之前已经给**这个 commandId**写好结果了，不会被这里覆盖。
      const orphanVoice = saved?.pending?.action === 'voice.transcribe' && !next.pending
        && get().voiceResult?.commandId !== saved.pending.commandId ? saved.pending.commandId : null;
      try {
        await port.write(JSON.stringify(next)); saved = next;
        // 落盘记录是待确认命令的唯一真源，派生放在这一处，省得九个 set({pending}) 各自同步。
        // 两个字段必须同一拍置起：只改 pendingAction 的话，结算那一帧会是
        // pending=true + pendingAction=null，状态行闪回「请勿重复发送」——正是本单要消掉的那句。
        set({ pending: Boolean(next.pending), pendingAction: next.pending?.action ?? null,
          ...(orphanVoice ? { voiceResult: { commandId: orphanVoice, outcome: 'error' as const } } : {}) });
      }
      catch (error) { client?.close(); set({ status: 'storageError' }); throw error; }
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
    const createClient = () => {
      if (!saved || !port) throw new Error('COMPANION_NATIVE_REQUIRED');
      client?.close();
      client = new LanCompanionClient({ publicKey: fromHex(saved.publicKey, 32), secretKey: fromHex(saved.secretKey, 32) }, port.post);
      return client;
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
          silentVoice = isSpeechSilentCode(code);
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
      if (pending.action === 'session.delete' && get().sessionId === pending.sessionId) set({ sessionId: null, runId: null, terminal: null });
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
        await persist({ ...saved, pending: undefined });
        // 按语义分，不按「它是不是 rejected」分。桌面或另一台手机先批了同一条审批时，
        // 网关回的是 approval_conflict——那是正常抢答，把整台设备停掉是错的。
        set(typeof result.reason === 'string' && DEVICE_LEVEL_REASONS.has(result.reason)
          // 设备级的拒绝照报：那是「这台设备不能用了」，与用户撤没撤这次录音无关。
          ? { pending: false, status: 'rejected', connectionError: 'connectionRejected' }
          : discardedVoice ? { pending: false }
          : { pending: false, commandError: result.kind === 'approval_conflict' ? 'COMPANION_APPROVAL_CONFLICT' : result.reason ?? 'COMPANION_COMMAND_REJECTED', commandErrorAction: saved.pending?.action ?? null });
        if (voice) set({ voiceResult: { commandId: voice, outcome: 'error', code: get().commandError ?? undefined } });
        return result.command ?? null;
      }
      throw new Error('COMPANION_INVALID_ACK');
    };
    const releasePending = async () => {
      if (saved?.pending) await persist({ ...saved, pending: undefined });
      set({ pending: false });
    };
    const safely = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      if (get().busy) return undefined;
      set({ busy: true, connectionError: null, commandError: null, commandErrorAction: null });
      try { return await work(); } catch (error) {
        client?.close();
        const code = error instanceof Error ? error.message : '';
        const connectionError: ConnectionError = code === 'COMPANION_INVALID_INVITATION' ? 'connectionQrInvalid'
          : code === 'COMPANION_SCAN_FAILED' ? 'connectionScanFailed'
          : code === 'COMPANION_PAIRING_REJECTED' ? 'connectionRejected'
          : code === 'COMPANION_NETWORK_UNAVAILABLE' ? 'connectionUnavailable' : 'connectionFailed';
        if (get().status !== 'storageError') set({ status: 'offline', connectionError });
      }
      finally { set({ busy: false }); }
    };
    return {
      voiceResult: null, library: null, history: {}, libraryError: false,
      connectionError: null, commandError: null, commandErrorAction: null, routeError: null, status: 'unpaired', paused: false, binding: null, sessionId: null, busy: false, pending: false, pendingAction: null, events: [], runId: null, terminal: null,
      artifacts: [], preview: null, savedPreview: false, savedPreviewName: null, cacheUsage: files?.cache.inspect() ?? null,
      hydrate: async () => {
        if (!port || get().busy) return;
        set({ busy: true });
        try {
          const raw = await port.read(); if (!raw) { set({ busy: false }); return; }
          const value = JSON.parse(raw) as Saved;
          if (value.version !== 1) throw new Error('COMPANION_INVALID_STORAGE');
          fromHex(value.publicKey, 32); fromHex(value.secretKey, 32);
          if (value.pending) companionCommandSchema.parse(value.pending);
          saved = value;
          set({ busy: false, binding: value.binding ?? null, sessionId: value.binding?.scope.find(id => !id.startsWith('project:')) ?? null, pending: !!value.pending, pendingAction: value.pending?.action ?? null });
          if (value.candidate || value.binding) await get().reconnect();
        } catch { set({ busy: false, status: 'storageError' }); }
      },
      pair: () => safely(async () => {
        set({ paused: false });
        if (!port || saved?.pending) return;
        const raw = await port.scan().catch(() => { throw new Error('COMPANION_SCAN_FAILED'); });
        let invitation;
        try { invitation = parseInvitation(raw); } catch { throw new Error('COMPANION_INVALID_INVITATION'); }
        set({ status: 'connecting' });
        if (!saved) {
          const identity = createIdentity();
          await persist({ version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey) });
          identity.secretKey.fill(0);
        }
        await persist({ ...saved!, candidate: { endpoint: invitation.endpoint, ...(invitation.altEndpoint ? { altEndpoint: invitation.altEndpoint } : {}), hostKey: invitation.hostKey }, binding: undefined });
        const binding = await createClient().pair(raw);
        await persist({ ...saved!, binding, candidate: undefined });
        epoch = binding.scopeEpoch; cursor = 0;
        set({ status: 'connected', binding, sessionId: binding.scope.find(id => !id.startsWith('project:')) ?? null, library: null, history: {}, events: [], artifacts: [], preview: null, savedPreviewName: null, runId: null, terminal: null });
      }),
      reconnect: () => safely(async () => {
        const target = saved?.binding ?? saved?.candidate;
        if (!target) return;
        set({ status: 'connecting', paused: false });
        const binding = await createClient().recover(target, saved?.binding);
        await persist({ ...saved!, binding, candidate: undefined });
        epoch = binding.scopeEpoch;
        set({ status: 'connected', binding, sessionId: get().sessionId ?? binding.scope.find(id => !id.startsWith('project:')) ?? null });
        if (saved?.pending) {
          const record = await client!.request({ action: 'status', commandId: saved.pending.commandId }) as CompanionCommandRecord | null;
          if (record && !(await recoverStalePending(record))) await accepted(record); else if (!record) await deliver();
        }
      }),
      pause: () => {
        // 只有「本来连着」才算暂停：原本就断着的话，报错该继续留在界面上。
        // 必须幂等：iOS 退后台会连发两次生命周期回调，第二次时 status 已经是 offline，
        // 按「当前是否连着」重算就会把 paused 打回 false——爸报的那个假警报原样回来
        // （grok ai-review Nit）。暂停标记只由 pair / reconnect 清。
        const live = get().status === 'connected' || get().paused;
        client?.close();
        if (get().binding) set({ status: 'offline', paused: live });
      },
      refreshLibrary: async (more = false) => {
        if (!client || get().status !== 'connected') return;
        try {
          const library = await client.request({ action: 'read', query: { kind: 'library', offset: more ? get().library?.nextOffset ?? 0 : 0 } }) as CompanionLibrary;
          if (!library || !Array.isArray(library.sessions) || !Array.isArray(library.projects) || !Array.isArray(library.models)) throw new Error('COMPANION_INVALID_LIBRARY');
          const sessions = new Map((more ? get().library?.sessions ?? [] : []).map(s => [s.id, s]));
          for (const session of library.sessions) sessions.set(session.id, session);
          set({ library: { ...library, sessions: [...sessions.values()] }, libraryError: false });
        } catch { set({ libraryError: true }); }
      },
      loadHistory: async (id, more = false) => {
        if (!client || get().status !== 'connected') return;
        try {
          const old = get().history[id];
          if (more && old?.nextOffset === null) return;
          const page = await client.request({ action: 'read', query: { kind: 'history', sessionId: id, offset: more ? old?.nextOffset ?? 0 : 0 } }) as CompanionHistory;
          if (page.sessionId !== id || !Array.isArray(page.messages)) throw new Error('COMPANION_INVALID_HISTORY');
          set({ history: { ...get().history, [id]: { ...page, messages: more ? [...page.messages, ...(old?.messages ?? [])] : page.messages } }, libraryError: false });
        } catch { set({ libraryError: true }); }
      },
      manage: (action, payload, target) => safely(async () => {
        if (!saved?.binding || !client || saved.pending || get().status !== 'connected') return;
        const command = companionCommandSchema.parse({ version: 1, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch,
          commandId: crypto.randomUUID(), sessionId: target ?? get().sessionId, action, payload });
        await persist({ ...saved, pending: command }); set({ pending: true }); await deliver();
      }),
      selectSession: sessionId => {
        if ((get().library?.sessions.some(s => s.id === sessionId) || get().binding?.scope.includes(sessionId) || get().events.some(e => e.sessionId === sessionId && e.kind === 'approval')) && !get().busy) {
          const events = get().events.filter(e => e.sessionId === sessionId);
          const last = events.filter(e => ['run_started', 'agent_complete', 'agent_cancelled', 'error'].includes(e.kind)).at(-1);
          // artifacts/preview 是当前会话作用域：切会话必须清掉，否则 offline 时
          // refreshArtifacts 提前 return，B 会话会一直显示 A 会话的成果卡（点开必 ARTIFACT_MISSING）。
          set({ sessionId, runId: last?.kind === 'run_started' ? String(last.payload.runId) : null, terminal: null, artifacts: [], preview: null, savedPreview: false, savedPreviewName: null });
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
        if (!client || get().status !== 'connected') return { kind: 'rejected', reason: 'unsupported_action' };
        return await client.request({ action: 'push.register', provider: input.provider, token: input.token, environment: input.environment }) as CompanionPushRegisterResult;
      },
      unregisterPush: async () => {
        if (!client || get().status !== 'connected') return;
        await client.request({ action: 'push.unregister' });
      },
      openRoute: async routeToken => {
        if (!client || get().status !== 'connected') { set({ routeError: 'auth_required' }); return; }
        const result = await client.request({ action: 'push.open', routeToken }) as CompanionPushOpenResult;
        if (result.kind === 'rejected') { set({ routeError: result.reason }); return; }
        set({ routeError: null });
        get().selectSession(result.sessionId);
        await get().sync();
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
      sync: async () => {
        if (syncing || get().busy || get().status !== 'connected' || !client) return;
        syncing = true;
        try {
          const result = await client.request({ action: 'sync', epoch, afterSeq: cursor }) as CompanionSyncResult;
          if (result.kind === 'snapshot_required') { epoch = result.epoch; cursor = 0; set({ events: [] }); return; }
          // 被撤销不是网络问题：混进通用 offline 会让这台设备一直重试、永远不知道自己已被踢。
          if (result.kind === 'revoked') { client?.close(); set({ status: 'rejected', connectionError: 'connectionRejected' }); return; }
          if (result.kind !== 'events' || result.epoch !== epoch || !Number.isSafeInteger(result.nextSeq) || result.nextSeq < cursor || !Array.isArray(result.events)) throw new Error('COMPANION_INVALID_SYNC');
          set({ events: [...get().events, ...result.events] }); cursor = result.nextSeq;
          for (const event of result.events) if (event.sessionId === get().sessionId && (event.kind === 'run_started' || (event.kind === 'message' && event.payload.role === 'user') || !get().runId || event.payload.runId === get().runId)) {
            if ((event.kind === 'run_started' || (event.kind === 'message' && event.payload.role === 'user')) && typeof event.payload.runId === 'string') set({ runId: event.payload.runId, terminal: null });
            if (event.kind === 'agent_complete') set({ runId: null, terminal: 'complete' });
            if (event.kind === 'agent_cancelled') set({ runId: null, terminal: 'stopped' });
            if (event.kind === 'error') set({ runId: null, terminal: 'failed' });
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
        } catch { client?.close(); if (get().status !== 'storageError') set({ status: 'offline', connectionError: 'connectionUnavailable' }); }
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
      upload: file => safely(async () => {
        if (!saved?.binding || !client || saved.pending || !canAddressSession(get())) return;
        if (file.size > COMPANION_LIMITS.fileMaxBytes || file.bytes.byteLength > COMPANION_LIMITS.fileMaxBytes) {
          set({ commandError: 'UPLOAD_TOO_LARGE' }); return;
        }
        // 扩展名权威：picker 已按扩展名归一化（归不了的是空串），这里不再信任何声明值。
        const mime = companionFileMime(file.name, '');
        if (!mime) { set({ commandError: 'COMPANION_FILE_TYPE_DENIED' }); return; }
        const sha256 = await sha256Hex(file.bytes);
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
          const prepared = await enqueue(companionCommandSchema.parse({ ...base, commandId: crypto.randomUUID(), action: 'files.prepare', payload: { name: file.name, mimeType: mime, size: file.bytes.byteLength, sha256 } }));
          transferId = typeof prepared.result.transferId === 'string' ? prepared.result.transferId : '';
          if (!transferId) throw new Error('COMPANION_INVALID_ACK');
          for (let offset = 0; offset < file.bytes.byteLength; offset += COMPANION_LIMITS.fileChunkBytes) {
            const slice = file.bytes.subarray(offset, offset + COMPANION_LIMITS.fileChunkBytes);
            const data = bytesToBase64(slice);
            await enqueue(companionCommandSchema.parse({ ...base, commandId: crypto.randomUUID(), action: 'files.chunk',
              payload: { transferId, offset, data, sha256: await sha256Hex(slice) } }));
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
        } catch (error) {
          if (transferId && saved?.binding && client) {
            try {
              await enqueue(companionCommandSchema.parse({ ...base, commandId: crypto.randomUUID(), action: 'files.abort', payload: { transferId } }));
            } catch { /* host expireStale/recover deletes staging if this abort cannot be delivered */ }
          }
          await releasePending();
          const code = error instanceof Error ? error.message : 'COMPANION_TRANSFER_INTERRUPTED';
          set({ commandError: companionFileRetryable(code) || code === 'UPLOAD_TOO_LARGE' || code === 'COMPANION_FILE_TYPE_DENIED' ? code : 'COMPANION_TRANSFER_INTERRUPTED' });
        }
      }),
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
          set({ preview: { ...listed, bytes }, savedPreview: false, savedPreviewName: null, cacheUsage: files.cache.inspect(), commandError: cacheFailed ? 'STORAGE_FULL' : null });
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
        set({ cacheUsage: files?.cache.inspect() ?? null, preview: null, savedPreview: false });
        // previewBytes 报告本次释放的预览字节（不是清理后的剩余——那个恒为 0，没有信息量）。
        return { previewBytes: usage.freedBytes, conversationBytes: 0, protectedBytes: 0 };
      },
    };
  });
  return store;
}
