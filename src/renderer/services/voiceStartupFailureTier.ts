// ============================================================================
// voiceStartupFailureTier —— 启动期失败分档表（T3，方案 §4.2）
//
// 启动期（本次拨号从未到达 live）的失败按「用户能不能动手修」分两档：
//   actionable：用户能修（开麦克风权限 / 配 Key / 换设备 / 去另一个窗口）——
//     保留 error 态通话条 + 引导文案，由 End 按钮显式收尾（既有行为）。
//   silent：用户什么都做不了（上游 5xx / 429 / 握手失败）——收回通话槽位
//     （reset，不留 chrome）+ toast 告知，不留一条点不动的红色僵尸通话条。
//
// 分档是查表不是按名字黑名单：Record<VoiceMessageCode, ...> 穷举所有 code，
// 新增 code 漏写一条就是编译错误，不会静默漏网。
//
// 分档只作用于启动期。到过 live 之后的断线/上游错误走既有 error 态 +
// 重连退避，不经这张表（判据是 bridge 的 hasGoneLive，不是相位枚举——
// 重连会把相位打回 connecting，但那仍是同一通通话中）。
// ============================================================================

import type { VoiceMessageCode } from '@shared/contract/voice';

export type VoiceStartupFailureTier = 'actionable' | 'silent';

export const VOICE_STARTUP_FAILURE_TIER: Record<VoiceMessageCode, VoiceStartupFailureTier> = {
  // 另一路通话占着槽位：用户能去那个窗口继续或在那里挂断——单独的可操作引导（§3.2）。
  VOICE_SESSION_BUSY: 'actionable',
  // 没配 Key：去设置里配一个就能打，用户可行动。
  VOICE_PROVIDER_UNCONFIGURED: 'actionable',
  // 以下三条只在通话中产生（提示/派活失败），不会落到启动失败出口；归 actionable 保持既有呈现。
  VOICE_TOOLS_DROPPED: 'actionable',
  VOICE_MODEL_UNRESPONSIVE: 'actionable',
  VOICE_SERVICE_UNSTABLE: 'actionable',
  VOICE_WORK_FAILED: 'actionable',
  // 用户修不了的上游/网络失败：收回 chrome + toast。
  VOICE_UPSTREAM_UNAVAILABLE: 'silent',
  UPSTREAM_SOCKET: 'silent',
  UPSTREAM_ERROR: 'silent',
  HANDSHAKE_FAILED: 'silent',
  // 退避耗尽只在「WS 曾建上过」之后发生。若那通电话到过 live，hasGoneLive 闸住、
  // 行为不变；若从未到过 live（建连途中反复断），收回 chrome + toast 正是要的呈现。
  RECONNECT_FAILED: 'silent',
  // 麦克风/采集/回声消除：用户能开权限、换设备、戴耳机——可行动。
  MICROPHONE_PERMISSION_DENIED: 'actionable',
  AUDIO_CAPTURE_FAILED: 'actionable',
  NATIVE_AEC_FAILED: 'actionable',
};
