import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, type IncomingHttpHeaders, type IncomingHttpStatusHeader } from 'node:http2';
import { COMPANION_APNS, COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import type {
  CompanionPushDispatchResult,
  CompanionPushEnvironment,
  GeneralizedPushPayload,
} from '../../../shared/contract/companionPush';
import { createLogger } from '../infra/logger';
import type { PushSendRequest } from './companionPushProviders';

const logger = createLogger('CompanionApns');

interface CompanionApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  environment: CompanionPushEnvironment;
}

interface CompanionApnsTransport {
  apnsKeyPath: string | null;
  send?: (request: PushSendRequest) => Promise<CompanionPushDispatchResult>;
  authority?: string;
}

interface CompanionApnsTransportOverrides {
  authority?: string | ((environment: CompanionPushEnvironment) => string);
  now?: () => number;
}

interface ApnsHttpResult {
  status: number;
  reason: string;
  retryAfterMs?: number;
}

function readCompanionApnsConfig(env: NodeJS.Dict<string>): CompanionApnsConfig | null {
  const keyPath = env.NEO_APNS_KEY_PATH?.trim() ?? '';
  const keyId = env.NEO_APNS_KEY_ID?.trim() ?? '';
  const teamId = env.NEO_APNS_TEAM_ID?.trim() ?? '';
  const bundleId = env.NEO_APNS_BUNDLE_ID?.trim() ?? '';
  const environment = env.NEO_APNS_ENV?.trim() ?? '';
  if (!keyPath || !keyId || !teamId || !bundleId) return null;
  if (environment !== 'production' && environment !== 'sandbox') return null;
  return { keyPath, keyId, teamId, bundleId, environment };
}

function companionApnsAuthority(environment: CompanionPushEnvironment): string {
  return environment === 'sandbox' ? COMPANION_APNS.sandboxAuthority : COMPANION_APNS.productionAuthority;
}

function buildApnsPayload(payload: GeneralizedPushPayload): Record<string, unknown> {
  return {
    aps: { alert: { 'loc-key': payload.titleKey } },
    titleKey: payload.titleKey,
    kind: payload.kind,
    routeToken: payload.routeToken,
  };
}

function signCompanionApnsJwt(pem: string, keyId: string, teamId: string, iatSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat: iatSeconds }));
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(pem);
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function companionApnsOutboxTransport(
  env: NodeJS.Dict<string>,
  overrides?: CompanionApnsTransportOverrides,
): CompanionApnsTransport {
  const config = readCompanionApnsConfig(env);
  if (!config) return { apnsKeyPath: null };
  return {
    apnsKeyPath: config.keyPath,
    authority: companionApnsAuthority(config.environment),
    send: createCompanionApnsSender(config, overrides ?? {}),
  };
}

function resolveApnsAuthority(
  environment: CompanionPushEnvironment,
  override?: CompanionApnsTransportOverrides['authority'],
): string {
  if (typeof override === 'function') return override(environment);
  if (override) return override;
  return companionApnsAuthority(environment);
}

function createCompanionApnsSender(
  config: CompanionApnsConfig,
  overrides: CompanionApnsTransportOverrides,
): (request: PushSendRequest) => Promise<CompanionPushDispatchResult> {
  const now = overrides.now ?? Date.now;
  let cachedJwt = '';
  let issuedAtMs = 0;
  let lastIat = 0;

  const mint = (force: boolean): string | null => {
    const t = now();
    if (!force && cachedJwt && t - issuedAtMs < L.pushJwtTtlMs) return cachedJwt;
    const pem = readApnsKey(config.keyPath);
    if (!pem) return null;
    const seconds = Math.floor(t / 1000);
    const iat = force ? Math.max(seconds, lastIat + 1) : seconds;
    cachedJwt = signCompanionApnsJwt(pem, config.keyId, config.teamId, iat);
    issuedAtMs = t;
    lastIat = iat;
    return cachedJwt;
  };

  return async (request: PushSendRequest): Promise<CompanionPushDispatchResult> => {
    if (request.provider !== 'apns') {
      return { accepted: false, code: 'CHANNEL_MISSING', missing: 'gms_or_vendor' };
    }
    const jwt = mint(false);
    if (!jwt) return { accepted: false, code: 'CHANNEL_MISSING', missing: 'apns_auth_key' };
    const authority = resolveApnsAuthority(request.environment, overrides.authority);
    try {
      let response = await postApns({
        authority,
        jwt,
        deviceToken: request.token,
        topic: config.bundleId,
        payload: buildApnsPayload(request.payload),
        timeoutMs: L.requestTimeoutMs,
        nowMs: now(),
      });
      if (response.status === 403 && response.reason === 'ExpiredProviderToken') {
        const refreshed = mint(true);
        if (!refreshed) return { accepted: false, code: 'CHANNEL_MISSING', missing: 'apns_auth_key' };
        response = await postApns({
          authority,
          jwt: refreshed,
          deviceToken: request.token,
          topic: config.bundleId,
          payload: buildApnsPayload(request.payload),
          timeoutMs: L.requestTimeoutMs,
          nowMs: now(),
        });
      }
      return mapApnsResponse(response);
    } catch (error) {
      const errorCode = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code ?? '') : '';
      logger.warn('Companion APNs request failed', { environment: config.environment, errorCode });
      return { accepted: false, code: 'PROVIDER_RETRY' };
    }
  };
}

function readApnsKey(keyPath: string): string | null {
  try {
    const pem = readFileSync(keyPath, 'utf8');
    if (!pem.includes('BEGIN PRIVATE KEY') && !pem.includes('BEGIN EC PRIVATE KEY')) return null;
    return pem;
  } catch {
    return null;
  }
}

function mapApnsResponse(response: ApnsHttpResult): CompanionPushDispatchResult {
  if (response.status === 200) return { accepted: true };
  if (response.status === 410 || (response.status === 400 && response.reason === 'BadDeviceToken')) {
    return { accepted: false, code: 'NOT_REGISTERED' };
  }
  return { accepted: false, code: 'PROVIDER_RETRY', retryAfterMs: response.retryAfterMs };
}

function postApns(input: {
  authority: string;
  jwt: string;
  deviceToken: string;
  topic: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  nowMs: number;
}): Promise<ApnsHttpResult> {
  const body = JSON.stringify(input.payload);
  const path = `${COMPANION_APNS.pathPrefix}${input.deviceToken}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const session = connect(input.authority);
    const finish = (error?: Error, result?: ApnsHttpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) session.destroy();
      else session.close();
      if (error) reject(error);
      else resolve(result as ApnsHttpResult);
    };
    const timer = setTimeout(() => finish(new Error('APNS_TIMEOUT')), input.timeoutMs);
    session.on('error', error => finish(error instanceof Error ? error : new Error('APNS_SESSION')));
    const req = session.request({
      ':method': 'POST',
      ':path': path,
      authorization: `bearer ${input.jwt}`,
      'apns-topic': input.topic,
      'apns-push-type': COMPANION_APNS.pushType,
      'content-type': 'application/json',
    });
    const chunks: Buffer[] = [];
    let headers: IncomingHttpHeaders & IncomingHttpStatusHeader = {};
    req.on('response', next => { headers = next; });
    req.on('data', chunk => { chunks.push(chunk as Buffer); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      finish(undefined, {
        status: Number(headers[':status'] ?? 0),
        reason: readApnsReason(raw),
        retryAfterMs: parseRetryAfter(headers['retry-after'], input.nowMs),
      });
    });
    req.on('error', error => finish(error instanceof Error ? error : new Error('APNS_REQUEST')));
    req.end(body);
  });
}

function readApnsReason(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : '';
  } catch {
    return '';
  }
}

function parseRetryAfter(value: string | string[] | undefined, nowMs: number): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}
