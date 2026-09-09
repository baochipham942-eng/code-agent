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
interface State {
  status: 'unpaired' | 'connecting' | 'connected' | 'offline' | 'storageError' | 'rejected';
  binding: LanBinding | null; sessionId: string | null; pending: boolean; busy: boolean;
  events: CompanionEvent[]; runId: string | null; terminal: 'complete' | 'stopped' | 'failed' | null;
  hydrate(): Promise<void>; pair(): Promise<void>; reconnect(): Promise<void>; pause(): void;
  respond(requestId: string, decision: 'approved' | 'rejected'): Promise<void>;
  selectSession(id: string): void; send(text: string): Promise<void>; stop(): Promise<void>; sync(): Promise<void>;
}

export function createCompanionStore(port: PlatformPorts['companion'], onAccepted: (text: string) => void | Promise<void>) {
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
        await onAccepted(pending.payload.text);
      }
      await persist({ ...saved!, pending: undefined });
      set({ pending: false });
      if (record.state === 'rejected' || record.state === 'conflict') { set({ status: 'rejected' }); return; }
      if (pending.action === 'message.send') {
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
      set({ busy: true });
      try { await work(); } catch { client?.close(); if (get().status !== 'storageError') set({ status: 'offline' }); }
      finally { set({ busy: false }); }
    };
    return {
      status: 'unpaired', binding: null, sessionId: null, busy: false, pending: false, events: [], runId: null, terminal: null,
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
          set({ busy: false, binding: value.binding ?? null, sessionId: value.binding?.scope[0] ?? null, pending: !!value.pending });
          if (value.candidate || value.binding) await get().reconnect();
        } catch { set({ busy: false, status: 'storageError' }); }
      },
      pair: () => safely(async () => {
        if (!port || saved?.pending) return;
        const raw = await port.scan(); const invitation = parseInvitation(raw);
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
        set({ status: 'connected', binding, sessionId: binding.scope[0], events: [], runId: null, terminal: null });
      }),
      reconnect: () => safely(async () => {
        const target = saved?.binding ?? saved?.candidate;
        if (!target) return;
        set({ status: 'connecting' });
        const binding = await createClient().recover(target.endpoint, target.hostKey, saved?.binding);
        await persist({ ...saved!, binding, candidate: undefined });
        epoch = binding.scopeEpoch;
        set({ status: 'connected', binding, sessionId: get().sessionId ?? binding.scope[0] });
        if (saved?.pending) {
          const record = await client!.request({ action: 'status', commandId: saved.pending.commandId }) as CompanionCommandRecord | null;
          if (record) await accepted(record); else await deliver();
        }
      }),
      pause: () => { client?.close(); if (get().binding) set({ status: 'offline' }); },
      selectSession: sessionId => { if (get().binding?.scope.includes(sessionId) && !get().pending && !get().busy) set({ sessionId, runId: null, terminal: null }); },
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
          for (const event of result.events) if (event.sessionId === get().sessionId && (event.kind === 'run_started' || !get().runId || event.payload.runId === get().runId)) {
            if (event.kind === 'run_started' && typeof event.payload.runId === 'string') set({ runId: event.payload.runId, terminal: null });
            if (event.kind === 'agent_complete') set({ runId: null, terminal: 'complete' });
            if (event.kind === 'agent_cancelled') set({ runId: null, terminal: 'stopped' });
            if (event.kind === 'error') set({ runId: null, terminal: 'failed' });
          }
          if (saved?.pending) {
            const record = await client.request({ action: 'status', commandId: saved.pending.commandId }) as CompanionCommandRecord | null;
            if (record) await accepted(record);
          }
        } catch { client?.close(); if (get().status !== 'storageError') set({ status: 'offline' }); }
        finally { syncing = false; }
      },
    };
  });
  return store;
}
