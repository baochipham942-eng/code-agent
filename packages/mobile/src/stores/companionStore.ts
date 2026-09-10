import type { CompanionLibrary, CompanionHistory } from '../../../../src/shared/contract/companionLibrary';
import { createStore } from 'zustand/vanilla';
import { createIdentity } from '../../../../src/shared/companion/noiseChannel';
import { fromHex, toHex, parseInvitation, type LanBinding } from '../../../../src/shared/companion/lanProtocol';
import type { CompanionCommand, CompanionCommandRecord, CompanionEvent, CompanionSyncResult } from '../../../../src/shared/contract/companion';
import { companionCommandSchema } from '../../../../src/shared/contract/companion';
import { LanCompanionClient } from '../platform/lanCompanionClient';
import type { PlatformPorts } from '../platform/ports';

interface Saved {
  version: 1; publicKey: string; secretKey: string;
  candidate?: { endpoint: string; hostKey: string }; binding?: LanBinding; pending?: CompanionCommand;
}
type ConnectionError = 'connectionQrInvalid' | 'connectionScanFailed' | 'connectionRejected' | 'connectionUnavailable' | 'connectionFailed';

interface State {
  voiceOutcome: 'done' | 'error' | null;
  transcribe(audio: { audioData: string; mimeType: string; durationMs: number }, sessionId: string, hostKey: string): Promise<void>;
  library: CompanionLibrary | null; history: Record<string, CompanionHistory>; libraryError: boolean;
  refreshLibrary(more?: boolean): Promise<void>; loadHistory(id: string, more?: boolean): Promise<void>;
  manage(action: 'session.create' | 'session.rename' | 'session.archive' | 'session.delete' | 'session.model', payload: Record<string, unknown>, target?: string): Promise<void>;
  connectionError: ConnectionError | null;
  status: 'unpaired' | 'connecting' | 'connected' | 'offline' | 'storageError' | 'rejected';
  binding: LanBinding | null; sessionId: string | null; pending: boolean; busy: boolean;
  events: CompanionEvent[]; runId: string | null; terminal: 'complete' | 'stopped' | 'failed' | null;
  hydrate(): Promise<void>; pair(): Promise<void>; reconnect(): Promise<void>; pause(): void;
  respond(requestId: string, decision: 'approved' | 'rejected'): Promise<void>;
  selectSession(id: string): void; send(text: string): Promise<void>; stop(): Promise<void>; sync(): Promise<void>;
}

export function createCompanionStore(port: PlatformPorts['companion'], onAccepted: (text: string, sessionId: string, hostKey: string) => void | Promise<void>, onTranscript?: (text: string, sessionId: string, hostKey: string, commandId: string) => Promise<void>) {
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
      if (!pending || record.commandId !== pending.commandId || record.deviceId !== pending.deviceId || record.sessionId !== pending.sessionId || record.action !== pending.action) throw new Error('COMPANION_INVALID_ACK');
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
      if (record.state === 'rejected' || record.state === 'conflict') { set({ status: 'rejected' }); return; }
      if (pending.action === 'session.create' && typeof record.result.sessionId === 'string') set({ sessionId: record.result.sessionId, runId: null, terminal: null });
      if (pending.action === 'session.delete' && get().sessionId === pending.sessionId) set({ sessionId: null, runId: null, terminal: null });
      if (pending.action.startsWith('session.')) await get().refreshLibrary();
      if (pending.action === 'message.send' && get().sessionId === pending.sessionId) {
        const runId = typeof record.result.runId === 'string' ? record.result.runId : null;
        const terminal = get().events.filter(event => event.payload.runId === runId && ['agent_complete', 'agent_cancelled', 'error'].includes(event.kind)).at(-1);
        set({ runId: terminal ? null : runId, terminal: terminal ? terminal.kind === 'agent_complete' ? 'complete' : terminal.kind === 'agent_cancelled' ? 'stopped' : 'failed' : null });
      }
    };
    const deliver = async () => {
      if (!saved?.pending || !client) return;
      const result = await client.request({ action: 'command', command: saved.pending }) as { kind: string; command?: CompanionCommandRecord };
      if (['accepted', 'replayed'].includes(result.kind) && result.command) await accepted(result.command);
      else if (['rejected', 'conflict', 'approval_conflict'].includes(result.kind)) {
        await persist({ ...saved, pending: undefined }); set({ pending: false, status: 'rejected' });
      } else throw new Error('COMPANION_INVALID_ACK');
    };
    const safely = async (work: () => Promise<void>) => {
      if (get().busy) return;
      set({ busy: true, connectionError: null });
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
      connectionError: null, status: 'unpaired', binding: null, sessionId: null, busy: false, pending: false, events: [], runId: null, terminal: null,
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
        set({ status: 'connected', binding, sessionId: binding.scope.find(id => !id.startsWith('project:')) ?? null, library: null, history: {}, events: [], runId: null, terminal: null });
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
          if (record) await accepted(record); else await deliver();
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
        if (!saved?.binding || !client || saved.pending || get().status !== 'connected' || !get().sessionId) return;
        const command = companionCommandSchema.parse({ version: 1, deviceId: saved.binding.deviceId, scopeEpoch: saved.binding.scopeEpoch,
          commandId: crypto.randomUUID(), sessionId: get().sessionId, action: 'voice.transcribe', payload: audio });
        await persist({ ...saved, pending: command }); set({ pending: true, voiceOutcome: null }); await deliver();
      }),
      send: text => safely(async () => {
        if (!saved?.binding || !client || saved.pending || get().status !== 'connected' || !get().sessionId) return;
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
        if (!saved?.binding || saved.pending || get().status !== 'connected' || !get().sessionId) return;
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
          if (result.kind !== 'events' || result.epoch !== epoch || !Number.isSafeInteger(result.nextSeq) || result.nextSeq < cursor || !Array.isArray(result.events)) throw new Error('COMPANION_INVALID_SYNC');
          set({ events: [...get().events, ...result.events] }); cursor = result.nextSeq;
          for (const event of result.events) if (event.sessionId === get().sessionId && (event.kind === 'run_started' || (event.kind === 'message' && event.payload.role === 'user') || !get().runId || event.payload.runId === get().runId)) {
            if ((event.kind === 'run_started' || (event.kind === 'message' && event.payload.role === 'user')) && typeof event.payload.runId === 'string') set({ runId: event.payload.runId, terminal: null });
            if (event.kind === 'agent_complete') set({ runId: null, terminal: 'complete' });
            if (event.kind === 'agent_cancelled') set({ runId: null, terminal: 'stopped' });
            if (event.kind === 'error') set({ runId: null, terminal: 'failed' });
          }
          if (saved?.pending) {
            const pendingId = saved.pending.commandId;
            const record = await client.request({ action: 'status', commandId: pendingId }) as CompanionCommandRecord | null;
            if (record && saved?.pending?.commandId === pendingId) await accepted(record);
          }
        } catch { client?.close(); if (get().status !== 'storageError') set({ status: 'offline', connectionError: 'connectionUnavailable' }); }
        finally { syncing = false; }
      },
    };
  });
  return store;
}
