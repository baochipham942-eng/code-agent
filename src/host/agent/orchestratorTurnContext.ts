// ============================================================================
// Orchestrator Turn Context - Per-turn system context composition
// ============================================================================

import type { AgentRunOptions } from '../research/types';
import { getPermissionModeManager } from '../permissions/modes';
import { wrapWithTurnSystemContext } from './turnScaffold';
import { buildCapabilityCandidateNotice } from './capabilityCandidateNotice';

export function applyTurnSystemContext(
  content: string,
  options?: AgentRunOptions,
  sessionId?: string | null,
  getLiveVoicePermissionNotice: (sessionId?: string | null) => string | null = buildLiveVoicePermissionNotice,
): string {
  const turnSystemContext = options?.turnSystemContext?.filter((item) => item.trim().length > 0) || [];
  const liveVoiceNotice = getLiveVoicePermissionNotice(sessionId);
  if (liveVoiceNotice) {
    turnSystemContext.push(liveVoiceNotice);
  }
  // 候选能力（N-CAP1）：每会话首轮注入一次，之后靠历史带着走。
  const capabilityNotice = buildCapabilityCandidateNotice(sessionId);
  if (capabilityNotice) {
    turnSystemContext.push(capabilityNotice);
  }
  // 标签字面量收在 turnScaffold 里：轮首的分类器要按同一份定义把用户原话拆回来
  // （见该文件顶注的 skill 别名劫持实录）。
  return wrapWithTurnSystemContext(turnSystemContext, content);
}

/**
 * D4 通话态权限告知模型。2026-07-26 的事故中，live-voice 会话曾把权限档钳严到
 * readOnly，模型不知道 Write 为何被拒，便依次改用 Write→Write→Bash 白试。
 * ADR-053 已取消这层额外收紧；现在注入会话实际权限档，以及“需要确认时等待审批卡、
 * 不要换写法重试”的行为指引；它与 buildWorkbenchTurnSystemContext 那批 workbench 偏好
 * 共用 turnSystemContext 数组和渲染方式；权限档判据仍同源于 requestPermission 的停车分支。
 * 当前语义不再把实时通话描述为额外的权限收紧。
 */
export function buildLiveVoicePermissionNotice(sessionId?: string | null): string | null {
  if (!sessionId) return null;
  const manager = getPermissionModeManager();
  if (!manager.isLiveVoiceSession(sessionId)) return null;
  const mode = manager.getModeForSession(sessionId);
  // ADR-053 之后通话不再抬严（唯一钳制是 bypassPermissions→acceptEdits），
  // 旧文案「已临时抬严到 X」变成了假话，会误导执行模型以为有额外限制。
  // 现在只陈述事实：档位是多少、需要确认的操作会等审批卡、用户在通话中可能不马上点。
  return [
    '<live_voice_permission_notice>',
    `当前处于实时语音通话中，本轮权限档为 ${mode}（通话跟随会话自己的权限设置，不额外收紧）。`,
    '需要用户确认的操作会挂起等待审批卡；用户正在通话、不在键盘前，可能不会立刻确认。',
    '不要因为一次尝试没有立即成功就反复更换写法重试，等待审批结果即可。',
    '</live_voice_permission_notice>',
  ].join('\n');
}
