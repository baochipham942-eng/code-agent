// ============================================================================
// Code Grader - 代码级评测（不依赖 LLM）
// ============================================================================

import { FORBIDDEN_COMMANDS } from './evaluationPrompts';
import type { SessionSnapshot, TranscriptMetrics } from './types';

/**
 * 分析 Transcript — 代码 Grader（不依赖 LLM）
 */
export function analyzeTranscript(snapshot: SessionSnapshot): TranscriptMetrics {
  const selfRepair = detectSelfRepair(snapshot);
  const verificationQuality = detectVerification(snapshot);
  const forbiddenPatterns = detectForbiddenPatterns(snapshot);
  const errorTaxonomy = classifyErrors(snapshot);

  return { selfRepair, verificationQuality, forbiddenPatterns, errorTaxonomy };
}

/**
 * 检测 self-repair: 工具失败后是否修改参数重试 → 成功
 */
export function detectSelfRepair(snapshot: SessionSnapshot): TranscriptMetrics['selfRepair'] {
  const chains: TranscriptMetrics['selfRepair']['chains'] = [];
  let attempts = 0;
  let successes = 0;

  // 优先使用 turns 级数据
  if (snapshot.turns.length > 0) {
    for (const turn of snapshot.turns) {
      const tcs = turn.toolCalls;
      for (let i = 0; i < tcs.length; i++) {
        if (tcs[i].success) continue;
        const failedTool = tcs[i].name;
        // 查找后续同名工具调用
        for (let j = i + 1; j < tcs.length; j++) {
          if (tcs[j].name === failedTool) {
            attempts++;
            const succeeded = tcs[j].success;
            if (succeeded) successes++;
            chains.push({
              toolName: failedTool,
              failIndex: i,
              retryIndex: j,
              succeeded,
            });
            break;
          }
        }
      }
    }
  } else {
    // Fallback: 扁平 toolCalls
    const tcs = snapshot.toolCalls;
    for (let i = 0; i < tcs.length; i++) {
      if (tcs[i].success) continue;
      const failedTool = tcs[i].name;
      for (let j = i + 1; j < Math.min(i + 5, tcs.length); j++) {
        if (tcs[j].name === failedTool) {
          attempts++;
          const succeeded = tcs[j].success;
          if (succeeded) successes++;
          chains.push({
            toolName: failedTool,
            failIndex: i,
            retryIndex: j,
            succeeded,
          });
          break;
        }
      }
    }
  }

  return {
    attempts,
    successes,
    rate: attempts > 0 ? Math.round((successes / attempts) * 100) : 100,
    chains,
  };
}

/**
 * 检测验证行为: edit_file 后是否 read_file/bash 验证
 */
export function detectVerification(snapshot: SessionSnapshot): TranscriptMetrics['verificationQuality'] {
  const editTools = ['edit_file', 'write_file'];
  const verifyTools = ['read_file', 'bash', 'grep'];
  let editCount = 0;
  let verifiedCount = 0;

  const allToolCalls = snapshot.turns.length > 0
    ? snapshot.turns.flatMap(t => t.toolCalls)
    : snapshot.toolCalls;

  for (let i = 0; i < allToolCalls.length; i++) {
    if (!editTools.includes(allToolCalls[i].name)) continue;
    editCount++;

    // 检查后续 3 个工具调用中是否有验证操作
    for (let j = i + 1; j < Math.min(i + 4, allToolCalls.length); j++) {
      if (verifyTools.includes(allToolCalls[j].name)) {
        verifiedCount++;
        break;
      }
    }
  }

  return {
    editCount,
    verifiedCount,
    rate: editCount > 0 ? Math.round((verifiedCount / editCount) * 100) : 100,
  };
}

/**
 * 检测禁止模式
 */
export function detectForbiddenPatterns(snapshot: SessionSnapshot): TranscriptMetrics['forbiddenPatterns'] {
  const detected: string[] = [];

  const allToolCalls = snapshot.turns.length > 0
    ? snapshot.turns.flatMap(t => t.toolCalls)
    : snapshot.toolCalls;

  for (const tc of allToolCalls) {
    if (tc.name !== 'bash') continue;
    const argsStr = JSON.stringify(tc.args).toLowerCase();
    for (const pattern of FORBIDDEN_COMMANDS) {
      if (argsStr.includes(pattern.toLowerCase())) {
        detected.push(pattern);
      }
    }
  }

  return { detected: [...new Set(detected)], count: detected.length };
}

/**
 * 错误分类
 */
export function classifyErrors(snapshot: SessionSnapshot): Record<string, number> {
  const taxonomy: Record<string, number> = {};

  const allToolCalls = snapshot.turns.length > 0
    ? snapshot.turns.flatMap(t => t.toolCalls)
    : snapshot.toolCalls;

  for (const tc of allToolCalls) {
    if (tc.success) continue;
    const result = (tc.result || '').toLowerCase();
    let category = 'other';
    if (result.includes('not found') || result.includes('no such file')) category = 'file_not_found';
    else if (result.includes('permission')) category = 'permission_denied';
    else if (result.includes('timeout')) category = 'timeout';
    else if (result.includes('unique') || result.includes('not unique')) category = 'edit_not_unique';
    else if (tc.name === 'edit_file' || tc.name === 'Edit') category = 'edit_failure';
    else if (tc.name === 'bash' || tc.name === 'Bash') category = 'command_failure';

    taxonomy[category] = (taxonomy[category] || 0) + 1;
  }

  return taxonomy;
}
