// ============================================================================
// 统一授权台账（N-PERM-GRANT-LEDGER）
// ============================================================================
// 三个各自记「允许」的后端，在这里折成一张设置页能显示、能按行撤销的清单：
//   ① app_permission_grants 表 + AppGrantStore.sessions（按应用的电脑操作授权）
//   ② automation config_json.standingGrants（(tool,target) 长期授权，SessionAutomationService）
//   ③ ConfirmationGate.sessionApprovals（会话内工具放行）
// 撤销键是 id：`<variant>:<uri-encoded 分段>`——段内冒号已被 encodeURIComponent 转义，
// split(':') 无歧义；拼/拆都只在本文件。已过期条目不列出（各后端的 match 自己也不匹配）。
// 本模块只被设置 IPC 消费，不注册成任何 agent 可调用的工具（no-self-revoke）。

import type { PermissionGrantEntry } from '../../shared/contract';
import {
  listAppGrants,
  listAppSessionGrants,
  revokeAppGrant,
  revokeAppSessionGrant,
} from './appGrantStore';
import { getConfirmationGate } from '../agent/confirmationGate';
import { getSessionAutomationService } from '../services/sessionAutomation/sessionAutomationService';

const ID_VARIANT = {
  appStanding: 'app-standing',
  appSession: 'app-session',
  standingGrant: 'standing-grant',
  toolSession: 'tool-session',
} as const;

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function buildId(variant: string, ...segments: string[]): string {
  return [variant, ...segments.map(encodeSegment)].join(':');
}

/** 拆 id；不认识的前缀或段数不对返回 null（调用方按「没这条」处理）。 */
function parseId(id: string): { variant: string; segments: string[] } | null {
  const parts = id.split(':');
  if (parts.length < 2) return null;
  try {
    return { variant: parts[0], segments: parts.slice(1).map(decodeURIComponent) };
  } catch {
    return null;
  }
}

/**
 * 列出用户已给的每一项「允许」。now 可注入（测试用同一判据；缺省 Date.now()）。
 * source：'settings'（常驻）| 'conversation'（本次对话）| automation 标题。
 */
export function listGrants(now: number = Date.now()): PermissionGrantEntry[] {
  const entries: PermissionGrantEntry[] = [];

  for (const row of listAppGrants(now)) {
    entries.push({
      id: buildId(ID_VARIANT.appStanding, row.appKey),
      kind: 'app',
      label: row.name,
      ...(row.bundleId ? { detail: row.bundleId } : {}),
      source: 'settings',
      grantedAt: row.grantedAt,
      expiresAt: row.expiresAt,
    });
  }

  for (const row of listAppSessionGrants()) {
    entries.push({
      id: buildId(ID_VARIANT.appSession, row.sessionId, row.appKey),
      kind: 'app',
      label: row.name,
      ...(row.bundleId ? { detail: row.bundleId } : {}),
      source: 'conversation',
      grantedAt: row.grantedAt,
      expiresAt: null,
    });
  }

  for (const { automationId, title, grant } of getSessionAutomationService().listStandingGrantEntries(now)) {
    entries.push({
      id: buildId(ID_VARIANT.standingGrant, automationId, grant.tool, grant.target),
      kind: 'tool-target',
      label: grant.tool,
      detail: grant.target,
      source: title,
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt ?? null,
    });
  }

  for (const { sessionId, tool, grantedAt } of getConfirmationGate().listSessionApprovals()) {
    entries.push({
      id: buildId(ID_VARIANT.toolSession, sessionId, tool),
      kind: 'tool-session',
      label: tool,
      source: 'conversation',
      grantedAt,
      expiresAt: null,
    });
  }

  return entries;
}

/**
 * 按 id 撤销一条授权，分发到对应后端；下一次同类检查按「从未授权」处理。
 * 返回是否真的撤掉了（id 不认识 / 后端里已没有这条 → false）。
 */
export function revokeGrant(id: string): boolean {
  const parsed = parseId(id);
  if (!parsed) return false;
  const { variant, segments } = parsed;
  switch (variant) {
    case ID_VARIANT.appStanding:
      return segments.length === 1 && revokeAppGrant(segments[0]);
    case ID_VARIANT.appSession:
      return segments.length === 2 && revokeAppSessionGrant(segments[0], segments[1]);
    case ID_VARIANT.standingGrant:
      return segments.length === 3
        && getSessionAutomationService().revokeStandingGrant(segments[0], segments[1], segments[2]);
    case ID_VARIANT.toolSession:
      return segments.length === 2 && getConfirmationGate().revokeSessionApproval(segments[0], segments[1]);
    default:
      return false;
  }
}
