import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';

/**
 * Host 侧 relay 设备票据存取（N-COMPANION-RELAY-DEVICE-TICKET）。账号令牌一小时过期且现取要过
 * supabase（国内 5G / 上海机房到 supabase.co 常慢或不通），票据是 relay 自己签的 30 天凭据：落盘在
 * 数据目录（companion-relay-ticket.json，600、原子写），重启后先读它，supabase 不通也能立刻接上 relay。
 * 票据形态 `neo1.<payload>.<mac>`（形态定义在 packages/relay/src/ticketAuth.ts，Host 只读不签、
 * 各抄一小段）：payload 是明文 JSON（不含秘密，sub/exp 任何人可读），mac 只有 relay 的密钥能算——
 * Host 不验 mac（那是 relay 的事），只读 sub/exp 做本地决策。
 */

const TICKET_PREFIX = 'neo1.';
/** 与 relay 侧 accountAuth/ticketAuth 对 sub 的口径一致。 */
const SUB_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

interface StoredRelayTicket {
  v: 1;
  ticket: string;
  exp: number;
}

/** 只解 payload 读 sub/exp，不验 mac；前缀/分段/形状任一不对返回 null。 */
function parseRelayTicketClaim(ticket: string): { sub: string; exp: number } | null {
  const rest = ticket.startsWith(TICKET_PREFIX) ? ticket.slice(TICKET_PREFIX.length) : '';
  const dot = rest.indexOf('.');
  if (dot <= 0 || rest.indexOf('.', dot + 1) !== -1) return null;
  try {
    const raw = /^[A-Za-z0-9_-]+$/.test(rest.slice(0, dot)) ? Buffer.from(rest.slice(0, dot), 'base64url') : null;
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as { sub?: unknown; exp?: unknown };
    if (typeof record.sub !== 'string' || !SUB_PATTERN.test(record.sub)) return null;
    if (typeof record.exp !== 'number' || !Number.isSafeInteger(record.exp)) return null;
    return { sub: record.sub, exp: record.exp };
  } catch {
    return null;
  }
}

function ticketPath(dataDirectory: string): string {
  return resolve(dataDirectory, L.relayTicketFile);
}

/**
 * 读票据：v 对、未过期、sub 是当前账号、exp 与票据内声明一致才返回原文；其余（无文件/坏文件/
 * 已过期/换了账号登录）一律 null，拨号回落 access token。
 */
export function loadCompanionRelayTicket(dataDirectory: string, expectedSub: string, now: () => number = Date.now): string | null {
  let text: string;
  try {
    text = readFileSync(ticketPath(dataDirectory), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Partial<StoredRelayTicket>
      : null;
    if (!record) return null;
    if (record.v !== 1 || typeof record.ticket !== 'string' || !Number.isSafeInteger(record.exp)) return null;
    if ((record.exp as number) <= now()) return null;
    const claim = parseRelayTicketClaim(record.ticket);
    if (claim?.sub !== expectedSub || claim?.exp !== record.exp) return null;
    return record.ticket;
  } catch {
    return null;
  }
}

/** 收到 relay 下发的 ticket 帧后覆盖落盘（600、原子写）。形状不对（或不是当前账号的票）丢弃并返回 false。 */
export function storeCompanionRelayTicket(dataDirectory: string, ticket: string, expectedSub?: string): boolean {
  const claim = parseRelayTicketClaim(ticket);
  if (!claim || (expectedSub !== undefined && claim.sub !== expectedSub)) return false;
  const path = ticketPath(dataDirectory);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, ticket, exp: claim.exp } satisfies StoredRelayTicket), { mode: 0o600 });
  renameSync(tmp, path);
  return true;
}

/** 作废本地票据：拨号用的票据被 relay 拒时调用（最常见：relay 换了票据密钥），下次拨号回落令牌换新票。 */
export function clearCompanionRelayTicket(dataDirectory: string): void {
  try {
    rmSync(ticketPath(dataDirectory), { force: true });
  } catch {
    // 删不掉（如权限）不致命：load 的过期/账号校验兜底。
  }
}
