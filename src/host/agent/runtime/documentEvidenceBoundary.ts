import { extractDocumentAssertions, type DocumentAssertion } from './documentEvidenceAssertions';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import type { Message, ToolCall, ToolResult } from '../../../shared/contract';
import { getUserConfigDir } from '../../config/configPaths';
import { readbackFileEvidence } from './fileEvidenceReadback';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('DocumentEvidenceBoundary');
const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.html', '.csv']);
// 「空间」当作用域信号本身没问题——用户说「整理这个空间的盘点」时，报告里的
// 「成员 / 专家 / 自动化」确实就是空间断言。问题在于中文里一大票复合词跟 Neo 空间无关：
// 磁盘空间、内存空间、向量空间、命名空间、地址空间、空间复杂度…先把这些整体剔掉，
// 再看还剩不剩下一个"裸"的空间。英文 space 歧义更大（the space between fields），
// 所以英文侧只认 workspace 或与字段名相邻的写法。
const NON_NEO_SPACE = /(?:磁盘|硬盘|内存|显存|存储|缓存|向量|矩阵|命名|地址|栈|堆|色彩|颜色|留白|空白|物理|虚拟|线性|样本|特征|状态|搜索|参数|解|用户|内核|二维|三维|欧氏|希尔伯特)空间|空间复杂度|空间换时间/g;
const NEO_SPACE_EN = /\b(?:work)?spaces?\s+(?:owner|members?|experts?|automations?)\b|\b(?:owner|members?|experts?|automations?)\s+of\s+(?:the\s+)?(?:work)?space\b/i;

function mentionsNeoSpace(text: string): boolean {
  return /空间/.test(text.replace(NON_NEO_SPACE, '')) || NEO_SPACE_EN.test(text);
}
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

interface ClaimProblem extends DocumentAssertion { code: string; }

function documentClaimProblems(content: string, messages: readonly Message[]): ClaimProblem[] {
  const problems: ClaimProblem[] = [];
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
  // 作用域信号不能是「正文或用户消息里出现过『空间/space』」——「空间」在中文里太常见
  // （磁盘空间 / 内存空间 / 向量空间 / 命名空间 / 空间复杂度…），英文 space 更甚。实测：
  // 用户问「看看这个向量空间的结构体」，助手答「该结构体的成员按 4 字节对齐，专家建议
  // 保持这个布局。」——整句被替换成两条「空间成员与专家待查」，正文一个字都没剩下，
  // 同一会话里写含「成员」的 .md 也会被 Write/Edit 前置检查拦掉。
  //
  // 作用域信号仍然是「正文或用户消息在谈空间」（用户说「整理这个空间的盘点」时，报告里的
  // 裸『成员/专家/自动化』确实就是空间断言，这一点原设计没错），但先用 mentionsNeoSpace
  // 把与 Neo 空间无关的复合词剔掉；会话里出现过 space_query 也直接算在场。
  const spaceContext = [...calls.values()].some((call) => call.name === 'space_query')
    || mentionsNeoSpace(content)
    || active.some((message) => message.role === 'user' && mentionsNeoSpace(message.content));
  for (const assertion of extractDocumentAssertions(content, spaceContext)) {
    if (assertion.mode !== 'asserted') continue;
    const line = assertion.text;
    const add = (code: string) => problems.push({ ...assertion, code });
    if (assertion.field === 'source') add('SOURCE_INDEPENDENCE_UNVERIFIED');
    if (assertion.field === 'owner' && !spaceQueries.some((query) => query.cloudMembers?.some((member) => member.role === 'owner' && member.projectId === (query.space?.cloudProjectId ?? query.space?.id) && (line.includes(member.userId) || Boolean(member.displayName && line.includes(member.displayName)))))) add('SPACE_OWNER_UNVERIFIED');
    if (assertion.field === 'members' && !spaceQueries.some((query) => query.capabilities?.experts?.some((expert) => line.includes(expert.id) || line.includes(expert.displayName)))) add('SPACE_MEMBERS_UNVERIFIED');
    if (assertion.field === 'automations' && !spaceQueries.some((query) => Array.isArray(query.capabilities?.automations) && query.capabilities.automations.length === 0 && /没有|为零|\b0\b|no|zero/i.test(line))) add('SPACE_AUTOMATIONS_UNVERIFIED');
  }
  return problems;
}

export function checkDocumentEvidenceClaims(content: string, messages: readonly Message[]): string[] {
  return [...new Set(documentClaimProblems(content, messages).map((problem) => problem.code))];
}

/** Replace only the unsupported assertion span; preserve unrelated prose and punctuation verbatim. */
export function boundDocumentEvidenceClaims(content: string, messages: readonly Message[]): { content: string; problems: string[] } {
  const findings = documentClaimProblems(content, messages);
  const spans = new Map<string, ClaimProblem>();
  for (const finding of findings) spans.set(`${finding.start}:${finding.end}`, finding);
  let bounded = content;
  for (const finding of [...spans.values()].sort((a, b) => b.start - a.start)) {
    bounded = bounded.slice(0, finding.start) + formatDocumentEvidenceBoundary([finding.code]) + bounded.slice(finding.end);
  }
  return { content: bounded, problems: [...new Set(findings.map((finding) => finding.code))] };
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
function formatDocumentEvidenceBoundary(problems: readonly string[]): string {
  const descriptions: Record<string, string> = {
    SOURCE_INDEPENDENCE_UNVERIFIED: '来源独立性未核实：纪要、摘要和同源转载不能增加独立来源数量。',
    SPACE_OWNER_UNVERIFIED: '空间归属待查：登录身份不能证明空间所有者。',
    SPACE_MEMBERS_UNVERIFIED: '空间成员与专家待查：本机名册不能证明已绑定到目标空间。',
    SPACE_AUTOMATIONS_UNVERIFIED: '空间自动化待查：启动日志不能证明当前空间配置。',
  };
  return problems.map((code) => `[${descriptions[code] ?? code}]`).join(' ');
}
