import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { createCompanionRouter } from '../../src/web/routes/companion';
import { projectCompanionEvent } from '../../src/host/services/companion/projectCompanionEvent';
import type { CompanionDeviceCredential } from '../../src/shared/contract/companion';

describe('companion device boundary (HTTP + persistent SQLite)', () => {
  let directory: string;
  let db: Database.Database;
  let gateway: CompanionGateway;
  let phone: CompanionDeviceCredential;
  let other: CompanionDeviceCredential;
  let server: Server;
  let url: string;
  let executions: number;
  const dispatch = () => { executions += 1; return { state: 'accepted' as const, result: { runId: 'run-1' } }; };
  const command = (overrides: Record<string, unknown> = {}) => ({
    version: 1, commandId: 'command-1', deviceId: phone.deviceId, scopeEpoch: phone.scopeEpoch,
    sessionId: 'session-1', action: 'message.send', payload: { text: 'isolated task' }, ...overrides,
  });
  const request = (path: string, body?: unknown, identity = phone) => fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-neo-companion-device': identity.deviceId, 'x-neo-companion-credential': identity.credential },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'neo-companion-boundary-'));
    db = new Database(join(directory, 'test.db'));
    executions = 0;
    gateway = new CompanionGateway(db, { dispatch });
    phone = gateway.issueDeviceCredential(['session-1']);
    other = gateway.issueDeviceCredential(['session-2']);
    const app = express();
    app.use(express.json());
    app.use(createCompanionRouter({ gateway, authenticate: (id, credential) => gateway.authenticateDevice(id, credential) }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('cannot impersonate another paired device in the command body', async () => {
    const response = await request('/commands', command({ deviceId: other.deviceId, sessionId: 'session-2' }));
    expect(response.status).toBe(403);
    expect(executions).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_commands').get()).toEqual({ n: 0 });
  });
  it('rejects access outside the authenticated device session scope', async () => {
    const response = await request('/commands', command({ sessionId: 'session-2' }));
    expect(response.status).toBe(403);
    expect(executions).toBe(0);
  });
  it('filters the sync stream and still advances over unshared events', async () => {
    gateway.publish('session-1', 'message', { text: 'shared' });
    gateway.publish('session-2', 'message', { text: 'private-marker' });
    gateway.publish(null, 'diagnostic', { text: 'global-marker' });
    const body = await (await request('/sync?epoch=1&afterSeq=0')).json();
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0].sessionId).toBe('session-1');
    expect(body.data.nextSeq).toBe(3);
    expect(JSON.stringify(body)).not.toMatch(/private-marker|global-marker/);
  });
  it('replays an acknowledged command without executing again', async () => {
    expect((await request('/commands', command())).status).toBe(202);
    expect((await request('/commands', command())).status).toBe(200);
    expect(executions).toBe(1);
  });
  it('queries the same result after an acknowledgement is lost', async () => {
    await request('/commands', command());
    const body = await (await request('/commands/command-1')).json();
    expect(body.data).toMatchObject({ kind: 'found', command: { commandId: 'command-1', state: 'accepted', result: { runId: 'run-1' } } });
    expect(executions).toBe(1);
  });
  it('does not disclose another device command or payload', async () => {
    await request('/commands', command());
    expect(await (await request('/commands/command-1', undefined, other)).json()).toEqual({ success: true, data: { kind: 'not_seen' } });
  });
  it('reserves a command durably when the final receipt write fails', () => {
    db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON companion_commands BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");
    const result = gateway.submit(command());
    expect(result).toMatchObject({ kind: 'replayed', command: { state: 'reconciling' } });
    expect(executions).toBe(1);
    db.exec('DROP TRIGGER fail_receipt');
    db.close();
    db = new Database(join(directory, 'test.db'));
    const restarted = new CompanionGateway(db, { dispatch });
    expect(restarted.submit(command())).toMatchObject({ kind: 'replayed', command: { state: 'rejected', result: { code: 'COMPANION_INTERRUPTED' } } });
    expect(executions).toBe(1);
  });
  it('does not dispatch if the durable reservation cannot be saved', () => {
    db.exec("CREATE TRIGGER fail_reservation BEFORE INSERT ON companion_commands BEGIN SELECT RAISE(ABORT, 'injected reservation failure'); END");
    expect(() => gateway.submit(command())).toThrow('injected reservation failure');
    expect(executions).toBe(0);
  });
  it('does not blindly redispatch after an uncertain execution exception', () => {
    const uncertain = new CompanionGateway(db, { dispatch: () => { executions += 1; throw new Error('injected after side effect'); } });
    expect(uncertain.submit(command())).toMatchObject({ command: { state: 'reconciling' } });
    expect(uncertain.submit(command())).toMatchObject({ command: { state: 'reconciling' } });
    expect(executions).toBe(1);
  });
  it.each([null, {}, { text: '   ' }, { text: 'ok', providerKey: 'forbidden' }])('rejects invalid message payload %j before dispatch', async payload => {
    expect((await request('/commands', command({ payload }))).status).toBe(403);
    expect(executions).toBe(0);
  });
  it('rejects stale epochs and conflicting command payloads', async () => {
    expect((await request('/commands', command({ scopeEpoch: phone.scopeEpoch + 1 }))).status).toBe(409);
    await request('/commands', command());
    expect((await request('/commands', command({ payload: { text: 'changed' } }))).status).toBe(409);
    expect(executions).toBe(1);
  });
  it('revokes command, sync and receipt access and persists that decision after restart', async () => {
    await request('/commands', command());
    gateway.revokeDevice(phone.deviceId);
    for (const path of ['/sync?epoch=1&afterSeq=0', '/commands/command-1']) expect((await request(path)).status).toBe(401);
    expect((await request('/commands', command())).status).toBe(401);
    const restarted = new CompanionGateway(db, { dispatch });
    expect(restarted.authenticateDevice(phone.deviceId, phone.credential)).toBe(false);
    expect(restarted.sync(1, 0).kind).toBe('snapshot_required');
  });
  it('does not pretend a companion-only decision approves the desktop operation', async () => {
    gateway.registerDecision({ requestId: 'request-1', sessionId: 'session-1', revision: 1, status: 'pending', resolvedBy: null, operationDigest: 'digest-1' });
    const response = await request('/commands', command({ action: 'approval.respond', expectedRevision: 1,
      payload: { requestId: 'request-1', decision: 'approved', operationDigest: 'digest-1' } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { reason: 'unsupported_action' } });
    expect(db.prepare('SELECT status FROM companion_decisions').get()).toEqual({ status: 'pending' });
    expect(executions).toBe(0);
  });
  it('projects user-visible content without tool arguments, paths or diagnostic metadata', () => {
    expect(projectCompanionEvent('tool_call_start', { id: 'tool-1', name: 'read_file', arguments: { token: 'secret-marker' }, liveOutput: { stdout: 'private-marker' } }))
      .toEqual({ id: 'tool-1', name: 'read_file' });
    expect(projectCompanionEvent('tool_call_end', { toolCallId: 'tool-1', success: true, outputPath: '/private/path', metadata: { secret: 'private-marker' } }))
      .toEqual({ toolCallId: 'tool-1', success: true });
    expect(projectCompanionEvent('message', { id: 'm1', role: 'assistant', content: 'visible', reasoning: 'internal', attachments: [{ path: '/private/path' }] }))
      .toEqual({ id: 'm1', role: 'assistant', content: 'visible' });
    expect(projectCompanionEvent('message_delta', { role: 'assistant', path: 'reasoning', op: 'append', text: 'internal' })).toBeNull();
    expect(projectCompanionEvent('message', { id: 'm2', role: 'system', content: 'internal' })).toBeNull();
    expect(projectCompanionEvent('diagnostic', { secret: 'private-marker' })).toBeNull();
    expect(projectCompanionEvent('agent_complete', null)).toEqual({});
    expect(projectCompanionEvent('agent_cancelled', null)).toEqual({});
    expect(projectCompanionEvent('error', { stack: 'private-marker' })).toEqual({ code: 'RUN_FAILED' });
  });
});
