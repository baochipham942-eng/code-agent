// ============================================================================
// Role Context Bindings — 专家 L1 默认资料架（Batch 3 E3）
// ============================================================================
//
// 每个持久化角色一份 roles/<roleId>/bindings.json，随角色资产归用户所有。
// 注入原则（E1 备料 context-bindings.md）：
//   - always：索引常驻（标题/路径/摘要一行级），正文按需 Read
//   - on_demand：仅列出（模型知道去哪取），用到再读
//   - scope=private 默认不进其他专家（隔离天然：按 roleId 取文件）
// ponytail: scope=project 的跨专家共读本批只存字段不接线，后续批次（E4/E5）拍板后再做

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ROLE_ASSETS } from '../../../shared/constants';
import type {
  ExpertBindingKind,
  ExpertBindingMode,
  ExpertBindingScope,
  ExpertContextBinding,
} from '../../../shared/contract/roleAssets';
import { getLibraryService } from '../library/libraryService';
import { createLogger } from '../infra/logger';
import { getRoleDir, isSafeRoleId } from './roleAssetPaths';

const logger = createLogger('RoleContextBindings');

const BINDING_KINDS: ReadonlySet<ExpertBindingKind> = new Set(['file', 'folder', 'library_item']);
const BINDING_MODES: ReadonlySet<ExpertBindingMode> = new Set(['always', 'on_demand']);
const BINDING_SCOPES: ReadonlySet<ExpertBindingScope> = new Set(['private', 'project']);

export function getRoleBindingsPath(roleId: string): string {
  return path.join(getRoleDir(roleId), ROLE_ASSETS.BINDINGS_FILENAME);
}

function isValidBinding(value: unknown): value is ExpertContextBinding {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.id === 'string' && b.id.length > 0
    && BINDING_KINDS.has(b.kind as ExpertBindingKind)
    && typeof b.target === 'string' && b.target.length > 0
    && BINDING_MODES.has(b.mode as ExpertBindingMode)
    && BINDING_SCOPES.has(b.scope as ExpertBindingScope)
    && typeof b.createdAt === 'number'
    && (b.title === undefined || typeof b.title === 'string')
  );
}

/** 读取角色资料架；文件缺失/损坏 → 空数组（空资料架也能工作），非法条目剔除并告警 */
export async function readRoleBindings(roleId: string): Promise<ExpertContextBinding[]> {
  if (!isSafeRoleId(roleId)) return [];
  try {
    const raw = await fs.readFile(getRoleBindingsPath(roleId), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isValidBinding);
    if (valid.length !== parsed.length) {
      logger.warn('Dropped invalid role bindings entries', { roleId, dropped: parsed.length - valid.length });
    }
    return valid;
  } catch {
    return [];
  }
}

async function writeRoleBindings(roleId: string, bindings: ExpertContextBinding[]): Promise<void> {
  if (!isSafeRoleId(roleId)) {
    throw new Error(`Invalid role id: "${roleId}"`);
  }
  const target = getRoleBindingsPath(roleId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // 先写临时文件再 rename，防写一半崩溃留下损坏 JSON
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(bindings, null, 2), 'utf-8');
  await fs.rename(tmp, target);
}

export interface AddRoleBindingArgs {
  kind: ExpertBindingKind;
  target: string;
  title?: string;
  mode: ExpertBindingMode;
  scope: ExpertBindingScope;
}

/** 追加绑定（同 kind+target 幂等去重，返回现有条目）；library_item 校验条目存在并回填标题 */
export async function addRoleBinding(
  roleId: string,
  args: AddRoleBindingArgs,
  now: number = Date.now(),
): Promise<ExpertContextBinding> {
  if (!BINDING_KINDS.has(args.kind) || !BINDING_MODES.has(args.mode) || !BINDING_SCOPES.has(args.scope)) {
    throw new Error('Invalid binding kind/mode/scope');
  }
  const target = args.target.trim();
  if (!target) throw new Error('Binding target is required');

  let kind = args.kind;
  let title = args.title?.trim() || undefined;
  if (kind === 'library_item') {
    const item = getLibraryService().get(target);
    if (!item) throw new Error(`Library item not found: ${target}`);
    title = title ?? item.title;
  } else {
    // 路径类：存在性校验 + 以真实盘上形态定 file/folder（不信 renderer 的猜测）
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw new Error(`Path not found: ${target}`);
    kind = stat.isDirectory() ? 'folder' : 'file';
    title = title ?? path.basename(target);
  }

  const bindings = await readRoleBindings(roleId);
  const existing = bindings.find((b) => b.kind === kind && b.target === target);
  if (existing) return existing;

  const binding: ExpertContextBinding = {
    id: `bind_${now}_${crypto.randomUUID().split('-')[0]}`,
    kind,
    target,
    title,
    mode: args.mode,
    scope: args.scope,
    createdAt: now,
  };
  await writeRoleBindings(roleId, [...bindings, binding]);
  return binding;
}

/** 删除绑定；不存在时静默幂等 */
export async function removeRoleBinding(roleId: string, bindingId: string): Promise<void> {
  const bindings = await readRoleBindings(roleId);
  const next = bindings.filter((b) => b.id !== bindingId);
  if (next.length === bindings.length) return;
  await writeRoleBindings(roleId, next);
}

// ----------------------------------------------------------------------------
// 注入块（buildRoleContextBlock 的资料架 section）
// ----------------------------------------------------------------------------

function describeBinding(binding: ExpertContextBinding): string | null {
  if (binding.kind === 'library_item') {
    let item;
    try {
      item = getLibraryService().get(binding.target);
    } catch {
      item = undefined;
    }
    if (!item) return null; // 库条目已删：不注入失效引用
    const parts = [`- ${item.title}（资料库条目）: ${item.pathOrUri}`];
    if (binding.mode === 'always' && item.summary) parts.push(`  摘要: ${item.summary}`);
    return parts.join('\n');
  }
  const label = binding.kind === 'folder' ? '目录' : '文件';
  return `- ${binding.title ?? path.basename(binding.target)}（${label}）: ${binding.target}`;
}

/**
 * 构建"你的资料架"注入 section；无绑定返回 null（空资料架照常工作）。
 * 只注索引/路径，正文按需 Read——与 library pins（L3）同一原则。
 */
export async function buildRoleBindingsSection(roleId: string): Promise<string | null> {
  const bindings = await readRoleBindings(roleId);
  if (bindings.length === 0) return null;

  const always = bindings.filter((b) => b.mode === 'always').map(describeBinding).filter(Boolean);
  const onDemand = bindings.filter((b) => b.mode === 'on_demand').map(describeBinding).filter(Boolean);
  if (always.length === 0 && onDemand.length === 0) return null;

  const lines: string[] = ['## 你的资料架（仅索引，正文未注入）'];
  if (always.length > 0) {
    lines.push('常驻资料（与任务相关时优先读取）：', ...(always as string[]));
  }
  if (onDemand.length > 0) {
    lines.push('按需资料（用到时再读，引用须标注来源）：', ...(onDemand as string[]));
  }
  lines.push('读取方式：本地路径用 Read 工具（目录先 ListDirectory / Glob），URL 用网页抓取工具。');
  return lines.join('\n');
}
