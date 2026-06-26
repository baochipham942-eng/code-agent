// ============================================================================
// DistillProposalGenerator — Phase 5 结构化提案生成（LLM 唯一出场点）
// ============================================================================
// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) — distill.txt 的
// Phase 4/5 提案语义（smallest form / 不造投机资产 / 引用证据）。
//
// 边界（对抗审计裁决）：LLM 只产 {candidateId, form, name, description, body}
// 的结构化输出；不持有任何工具、不控制任何路径。解析失败/越界字段在这里粗筛，
// runDistill 的 validateProposal 是落盘前的最后一道代码门（双层防御）。
// 调用通道复用 quickTask（conversationReview 同款 service 层 LLM 先例）。
// ============================================================================

import { DISTILL, SKILL_REVIEW } from '../../../shared/constants';
import { quickTask } from '../../model/quickModel';
import { withTimeout } from '../infra/timeoutController';
import { createLogger } from '../infra/logger';
import { DISTILL_AGENT_PROMPT } from '../../agent/distillPrompt';
import type {
  DistillProposal,
  DistillProposalGenerator,
  DistillVerifiedCandidate,
} from './distillService';

const logger = createLogger('DistillProposalGenerator');

const PROPOSAL_MAX_TOKENS = 2048;

export function buildDistillProposalPrompt(
  candidates: DistillVerifiedCandidate[],
  context: Parameters<DistillProposalGenerator>[1],
): string {
  const candidateBlocks = candidates
    .map((candidate) => {
      const evidence = candidate.evidence
        .map((item) => `  - [${item.sessionId}/${item.messageId}] ${item.snippet}`)
        .join('\n');
      return [
        `- candidateId: ${candidate.candidateId}`,
        `  workflow: ${candidate.signal.title}`,
        `  detail: ${candidate.signal.content}`,
        `  frequency=${candidate.frequency} sessions=${candidate.sessionBreadth} score=${candidate.score.toFixed(2)}`,
        `  evidence:`,
        evidence,
      ].join('\n');
    })
    .join('\n');

  const existingNames = [
    ...context.inventory.commands.map((c) => c.name),
    ...context.inventory.skills.map((s) => s.name),
    ...context.inventory.agents,
  ].join(', ');

  return [
    DISTILL_AGENT_PROMPT,
    '',
    '## 已通过频率硬门的入围候选（只能从这里选）',
    candidateBlocks,
    '',
    `## 现有资产名（产出禁止与其重名）`,
    existingNames || '(none)',
    '',
    '## 输出要求',
    '只输出一个 JSON 数组（可用 ```json 围栏），每个元素：',
    '{ "candidateId": "<入围候选的 candidateId>", "form": "command" | "skill" | "subagent-recommendation",',
    '  "name": "<小写字母/数字/连字符>", "description": "<一行可发现性描述>", "body": "<模板或 SKILL 正文>" }',
    '约束：candidateId 必须来自入围清单；不值得固化的候选直接不输出（零提案是合法结果）；',
    `body ≤ ${DISTILL.BODY_MAX_LENGTH} 字符；command 模板优先用 $1/$ARGUMENTS 占位符。`,
  ].join('\n');
}

/** 从 LLM 输出中提取并粗筛提案数组（细校验在 runDistill.validateProposal） */
export function parseDistillProposals(content: string): DistillProposal[] {
  const text = (content || '').trim();
  if (!text) return [];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const jsonCandidate = fenced ? fenced[1].trim() : text;
  const arrayStart = jsonCandidate.indexOf('[');
  const arrayEnd = jsonCandidate.lastIndexOf(']');
  if (arrayStart < 0 || arrayEnd <= arrayStart) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate.slice(arrayStart, arrayEnd + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const proposals: DistillProposal[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const required = ['candidateId', 'form', 'name', 'description'];
    if (!required.every((key) => typeof record[key] === 'string')) continue;
    const body = typeof record.body === 'string' ? record.body : '';
    if (!body && record.form !== 'subagent-recommendation') continue;
    proposals.push({
      candidateId: record.candidateId as string,
      form: record.form as DistillProposal['form'],
      name: record.name as string,
      description: record.description as string,
      body,
    });
  }
  return proposals;
}

/**
 * 生产 ProposalGenerator：单次结构化 LLM 调用。
 * 失败语义：模型不可用/超时/解析失败 → 空提案（本轮零产出），不抛错。
 */
export const llmDistillProposalGenerator: DistillProposalGenerator = async (candidates, context) => {
  if (candidates.length === 0) return [];
  try {
    const prompt = buildDistillProposalPrompt(candidates, context);
    const result = await withTimeout(
      quickTask(prompt, PROPOSAL_MAX_TOKENS),
      SKILL_REVIEW.TIMEOUT_MS,
      'Distill proposal generation timed out',
    );
    if (!result.success || !result.content) {
      logger.warn('Quick model unavailable for distill proposals', { error: result.error });
      return [];
    }
    const proposals = parseDistillProposals(result.content);
    logger.info('Distill proposals generated', { candidates: candidates.length, proposals: proposals.length });
    return proposals;
  } catch (error) {
    logger.warn('Distill proposal generation failed; zero proposals this run', { error: String(error) });
    return [];
  }
};
