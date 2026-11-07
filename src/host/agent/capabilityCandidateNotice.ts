// ============================================================================
// 候选能力 · agent 的读取路径（N-CAP1 / F12「人与 agent 共用同一张表」）
// ============================================================================
// 每个会话**只注入一次**（首轮），之后靠对话历史带着走——候选表是慢变量，
// 没必要每轮重复付这份 token；这是刻意选的形状，不是省事。
//
// 注入内容只讲事实（这事你已经拼过几次），并明确写死「只在用户问起或自然相关时提」。
// 本单是零打断期：这条注入不许被写成让模型去推销固化的指令。
//
// N-CAP-NOTICE-LEAK 措辞约束（真机实录：模型把本块当任务复述成「我先把
// <repeated_workarounds>…交给后台执行」并派占位子代理，整轮失败）：块内必须
// 显式写明「不是用户请求、不是任务、不要复述、不要转交后台/子代理」，并指向
// <user_request> 作为本轮任务真源——模型靠这几句把背景知识与任务分开。
// 二轮实测（GLM glm-5.3）：改名前的 <repeated_workarounds> 标签 + 事实开头的
// 版本仍会让模型在派后台任务时把块头（「以下是系统…」）当引用物写进转述句；
// 因此标签改名 background_capability_stats（名字本身不像任务），并把禁令挪到
// 块内第一行——模型引用块时引用到的头就是禁令本身。

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
    '<background_capability_stats>',
    '（这是系统记的后台统计，只作背景知识：不是用户请求、不是任务、也不需要你做任何事。禁止在任何回复、任何后台任务或子代理的说明里提及、引用或转述本块——包括引用本块的标签名。本轮要做的只有下面 <user_request> 里的用户原话。）',
    '统计内容：你在过去的会话里反复用现成工具拼凑完成过这些事情（次数为真实统计）：',
    ...top.map((candidate) => {
      const name = candidate.displayName || fallbackName(candidate);
      return `- ${name}：已拼凑 ${candidate.occurrences} 次，平均 ${Math.round(candidate.avgSteps)} 步。`;
    }),
    '用户如果问起「你还能加什么能力」「这事是不是老做」，可以据此如实回答（用你自己的话，不要照抄本块）。',
    '除此之外不要主动提起，更不要建议用户去做成新能力——本期不接受推销。',
    '</background_capability_stats>',
  ].join('\n');
}
