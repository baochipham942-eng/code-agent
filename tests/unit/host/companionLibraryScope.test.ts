import { describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';

function fixture() {
  const db = new Database(':memory:');
  const dispatch = vi.fn(() => ({ state: 'resolved' as const, result: {} }));
  const projects: Record<string, string> = { a: 'one', b: 'one', secret: 'two' };
  const gateway = new CompanionGateway(db, { sessionProject: id => projects[id] ?? null, dispatch });
  const device = gateway.issueDeviceCredential(['a']);
  const projectDevice = gateway.issueDeviceCredential(['project:one']);
  const command = (id: string, action = 'message.send', payload: unknown = { text: 'hello' }, d = projectDevice) => ({
    version: 1, deviceId: d.deviceId, scopeEpoch: d.scopeEpoch, commandId: `cmd-${id}-${action}`, sessionId: id, action, payload,
  });
  return { db, gateway, dispatch, device, projectDevice, projects, command };
}

describe('companion explicit project scope', () => {
  it('keeps old session grants narrow and only admits explicitly shared project members', () => {
    const f = fixture();
    try {
      expect(f.gateway.canAccessSession(f.device.deviceId, 'a')).toBe(true);
      expect(f.gateway.canAccessSession(f.device.deviceId, 'b')).toBe(false);
      expect(f.gateway.canAccessSession(f.projectDevice.deviceId, 'b')).toBe(true);
      expect(f.gateway.submit(f.command('secret'))).toMatchObject({ kind: 'rejected', reason: 'scope_denied' });
      expect(f.dispatch).not.toHaveBeenCalled();
      f.projects.b = 'two';
      expect(f.gateway.canAccessSession(f.projectDevice.deviceId, 'b')).toBe(false);
    } finally { f.db.close(); }
  });
  it('requires the exact project grant for creation and replays mutations without execution', () => {
    const f = fixture();
    try {
      const payload = { title: 'new', provider: 'configured-provider', model: 'configured-model' };
      expect(f.gateway.submit(f.command('a', 'session.create', payload, f.device))).toMatchObject({ kind: 'rejected' });
      expect(f.gateway.submit(f.command('project:two', 'session.create', payload))).toMatchObject({ kind: 'rejected' });
      const command = f.command('project:one', 'session.create', payload);
      expect(f.gateway.submit(command)).toMatchObject({ kind: 'accepted' });
      expect(f.gateway.submit(command)).toMatchObject({ kind: 'replayed' });
      expect(f.dispatch).toHaveBeenCalledTimes(1);
      expect(f.gateway.commandStatus(f.projectDevice.deviceId, command.commandId)).not.toBeNull();
    } finally { f.db.close(); }
  });
  it('does not expose a deleted project member through /sync', () => {
    const f = fixture();
    try {
      f.gateway.publish('b', 'message', { content: 'deleted-member' });
      expect(f.gateway.syncForDevice(f.projectDevice.deviceId, 1, 0).events.map(e => e.payload.content)).toEqual(['deleted-member']);
      f.gateway.forgetSession('b');
      expect(f.gateway.canAccessSession(f.projectDevice.deviceId, 'b')).toBe(false);
      expect(f.gateway.syncForDevice(f.projectDevice.deviceId, 1, 0).events).toEqual([]);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM companion_events WHERE session_id = ?').get('b')).toEqual({ n: 0 });
    } finally { f.db.close(); }
  });
  it('hides leftover deleted-session events from a later project grant', () => {
    const f = fixture();
    try {
      f.gateway.publish('b', 'message', { content: 'stale-deleted' });
      f.db.prepare('INSERT INTO companion_session_cleanup (session_id) VALUES (?)').run('b');
      expect(f.gateway.syncForDevice(f.projectDevice.deviceId, 1, 0).events).toEqual([]);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM companion_events WHERE session_id = ?').get('b')).toEqual({ n: 1 });
    } finally { f.db.close(); }
  });
  it('filters project events and rejects revocation without exposing global events', () => {
    const f = fixture();
    try {
      f.gateway.publish('a', 'message', { content: 'shared' });
      f.gateway.publish('secret', 'message', { content: 'private' });
      f.gateway.publish(null, 'message', { content: 'global' });
      expect(f.gateway.syncForDevice(f.projectDevice.deviceId, 1, 0).events.map(e => e.payload.content)).toEqual(['shared']);
      f.gateway.revokeDevice(f.projectDevice.deviceId);
      expect(f.gateway.canAccessSession(f.projectDevice.deviceId, 'a')).toBe(false);
      expect(f.gateway.submit(f.command('a'))).toMatchObject({ kind: 'rejected', reason: 'device_revoked' });
    } finally { f.db.close(); }
  });
  it('atomically commits mutation receipts and rejects only interrupted reservations on restart', () => {
    const db = new Database(':memory:'); db.exec('CREATE TABLE effects (value TEXT)');
    const gateway = new CompanionGateway(db, { dispatch: () => ({ state: 'reconciling' }) });
    const device = gateway.issueDeviceCredential(['a']);
    const command = { version: 1 as const, deviceId: device.deviceId, scopeEpoch: device.scopeEpoch, sessionId: 'a', commandId: 'rename', action: 'session.rename' as const, payload: { title: 'renamed' } };
    try {
      gateway.submit(command);
      expect(() => gateway.commitMutation(command, () => { db.prepare('INSERT INTO effects VALUES (?)').run('rollback'); throw new Error('disk failure'); }, {})).toThrow();
      expect(db.prepare('SELECT * FROM effects').all()).toHaveLength(0);
      gateway.commitMutation(command, () => { db.prepare('INSERT INTO effects VALUES (?)').run('committed'); }, { sessionId: 'a' });
      gateway.submit({ ...command, commandId: 'interrupted' });
      const restarted = new CompanionGateway(db);
      expect(restarted.commandStatus(device.deviceId, 'rename')).toMatchObject({ state: 'accepted' });
      expect(restarted.commandStatus(device.deviceId, 'interrupted')).toMatchObject({ state: 'rejected', result: { code: 'COMPANION_INTERRUPTED' } });
      expect(db.prepare('SELECT * FROM effects').all()).toEqual([{ value: 'committed' }]);
    } finally { db.close(); }
  });
  it('does not overwrite a synchronous atomic receipt with the async dispatch placeholder', () => {
    const db = new Database(':memory:');
    const gateway = new CompanionGateway(db, { dispatch: command => {
      gateway.commitMutation(command, () => {}, { sessionId: command.sessionId });
      return { state: 'reconciling' };
    } });
    const device = gateway.issueDeviceCredential(['a']);
    try {
      const result = gateway.submit({ version: 1, deviceId: device.deviceId, scopeEpoch: 1, sessionId: 'a', commandId: 'sync-rename', action: 'session.rename', payload: { title: 'new' } });
      expect(result).toMatchObject({ kind: 'accepted', command: { state: 'accepted' } });
      expect(new CompanionGateway(db).commandStatus(device.deviceId, 'sync-rename')).toMatchObject({ state: 'accepted' });
    } finally { db.close(); }
  });
  it('rechecks revocation after an asynchronous read finishes', async () => {
    const db = new Database(':memory:');
    let finish!: (value: unknown) => void;
    const gateway = new CompanionGateway(db, { read: () => new Promise(resolve => { finish = resolve; }) });
    const device = gateway.issueDeviceCredential(['a']);
    try {
      const result = gateway.read(device.deviceId, { kind: 'history', sessionId: 'a' });
      gateway.revokeDevice(device.deviceId); finish({ content: 'private' });
      await expect(result).rejects.toThrow('COMPANION_SCOPE_DENIED');
    } finally { db.close(); }
  });
});
