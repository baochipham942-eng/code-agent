// ============================================================================
// 候选能力 · agent 的读取路径（N-CAP1 / F12「人与 agent 共用同一张表」）
// ============================================================================
// 每个会话**只注入一次**（首轮），之后靠对话历史带着走——候选表是慢变量，
// 没必要每轮重复付这份 token；这是刻意选的形状，不是省事。
//
// 注入内容只讲事实（这事你已经拼过几次），并明确写死「只在用户问起或自然相关时提」。
// 本单是零打断期：这条注入不许被写成让模型去推销固化的指令。

import { CAPABILITY_CANDIDATES } from '../../shared/constants';
import { listCandidates } from '../services/skills/capabilityGapDetector';
import { fallbackName } from '../services/skills/capabilityCandidateNaming';

const noticedSessions = new Set<string>();

export function buildCapabilityCandidateNotice(sessionId?: string | null): string | null {
  if (!sessionId || noticedSessions.has(sessionId)) return null;

  let top: ReturnType<typeof listCandidates>;
  try {
    top = listCandidates(Date.now())
      .filter((candidate) => candidate.aboveFold)
      .slice(0, CAPABILITY_CANDIDATES.AGENT_NOTICE_MAX_ENTRIES);
  } catch {
    // 账本读不出来就当没有——注入是锦上添花，绝不能拖垮一轮对话
    return null;
  }
  // 没有够格的候选就一个字都不注入——空标签也是要付 token 的
  if (top.length === 0) return null;

  noticedSessions.add(sessionId);
  return [
    '<repeated_workarounds>',
    '以下是你在过去的会话里反复用现成工具拼凑完成的事情（次数为真实统计）：',
    ...top.map((candidate) => {
      const name = candidate.displayName || fallbackName(candidate);
      return `- ${name}：已拼凑 ${candidate.occurrences} 次，平均 ${Math.round(candidate.avgSteps)} 步。`;
    }),
    '用户如果问起「你还能加什么能力」「这事是不是老做」，可以据此如实回答。',
    '除此之外不要主动提起，更不要建议用户去做成新能力——本期不接受推销。',
    '</repeated_workarounds>',
  ].join('\n');
}
