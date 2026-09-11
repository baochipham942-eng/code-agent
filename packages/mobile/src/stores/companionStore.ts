import type { CompanionArtifact, CompanionArtifacts, CompanionLibrary, CompanionHistory } from '../../../../src/shared/contract/companionLibrary';
import { createStore } from 'zustand/vanilla';
import { createIdentity } from '../../../../src/shared/companion/noiseChannel';
import { fromHex, toHex, parseInvitation, type LanBinding } from '../../../../src/shared/companion/lanProtocol';
import type { CompanionCommand, CompanionCommandRecord, CompanionEvent, CompanionSyncResult } from '../../../../src/shared/contract/companion';
import { companionCommandSchema } from '../../../../src/shared/contract/companion';
import { LanCompanionClient } from '../platform/lanCompanionClient';
import type { FilePorts, PlatformPorts, PickedFile } from '../platform/ports';
import { companionFileMime, companionFileRetryable, COMPANION_LIMITS } from '../../../../src/shared/constants/companion';
import { base64ToBytes, bytesToBase64, sha256Hex, type CacheInspect } from '../platform/fileCache';

interface Saved {
  version: 1; publicKey: string; secretKey: string;
  candidate?: { endpoint: string; hostKey: string }; binding?: LanBinding; pending?: CompanionCommand;
}
type ConnectionError = 'connectionQrInvalid' | 'connectionScanFailed' | 'connectionRejected' | 'connectionUnavailable' | 'connectionFailed';

/**
 * 只有这几种 reason 说的是「这台设备不能用了」——撤销、主机不认、授权不覆盖、epoch 已翻篇，
 * 四者都要重新配对/重连才能恢复。其余（approval_conflict 抢答、payload 不符、动作不支持…）
 * 都只是**这一条命令**没成，连接本身照旧可用。
 * `status` 描述连接，命令结果写 `commandError`；两条 ack 路径共用这一个判据，别再各判各的。
 */
const DEVICE_LEVEL_REASONS = new Set(['device_revoked', 'device_unknown', 'scope_denied', 'scope_epoch_mismatch']);

interface State {
  voiceOutcome: 'done' | 'error' | null;
  transcribe(audio: { audioData: string; mimeType: string; durationMs: number }, sessionId: string, hostKey: string): Promise<void>;
  library: CompanionLibrary | null; history: Record<string, CompanionHistory>; libraryError: boolean;
  refreshLibrary(more?: boolean): Promise<void>; loadHistory(id: string, more?: boolean): Promise<void>;
  manage(action: 'session.create' | 'session.rename' | 'session.archive' | 'session.delete' | 'session.model', payload: Record<string, unknown>, target?: string): Promise<void>;
  connectionError: ConnectionError | null;
  /** Why the last command was refused. Connection-level standing stays in `status`. */
  commandError: string | null;
  status: 'unpaired' | 'connecting' | 'connected' | 'offline' | 'storageError' | 'rejected';
  binding: LanBinding | null; sessionId: string | null; pending: boolean; busy: boolean;
  events: CompanionEvent[]; runId: string | null; terminal: 'complete' | 'stopped' | 'failed' | null;
  hydrate(): Promise<void>; pair(): Promise<void>; reconnect(): Promise<void>; pause(): void;
  respond(requestId: string, decision: 'approved' | 'rejected'): Promise<void>;
  selectSession(id: string): void; send(text: string): Promise<void>; stop(): Promise<void>; sync(): Promise<void>;
  artifacts: CompanionArtifact[]; preview: (CompanionArtifact & { bytes: Uint8Array }) | null; savedPreview: boolean;
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

export function createCompanionStore(port: PlatformPorts['companion'], onAccepted: (text: string, sessionId: string, hostKey: string) => void | Promise<void>, onTranscript?: (text: string, sessionId: string, hostKey: string, commandId: string) => Promise<void>, files?: FilePorts) {
  let saved: Saved | null = null;
  let client: LanCompanionClient | null = null;
  let epoch = 1; let cursor = 0;
  let syncing = false;

  const store = createStore<State>((set, get) => {
    const persist = async (next: Saved) => {
      if (!port) throw new Error('COMPANION_NATIVE_REQUIRED');
      try { await port.write(JSON.stringify(next)); saved = next; }
      catch (error) { client?.close(); set({ status: 'storageError' }); throw error; }
    };
    const createClient = () => {
      if (!saved || !port) throw new Error('COMPANION_NATIVE_REQUIRED');
      client?.close();
      client = new LanCompanionClient({ publicKey: fromHex(saved.publicKey, 32), secretKey: fromHex(saved.secretKey, 32) }, port.post);
      return client;
    };
    const accepted = async (record: CompanionCommandRecord) => {
      const pending = saved?.pending;
      if (!pending || !companionAckMatches(pending, record)) throw new Error('COMPANION_INVALID_ACK');
      if (record.state === 'reconciling') return;
      if (!['accepted', 'resolved', 'rejected', 'conflict'].includes(record.state)) throw new Error('COMPANION_INVALID_ACK');
      if (record.state !== 'rejected' && record.state !== 'conflict' && pending.action === 'message.send') {
        // Retain the command reservation until the draft has durably cleared.
        await onAccepted(pending.payload.text, pending.sessionId, saved!.binding!.hostKey);
      }
      if (pending.action === 'voice.transcribe') {
        if (record.state === 'accepted' && typeof record.result.text === 'string' && onTranscript) {
          await onTranscript(record.result.text, pending.sessionId, saved!.binding!.hostKey, pending.commandId); set({ voiceOutcome: 'done' });
        } else set({ voiceOutcome: 'error' });
      }
      await persist({ ...saved!, pending: undefined });
      set({ pending: false });
      if (record.state === 'rejected' || record.state === 'conflict') {
        // 单条命令被拒（转写失败 / RUN_NOT_ACTIVE / 审批被抢答）不代表这台设备不能用了。
        // 置成 status:'rejected' 会挡住 sync 和后续每一条命令，事件流从此停摆到手动重连。
        set({ commandError: typeof record.result.code === 'string' ? record.result.code : 'COMPANION_COMMAND_REJECTED' });
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
      await persist({ ...saved!, pending: undefined });
      set({ pending: false, commandError: 'COMPANION_COMMAND_RECONCILING_TIMEOUT' });
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
        await persist({ ...saved, pending: undefined });
        // 按语义分，不按「它是不是 rejected」分。桌面或另一台手机先批了同一条审批时，
        // 网关回的是 approval_conflict——那是正常抢答，把整台设备停掉是错的。
        set(typeof result.reason === 'string' && DEVICE_LEVEL_REASONS.has(result.reason)
          ? { pending: false, status: 'rejected', connectionError: 'connectionRejected' }
          : { pending: false, commandError: result.kind === 'approval_conflict' ? 'COMPANION_APPROVAL_CONFLICT' : result.reason ?? 'COMPANION_COMMAND_REJECTED' });
        return result.command ?? null;
      }
      throw new Error('COMPANION_INVALID_ACK');
    };
    const releasePending = async () => {
      if (saved?.pending) await persist({ ...saved, pending: undefined });
      set({ pending: false });
    };
    const safely = async (work: () => Promise<void>) => {
      if (get().busy) return;
      set({ busy: true, connectionError: null, commandError: null });
      try { await work(); } catch (error) {
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
      voiceOutcome: null, library: null, history: {}, libraryError: false,
      connectionError: null, commandError: null, status: 'unpaired', binding: null, sessionId: null, busy: false, pending: false, events: [], runId: null, terminal: null,
      artifacts: [], preview: null, savedPreview: false, cacheUsage: files?.cache.inspect() ?? null,
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
          set({ busy: false, binding: value.binding ?? null, sessionId: value.binding?.scope.find(id => !id.startsWith('project:')) ?? null, pending: !!value.pending });
          if (value.candidate || value.binding) await get().reconnect();
        } catch { set({ busy: false, status: 'storageError' }); }
      },
      pair: () => safely(async () => {
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
        await persist({ ...saved!, candidate: { endpoint: invitation.endpoint, hostKey: invitation.hostKey }, binding: undefined });
        const binding = await createClient().pair(raw);
        await persist({ ...saved!, binding, candidate: undefined });
        epoch = binding.scopeEpoch; cursor = 0;
        set({ status: 'connected', binding, sessionId: binding.scope.find(id => !id.startsWith('project:')) ?? null, library: null, history: {}, events: [], artifacts: [], preview: null, runId: null, terminal: null });
      }),
      reconnect: () => safely(async () => {
        const target = saved?.binding ?? saved?.candidate;
        if (!target) return;
        set({ status: 'connecting' });
        const binding = await createClient().recover(target.endpoint, target.hostKey, saved?.binding);
        await persist({ ...saved!, binding, candidate: undefined });
        epoch = binding.scopeEpoch;
        set({ status: 'connected', binding, sessionId: get().sessionId ?? binding.scope.find(id => !id.startsWith('project:')) ?? null });
        if (saved?.pending) {
          const record = await client!.request({ action: 'status', commandId: saved.pending.commandId }) as CompanionCommandRecord | null;
          if (record && !(await recoverStalePending(record))) await accepted(record); else if (!record) await deliver();
        }
      }),
      pause: () => { client?.close(); if (get().binding) set({ status: 'offline' }); },
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
          set({ sessionId, runId: last?.kind === 'run_started' ? String(last.payload.runId) : null, terminal: null });
        }
      },
      transcribe: (audio, sessionId, hostKey) => safely(async () => {
        if (get().sessionId !== sessionId || get().binding?.hostKey !== hostKey) return;
        if (!saved?.binding || !client || saved.pending || !canAddressSession(get())) return;
        const command = companionCommandSchema.parse({ version: 1, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch,
          commandId: crypto.randomUUID(), sessionId: get().sessionId, action: 'voice.transcribe', payload: audio });
        await persist({ ...saved, pending: command }); set({ pending: true, voiceOutcome: null }); await deliver();
      }),
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
        const mime = companionFileMime(file.name, file.mimeType);
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
          if (transferId && saved?.binding && client && get().status === 'connected') {
            try {
              await enqueue(companionCommandSchema.parse({ ...base, commandId: crypto.randomUUID(), action: 'files.abort', payload: { transferId } }));
            } catch { /* host recover() deletes staging; phone must not keep a half-file */ }
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
          set({ preview: { ...listed, bytes: cached.bytes }, savedPreview: false });
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
          files.cache.put(artifactId, { name: listed.name, mimeType: listed.mimeType, bytes });
          set({ preview: { ...listed, bytes }, savedPreview: false, cacheUsage: files.cache.inspect() });
        } catch (error) {
          await releasePending();
          const code = error instanceof Error ? error.message : 'ARTIFACT_MISSING';
          set({ commandError: code, preview: null });
        }
      }),
      closePreview: () => set({ preview: null, savedPreview: false }),
      savePreview: async () => {
        const preview = get().preview;
        if (!preview || !files) return;
        const result = await files.save({ name: preview.name, mimeType: preview.mimeType, bytes: preview.bytes });
        if (result.status === 'saved') set({ savedPreview: true, commandError: null });
        else if (result.status === 'cancelled') set({ savedPreview: false });
        else set({ commandError: result.code ?? 'COMPANION_EXPORT_FAILED', savedPreview: false });
      },
      clearCache: () => {
        const usage = files?.cache.clear() ?? { freedBytes: 0, remainingBytes: 0, failedEntries: [] };
        set({ cacheUsage: files?.cache.inspect() ?? null, preview: null, savedPreview: false });
        return { previewBytes: usage.remainingBytes, conversationBytes: 0, protectedBytes: 0 };
      },
    };
  });
  return store;
}
