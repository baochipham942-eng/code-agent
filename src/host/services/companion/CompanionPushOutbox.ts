import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import type { CompanionEvent } from '../../../shared/contract/companion';
import {
  companionPushOpenSchema,
  companionPushRegisterSchema,
  companionPushTitleKey,
  type CompanionPushDispatchResult,
  type CompanionPushOpenResult,
  type CompanionPushRegister,
  type CompanionPushRegisterResult,
  type CompanionPushUnregisterResult,
  type GeneralizedPushPayload,
} from '../../../shared/contract/companionPush';
import { applyCompanionSchema } from '../core/database/migrations/companion';
import type { CompanionGateway } from './CompanionGateway';
import { dispatchCompanionPush, unwrapPushToken, wrapPushToken, type PushSendRequest } from './companionPushProviders';

type SqlRow = Record<string, unknown>;
type OutboxState = 'pending' | 'sent' | 'skipped' | 'expired' | 'failed';

export interface CompanionPushOutboxDeps {
  now?: () => number;
  wrapKey: Buffer;
  apnsKeyPath?: string | null;
  send?: (request: PushSendRequest) => Promise<CompanionPushDispatchResult>;
}

export function loadPushWrapKeySync(dataDirectory: string): Buffer {
  const file = join(dataDirectory, 'companion-push.wrap');
  try {
    const existing = readFileSync(file);
    if (existing.length === 32) return existing;
  } catch { /* create below */ }
  const key = randomBytes(32);
  try {
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(file, key, { mode: 0o600 });
  } catch { /* in-memory wrap for this process only */ }
  return key;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Companion event → generalized push outbox. Re-checks revoke and session
 * access before any provider call. Payload never includes project names,
 * bodies, or approval details.
 */
export class CompanionPushOutbox {
  private readonly now: () => number;
  private flushTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly gateway: Pick<CompanionGateway, 'canAccessSession' | 'activeDevices' | 'isUsableDevice' | 'hasDevice'>,
    private readonly deps: CompanionPushOutboxDeps,
  ) {
    this.now = deps.now ?? Date.now;
    applyCompanionSchema(this.db);
  }

  register(deviceId: string, raw: unknown, now = this.now()): CompanionPushRegisterResult {
    if (!this.gateway.hasDevice(deviceId)) return { kind: 'rejected', reason: 'device_unknown' };
    if (!this.gateway.isUsableDevice(deviceId)) return { kind: 'rejected', reason: 'device_revoked' };
    const parsed = companionPushRegisterSchema.safeParse(raw);
    if (!parsed.success) return { kind: 'rejected', reason: 'invalid_command' };
    const input: CompanionPushRegister = parsed.data;
    this.db.prepare(`
      INSERT INTO companion_push_registrations
        (device_id, provider, environment, token_wrap, token_hash, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        provider = excluded.provider,
        environment = excluded.environment,
        token_wrap = excluded.token_wrap,
        token_hash = excluded.token_hash,
        updated_at = excluded.updated_at
    `).run(deviceId, input.provider, input.environment, wrapPushToken(input.token, this.deps.wrapKey), tokenHash(input.token), now, now);
    return { kind: 'registered', provider: input.provider, environment: input.environment };
  }

  unregister(deviceId: string): CompanionPushUnregisterResult {
    if (!this.gateway.hasDevice(deviceId)) return { kind: 'rejected', reason: 'device_unknown' };
    this.db.prepare('DELETE FROM companion_push_registrations WHERE device_id = ?').run(deviceId);
    if (!this.gateway.isUsableDevice(deviceId)) return { kind: 'rejected', reason: 'device_revoked' };
    return { kind: 'unregistered' };
  }

  forgetDevice(deviceId: string): void {
    this.db.prepare('DELETE FROM companion_push_registrations WHERE device_id = ?').run(deviceId);
    this.db.prepare(`UPDATE companion_push_outbox SET state = 'skipped' WHERE device_id = ? AND state = 'pending'`)
      .run(deviceId);
  }

  enqueue(event: CompanionEvent, now = this.now()): void {
    if (!event.sessionId) return;
    const titleKey = companionPushTitleKey(event.kind, event.payload);
    if (!titleKey) return;
    const kind = event.kind as GeneralizedPushPayload['kind'];
    for (const device of this.gateway.activeDevices()) {
      if (!this.gateway.canAccessSession(device.deviceId, event.sessionId)) continue;
      const routeToken = randomBytes(32).toString('base64url');
      const payload: GeneralizedPushPayload = { titleKey, kind, routeToken };
      this.db.prepare(`
        INSERT OR IGNORE INTO companion_push_outbox
          (event_id, device_id, kind, session_id, state, attempts, expires_at, route_token, payload_json, created_at)
        VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
      `).run(event.eventId, device.deviceId, kind, event.sessionId, now + L.pushTtlMs, routeToken, JSON.stringify(payload), now);
    }
  }

  async flush(now = this.now()): Promise<void> {
    const run = this.flushTail.then(() => this.dispatchPending(now));
    this.flushTail = run.catch(() => {});
    return run;
  }

  rowsFor(deviceId: string): SqlRow[] {
    return this.db.prepare('SELECT event_id, device_id, kind, state, attempts, expires_at, payload_json FROM companion_push_outbox WHERE device_id = ?')
      .all(deviceId) as SqlRow[];
  }

  open(deviceId: string, raw: unknown, now = this.now()): CompanionPushOpenResult {
    if (!this.gateway.isUsableDevice(deviceId)) return { kind: 'rejected', reason: 'device_revoked' };
    const parsed = companionPushOpenSchema.safeParse(raw);
    if (!parsed.success) return { kind: 'rejected', reason: 'unknown_token' };
    const row = this.db.prepare('SELECT * FROM companion_push_outbox WHERE route_token = ?').get(parsed.data.routeToken) as SqlRow | undefined;
    if (!row) return { kind: 'rejected', reason: 'unknown_token' };
    if (String(row.device_id) !== deviceId) return { kind: 'rejected', reason: 'device_mismatch' };
    const sessionId = String(row.session_id);
    if (!this.gateway.canAccessSession(deviceId, sessionId)) return { kind: 'rejected', reason: 'scope_denied' };
    if (Number(row.expires_at) <= now) return { kind: 'reread', sessionId };
    return { kind: 'open', sessionId };
  }

  private async dispatchPending(now: number): Promise<void> {
    const rows = this.db.prepare(`SELECT * FROM companion_push_outbox WHERE state = 'pending'`).all() as SqlRow[];
    for (const row of rows) await this.dispatchRow(row, now);
  }

  private async dispatchRow(row: SqlRow, now: number): Promise<void> {
    const eventId = String(row.event_id);
    const deviceId = String(row.device_id);
    const kind = String(row.kind);
    const attempts = Number(row.attempts);
    const mark = (state: OutboxState) => {
      this.db.prepare(`UPDATE companion_push_outbox SET state = ?, attempts = ? WHERE event_id = ? AND device_id = ? AND kind = ?`)
        .run(state, attempts + 1, eventId, deviceId, kind);
    };
    if (Number(row.expires_at) <= now) { mark('expired'); return; }
    if (!this.gateway.isUsableDevice(deviceId)) { mark('skipped'); return; }
    const sessionId = String(row.session_id);
    if (!this.gateway.canAccessSession(deviceId, sessionId)) { mark('skipped'); return; }
    const registration = this.db.prepare('SELECT * FROM companion_push_registrations WHERE device_id = ?').get(deviceId) as SqlRow | undefined;
    if (!registration) { mark('failed'); return; }
    const token = unwrapPushToken(String(registration.token_wrap), this.deps.wrapKey);
    if (!token) { mark('failed'); return; }
    const payload = JSON.parse(String(row.payload_json)) as GeneralizedPushPayload;
    const result = await dispatchCompanionPush({
      provider: registration.provider as PushSendRequest['provider'],
      environment: registration.environment as PushSendRequest['environment'],
      token,
      payload,
    }, { apnsKeyPath: this.deps.apnsKeyPath ?? null, send: this.deps.send });
    if (result.accepted) { mark('sent'); return; }
    if (result.code === 'CHANNEL_MISSING' || result.code === 'NOT_REGISTERED' || result.code === 'TOKEN_UNWRAP_FAILED') {
      mark('failed');
      return;
    }
    if (attempts + 1 >= L.pushMaxAttempts) mark('failed');
    else {
      this.db.prepare(`UPDATE companion_push_outbox SET attempts = ? WHERE event_id = ? AND device_id = ? AND kind = ?`)
        .run(attempts + 1, eventId, deviceId, kind);
    }
  }
}
