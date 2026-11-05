// ============================================================================
// Cron Permission-Denied — 从运行消息推导「有命令没获批准且无产出」标记
// ----------------------------------------------------------------------------
// N-CRON-RUN-COMPLETED-BUT-DENIED（FB-575）：无人值守 agent 运行里 ask 级工具
// 被拒（60s 超时 deny / 真人拒 / 重启作废），executeAction 不抛错，执行状态落
// completed、UI 显示绿色「成功」——但这次运行其实什么都没产出。host 在 run
// 结算后、会话清理前扫 orchestrator.getMessages()：tool 消息的 toolResults[]
// 里 metadata.failureCode === AgentFailureCode.PermissionDenied 的即被拒调用
// （toolExecutor ask-denied 出口），工具名经前置 assistant 消息的 toolCalls
// 按 toolCallId 对回。拒绝不是任务失败：状态保持 completed，只挂本标记。
// ============================================================================

import { AgentFailureCode } from '../../shared/contract';
import { HostReasonCode } from '../../shared/contract/permission';
import type {
  CronPermissionDeniedMarker,
  CronPermissionDeniedReason,
} from '../../shared/contract/sessionAutomation';
import type { Message } from '../../shared/contract/message';
import { isUnattendedAllowedReadOnlyTool } from '../permissions/unattendedReadOnlyTools';
import { redactCommandSecrets } from '../security/secretRedaction';

/** 摘要上限：与 toolExecutor 拒绝登记（denialRegistry.summary）同一档。 */
const SUMMARY_MAX_CHARS = 80;

/** 扫描只需这三个字段；调用方传 orchestrator.getMessages() 的只读切片即可。 */
export type CronPermissionScanMessage = Pick<Message, 'role' | 'toolCalls' | 'toolResults'>;

/** reason 归并：其余 hostReason 码（fail-closed / no-approval-ui / scripted …）都归 other。 */
function reasonFromHostReasonCode(code: unknown): CronPermissionDeniedReason {
  if (code === HostReasonCode.PermissionDeniedByUser) return 'user';
  if (code === HostReasonCode.PermissionDeniedTimeout) return 'timeout';
  if (code === HostReasonCode.PermissionDeniedCancelled) return 'cancelled';
  return 'other';
}

/**
 * 被拒调用的摘要：命令/文件路径/URL 优先，都没有就用工具名；先过审批预览
 * 同款脱敏（password=… 等密钥形态）再截断，原始命令里的机密不进执行结果。
 */
function buildStepSummary(toolName: string, args: Record<string, unknown> | undefined): string {
  const raw = [args?.command, args?.file_path, args?.path, args?.url]
    .find((value): value is string => typeof value === 'string' && value.length > 0)
    ?? toolName;
  const redacted = redactCommandSecrets(raw);
  return redacted.length > SUMMARY_MAX_CHARS
    ? `${redacted.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : redacted;
}

/**
 * 推导「需处理」标记（纯函数）。只在三条件同时成立时返回标记，否则 undefined：
 *   1. 被拒的 ask 级调用 ≥ 1；
 *   2. 没有任何**非只读**工具的成功结果（只读放行工具的成功不抵消——它们本来
 *      就免审批，成功不代表产出了东西；isUnattendedAllowedReadOnlyTool 同源）；
 *   3. digest 没有产物（有产物说明别的活干成了，运行仍是普通成功）。
 * 这是最小判据（设计选项 B）：部分被拒但有产出的运行保持绿色「成功」。
 */
export function deriveCronPermissionDenied(
  messages: readonly CronPermissionScanMessage[],
  digestHasArtifacts: boolean,
): CronPermissionDeniedMarker | undefined {
  const callsById = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      callsById.set(call.id, { name: call.name, args: call.arguments });
    }
  }
  const steps: CronPermissionDeniedMarker['steps'] = [];
  let hasProductiveSuccess = false;
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const result of message.toolResults ?? []) {
      const call = callsById.get(result.toolCallId);
      const metadata = result.metadata;
      if (metadata?.failureCode === AgentFailureCode.PermissionDenied) {
        const hostReason = metadata.hostReason as { code?: unknown } | null | undefined;
        steps.push({
          tool: call?.name ?? '',
          summary: buildStepSummary(call?.name ?? '', call?.args),
          reason: reasonFromHostReasonCode(hostReason?.code),
        });
        continue;
      }
      // 名字对不回的成功结果按「有产出」处理：证不了它只读，就不该把运行
      // 说成「没有产出」（标记宁缺勿滥，最小判据）。
      if (result.success && !(call?.name && isUnattendedAllowedReadOnlyTool(call.name))) {
        hasProductiveSuccess = true;
      }
    }
  }
  if (steps.length === 0 || hasProductiveSuccess || digestHasArtifacts) return undefined;
  return { count: steps.length, steps };
}
