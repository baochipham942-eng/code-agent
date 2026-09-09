import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import type { Message, ToolCall, ToolResult } from '../../../shared/contract';
import { getUserConfigDir } from '../../config/configPaths';
import { readbackFileEvidence } from './fileEvidenceReadback';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('DocumentEvidenceBoundary');
const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.html', '.csv']);
interface DocumentOrigin {
  path: string;
  digest: string;
  kind: 'derived' | 'unclassified';
  roots: string[];
}

function documentPath(call: ToolCall, cwd: string): string | undefined {
  const raw = call.arguments.file_path ?? call.arguments.path;
  return typeof raw === 'string' && DOCUMENT_EXTENSIONS.has(extname(raw).toLowerCase())
    ? resolve(cwd, raw) : undefined;
}

function currentMessages(messages: readonly Message[]): readonly Message[] {
  const index = messages.findLastIndex((message) => message.role === 'user');
  return messages.slice(Math.max(0, index));
}

function isOrigin(value: unknown): value is DocumentOrigin {
  if (!value || typeof value !== 'object') return false;
  const origin = value as Partial<DocumentOrigin>;
  return typeof origin.path === 'string' && typeof origin.digest === 'string'
    && (origin.kind === 'derived' || origin.kind === 'unclassified')
    && Array.isArray(origin.roots) && origin.roots.every((root) => typeof root === 'string');
}

/** Digest-bound ancestry survives a later session reading generated minutes. */
export async function attachDocumentOrigin(
  call: ToolCall, result: ToolResult, messages: readonly Message[], cwd: string,
  ledgerPath = resolve(getUserConfigDir(), 'document-origins.jsonl'),
): Promise<ToolResult> {
  const target = documentPath(call, cwd);
  const read = /^(Read|read_file)$/i.test(call.name);
  const mutation = /^(Write|write_file|Edit|edit_file|MultiEdit)$/i.test(call.name);
  if (!result.success || !target || (!read && !mutation)) return result;
  try {
    const { evidence } = readbackFileEvidence(target, cwd, 'document_origin');
    const canonical = evidence.ref;
    const digest = evidence.freshness.digest;
    if (!digest) throw new Error('DOCUMENT_ORIGIN_DIGEST_MISSING');
    let origin: DocumentOrigin = { path: canonical, digest, kind: 'unclassified', roots: [canonical] };
    let ledger = '';
    try { ledger = await readFile(ledgerPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const line of ledger.split('\n')) {
      if (!line) continue;
      try {
        const prior: unknown = JSON.parse(line);
        if (isOrigin(prior) && prior.path === canonical && prior.digest === digest) origin = prior;
      } catch { /* A torn last append cannot establish ancestry. */ }
    }
    if (mutation) {
      const sources = currentMessages(messages).flatMap((message) => message.toolResults ?? [])
        .filter((source) => source.success)
        .map((source) => source.metadata?.documentOrigin).filter(isOrigin);
      origin = { path: canonical, digest, kind: 'derived',
        roots: [...new Set(sources.flatMap((source) => source.roots))] };
      await mkdir(dirname(ledgerPath), { recursive: true });
      await appendFile(ledgerPath, `${JSON.stringify(origin)}\n`, 'utf8');
    }
    return { ...result, metadata: { ...result.metadata, documentOrigin: origin },
      output: read ? `${result.output ?? ''}\n\n<document-evidence>${JSON.stringify(origin)}; local file content, source independence unverified</document-evidence>` : result.output };
  } catch (error) {
    logger.warn('Document origin unavailable', { error: String(error) });
    return { ...result, metadata: { ...result.metadata, documentOriginUnavailable: true } };
  }
}

/** Check each assertion, so an unrelated caveat cannot license another row's claim. */
export function checkDocumentEvidenceClaims(content: string, messages: readonly Message[]): string[] {
  const problems = new Set<string>();
  const active = currentMessages(messages);
  const calls = new Map(active.flatMap((message) => message.toolCalls ?? []).map((call) => [call.id, call]));
  const spaceQueries = active.flatMap((message) => message.toolResults ?? []).flatMap((result) => {
    const call = calls.get(result.toolCallId);
    if (!result.success || call?.name !== 'space_query' || typeof call.arguments.projectId !== 'string') return [];
    try {
      const value = JSON.parse(result.output ?? '') as { space?: { id?: string; cloudProjectId?: string }; capabilities?: { experts?: Array<{ id: string; displayName: string }>; automations?: unknown[] }; cloudMembers?: Array<{ projectId: string; role: string; userId: string; displayName?: string }> };
      return value.space?.id === call.arguments.projectId && content.includes(call.arguments.projectId) ? [value] : [];
    } catch { return []; }
  });
  const spaceContext = /空间|space\b/i.test(content)
    || active.some((message) => message.role === 'user' && /空间|space\b/i.test(message.content));
  for (const line of content.split(/\n|[。；;]/)) {
    const qualified = /待[查补核]|未[核验知经]|尚未|无法确认|不能[证明认定]|仅[为能指]|推断|不代表|unverified|unknown|cannot (?:confirm|establish)|not independent/i.test(line);
    const independent = /(?:相互|互相|彼此)?独立(?:的)?(?:来源|证据|记载)|independent (?:sources|evidence|records)/i.test(line);
    const sameOriginUpgrade = /(?:✅|明确证据|互证|已验证)/.test(line) && /同源|双记录|纪要.*逐字稿|逐字稿.*纪要/.test(line);
    if (!qualified && (independent || sameOriginUpgrade)) problems.add('SOURCE_INDEPENDENCE_UNVERIFIED');
    if (!spaceContext || qualified) continue;
    const owner = /空间主人|空间.*owner|空间.*所有者|登录用户.*owner|space owner/i.test(line);
    const members = /(?:agents\/|本地|名册).*(?:专家|成员)|(?:专家|成员).*(?:agents\/|本地|名册)/i.test(line);
    const automations = /(?:当前|没有|为零|0|实测|已核验|registered:).*定时|定时.*(?:当前|没有|为零|实测|已核验|registered:)|(?:no|zero|current).*automations/i.test(line);
    if (owner && !spaceQueries.some((query) => query.cloudMembers?.some((member) => member.role === 'owner' && member.projectId === (query.space?.cloudProjectId ?? query.space?.id) && (line.includes(member.userId) || Boolean(member.displayName && line.includes(member.displayName)))))) problems.add('SPACE_OWNER_UNVERIFIED');
    if (members && !spaceQueries.some((query) => query.capabilities?.experts?.some((expert) => line.includes(expert.id) || line.includes(expert.displayName)))) problems.add('SPACE_MEMBERS_UNVERIFIED');
    if (automations && !spaceQueries.some((query) => Array.isArray(query.capabilities?.automations) && query.capabilities.automations.length === 0 && /没有|为零|\b0\b|no|zero/i.test(line))) problems.add('SPACE_AUTOMATIONS_UNVERIFIED');
  }
  return [...problems];
}

export function documentClaimPreflight(call: ToolCall, messages: readonly Message[]): string[] {
  if (!/^(Write|write_file|Edit|edit_file|MultiEdit)$/i.test(call.name)) return [];
  const raw = call.arguments.file_path ?? call.arguments.path;
  if (typeof raw !== 'string' || !DOCUMENT_EXTENSIONS.has(extname(raw).toLowerCase())) return [];
  const args = call.arguments;
  const edits = Array.isArray(args.edits) ? args.edits as Array<Record<string, unknown>> : [];
  const text = [args.content, args.new_string, args.new_text, ...edits.map((edit) => edit.new_string ?? edit.new_text)]
    .filter((value): value is string => typeof value === 'string').join('\n');
  return checkDocumentEvidenceClaims(text, messages);
}

/** A bounded final answer lists the unsupported fields instead of publishing their claims. */
export function formatDocumentEvidenceBoundary(problems: readonly string[]): string {
  const descriptions: Record<string, string> = {
    SOURCE_INDEPENDENCE_UNVERIFIED: '来源独立性未核实：纪要、摘要和同源转载不能增加独立来源数量。',
    SPACE_OWNER_UNVERIFIED: '空间归属待查：登录身份不能证明空间所有者。',
    SPACE_MEMBERS_UNVERIFIED: '空间成员与专家待查：本机名册不能证明已绑定到目标空间。',
    SPACE_AUTOMATIONS_UNVERIFIED: '空间自动化待查：启动日志不能证明当前空间配置。',
  };
  return ['现有证据不足以确认以下结论：', '', ...problems.map((code) => `- ${descriptions[code] ?? code}`)].join('\n');
}
