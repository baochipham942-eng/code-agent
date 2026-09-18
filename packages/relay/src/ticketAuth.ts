import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';

/**
 * relay 设备票据（N-COMPANION-RELAY-DEVICE-TICKET）：`neo1.<payload>.<mac>`，payload 是
 * base64url(JSON({ sub, exp }))（exp 毫秒时间戳），mac = base64url(HMAC-SHA256(ticketKey,
 * "neo-relay-ticket.v1|" + payload))，比较用 timingSafeEqual。账号令牌只在换票时用一次，日常
 * 连接全靠票据——「能不能跨网」从此不再绑在「此刻连不连得上 supabase.co」上。
 *
 * 票据密钥是 relay 独有、从不下发的随机秘密，绝不能由共享凭据派生：凭据随配对下发给每台手机、
 * 由手机放进 WebSocket 子协议，派生式等于任何配过对的手机都能给任意 sub 签票据、冒充别人账号，
 * 把路由主人隔离整条打穿。删掉密钥文件＝作废全部已签发票据（客户端回落 access token 重新换票）。
 */

const TICKET_PREFIX = 'neo1.';
const TICKET_MAC_DOMAIN = 'neo-relay-ticket.v1';
const KEY_BYTES = 32;
/** 与 accountAuth.verify 对 sub 的口径一致（Supabase 用户 id 的字符集与长度）。 */
const SUB_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface TicketAuthLogger {
  info?: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
}

export interface RelayTicket {
  sub: string;
  /** 过期时刻，毫秒时间戳。 */
  exp: number;
}

function decodeSegment(segment: string): Buffer | null {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? Buffer.from(segment, 'base64url') : null;
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(`${TICKET_MAC_DOMAIN}|${payload}`).digest();
}

export class RelayTicketAuth {
  private readonly key: Buffer;
  private readonly now: () => number;

  constructor(options: { keyFile?: string; now?: () => number; logger?: TicketAuthLogger }) {
    this.now = options.now ?? Date.now;
    if (options.keyFile) {
      this.key = loadOrCreateKey(options.keyFile, options.logger);
    } else {
      // 本机裸跑没有 STATE_DIRECTORY：回落进程内随机密钥，并写清后果——不只是「用了回落」。
      this.key = randomBytes(KEY_BYTES);
      options.logger?.warn('ticket_key_ephemeral', {
        consequence: 'ticket key is not persisted; every issued ticket becomes invalid once this process restarts, and clients must re-authenticate with an access token to get new tickets',
      });
    }
  }

  /** 只读密钥字节：测试用它断言密钥不是从共享凭据派生的；绝不打日志、绝不下发。 */
  get keyBytes(): Buffer {
    return this.key;
  }

  issue(sub: string): { ticket: string; exp: number } {
    const exp = this.now() + L.relayTicketTtlMs;
    const payload = Buffer.from(JSON.stringify({ sub, exp })).toString('base64url');
    return { ticket: `${TICKET_PREFIX}${payload}.${mac(this.key, payload).toString('base64url')}`, exp };
  }

  /** 通过返回 sub/exp；前缀、mac、有效期、payload 形状任一不满足返回 null。同步，不碰网络。 */
  verify(ticket: string): RelayTicket | null {
    if (!ticket.startsWith(TICKET_PREFIX)) return null;
    const rest = ticket.slice(TICKET_PREFIX.length);
    const dot = rest.indexOf('.');
    if (dot <= 0 || rest.indexOf('.', dot + 1) !== -1) return null;
    const payload = rest.slice(0, dot);
    const given = decodeSegment(rest.slice(dot + 1));
    if (!given) return null;
    const expected = mac(this.key, payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const raw = decodeSegment(payload);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const record = parsed as { sub?: unknown; exp?: unknown };
      if (typeof record.sub !== 'string' || !SUB_PATTERN.test(record.sub)) return null;
      if (typeof record.exp !== 'number' || !Number.isSafeInteger(record.exp) || record.exp <= this.now()) return null;
      return { sub: record.sub, exp: record.exp };
    } catch {
      return null;
    }
  }
}

/** 首次启动生成 32 字节随机密钥原子落盘（0600）；已存在且合法就沿用，坏文件重新生成（等于作废全部旧票）。 */
function loadOrCreateKey(keyFile: string, logger?: TicketAuthLogger): Buffer {
  try {
    const text = readFileSync(keyFile, 'utf8').trim();
    const key = Buffer.from(text, 'base64url');
    if (/^[A-Za-z0-9_-]+$/.test(text) && key.length === KEY_BYTES) return key;
    logger?.warn('ticket_key_file_invalid', { keyFile });
  } catch {
    // 首次启动没有密钥文件是常态，往下走生成。
  }
  const key = randomBytes(KEY_BYTES);
  const tmp = `${keyFile}.tmp`;
  writeFileSync(tmp, key.toString('base64url'), { mode: 0o600 });
  renameSync(tmp, keyFile);
  return key;
}
