// ============================================================================
// Orchestrator Turn Context - Per-turn system context composition
// ============================================================================

import type { AgentRunOptions } from '../research/types';
import { getPermissionModeManager } from '../permissions/modes';
import { wrapWithTurnSystemContext } from './turnScaffold';

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
  // 标签字面量收在 turnScaffold 里：轮首的分类器要按同一份定义把用户原话拆回来
  // （见该文件顶注的 skill 别名劫持实录）。
  return wrapWithTurnSystemContext(turnSystemContext, content);
}

/**
 * D4 通话态钳档告知模型（2026-07-26 真机实录）：live-voice 会话把权限档钳严到
 * readOnly 时，模型此前完全不知道自己被拦了什么——Write 被拒后接连换 Write→Write→
 * Bash 三种写法白试，因为它只看到通用拒绝错误，猜不到根因是「通话中」。
 * 这里把钳档事实和「等审批卡、别换写法重试」的行为指引直接注入这一轮的 system context，
 * 与 buildWorkbenchTurnSystemContext 那批 workbench 偏好走同一个 turnSystemContext 数组、
 * 同一套渲染方式，不另起机制。判据同源于 requestPermission 的停车分支（D4 单一真源）。
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
