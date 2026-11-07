// ============================================================================
// CronPermissionDenied 单测（N-CRON-RUN-COMPLETED-BUT-DENIED ①②③）：
// ① 被拒 Bash + 无其他结果 → permissionDenied.count === 1，结果仍是 completed 形状
//    （不打 skipped、完成通知按 succeeded=true 走「需处理」文案）。
// ② 判据矩阵：被拒 + 非只读成功结果 → 无标记；正常完成 → 无标记；
//    只读成功 + 被拒 → 有标记；digest 有产物 → 无标记。
// ③ reason 映射（user/timeout/cancelled/fail-closed → 四类）+ 摘要脱敏
//    （password=… 命令的机密不进摘要）。
// 另证：metadata（failureCode + hostReason）穿过真实落库清洗链
// sanitizeToolResultsForHistoryWithCalls 后仍在——getMessages() 里的 tool 消息
// 就是这条链的产物（messageProcessor.ts 组装 tool 消息时调它）。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifyState = vi.hoisted(() => ({ notifyTaskComplete: vi.fn() }));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: notifyState.notifyTaskComplete },
}));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => ({ ui: { language: 'zh' } }),
  }),
}));

import { AgentFailureCode } from '../../../src/shared/contract';
import type { HostReasonPayload } from '../../../src/shared/contract/permission';
import { hostReasonModelText, isHostReasonPayload } from '../../../src/shared/contract/permission';
import type { Message } from '../../../src/shared/contract/message';
import type { ToolResult } from '../../../src/shared/contract/tool';
import { permissionDenialError } from '../../../src/host/tools/toolPermissionClassification';
import { sanitizeToolResultsForHistoryWithCalls } from '../../../src/host/agent/messageHandling/converter';
import { deriveCronPermissionDenied } from '../../../src/host/cron/cronPermissionDenied';
import {
  buildCronAgentActionResult,
  isCronAgentActionResult,
  readCronPermissionDenied,
} from '../../../src/host/cron/cronNormalizers';
import { CronFailureNoticeGate, notifyCronAgentExecution } from '../../../src/host/cron/cronFailurePolicy';
import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract/cron';

// ----------------------------------------------------------------------------
// 真实形状的消息构造：tool 消息与 messageProcessor 落库的形状一致
// （role:'tool' + toolResults[]；工具名经前置 assistant 消息的 toolCalls 对回）。
// ----------------------------------------------------------------------------
let messageSeq = 0;

function assistantWithCalls(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): Message {
  messageSeq += 1;
  return { id: `assistant-${messageSeq}`, role: 'assistant', content: '', timestamp: 1_000 + messageSeq, toolCalls: calls };
}

function toolResultMessage(results: ToolResult[]): Message {
  messageSeq += 1;
  return {
    id: `tool-${messageSeq}`,
    role: 'tool',
    content: JSON.stringify(results),
    timestamp: 1_000 + messageSeq,
    toolResults: results,
  };
}

/** toolExecutor ask-denied 出口的真实 ToolResult 形状（metadata.failureCode + hostReason）。 */
function deniedResult(toolCallId: string, hostReason: HostReasonPayload): ToolResult {
  return {
    toolCallId,
    success: false,
    error: hostReasonModelText(hostReason),
    metadata: { failureCode: AgentFailureCode.PermissionDenied, hostReason },
  };
}

function okResult(toolCallId: string, output = 'done'): ToolResult {
  return { toolCallId, success: true, output };
}

function bashCall(id: string, command: string): { id: string; name: string; arguments: Record<string, unknown> } {
  return { id, name: 'bash', arguments: { command } };
}

// mcpCatalog 里 lark 连接器显式声明的只读工具（运行时名：点换下划线）。
const READONLY_MCP_TOOL = 'mcp__lark__calendar_v4_calendarEvent_list';

// ----------------------------------------------------------------------------
// ① 被拒 Bash + 无其他结果
// ----------------------------------------------------------------------------
describe('deriveCronPermissionDenied ① 被拒且无产出', () => {
  it('被拒 Bash + 无其他工具结果 → count === 1、工具名/摘要来自被拒调用', () => {
    const hostReason = permissionDenialError('bash', 'timeout');
    expect(isHostReasonPayload(hostReason)).toBe(true); // 真实 denial 出口形状
    const messages = [
      assistantWithCalls([bashCall('call-1', 'echo hello > out.txt')]),
      toolResultMessage([deniedResult('call-1', hostReason)]),
    ];
    const marker = deriveCronPermissionDenied(messages, false);
    expect(marker).toBeDefined();
    expect(marker?.count).toBe(1);
    expect(marker?.steps).toHaveLength(1);
    expect(marker?.steps[0]).toMatchObject({ tool: 'bash', summary: 'echo hello > out.txt' });
  });

  it('结果组装不打 skipped / 不改 completed 语义；完成通知按「需处理」文案发', () => {
    const marker = deriveCronPermissionDenied(
      [
        assistantWithCalls([bashCall('call-1', 'echo hi')]),
        toolResultMessage([deniedResult('call-1', permissionDenialError('bash', 'timeout'))]),
      ],
      false,
    );
    const built = buildCronAgentActionResult(
      { agentType: 'default', prompt: 'p' }, undefined, 'sess-1', '没有产出', false, false, marker,
    );
    // ① 的「status remains completed」在结果层：仍是 agent 成功形状、不打 skipped，
    // 只多一个 permissionDenied 键（cronService 不因它走 failed/重试/停用分支）。
    expect(isCronAgentActionResult(built)).toBe(true);
    expect(built.skipped).toBeUndefined();
    expect(built.permissionDenied?.count).toBe(1);

    const definition: CronJobDefinition = {
      id: 'job-1', name: '清理', runsOn: 'local', scheduleType: 'every',
      schedule: { type: 'every', interval: 5, unit: 'minutes' },
      action: { type: 'agent', agentType: 'default', prompt: '跑一条命令' },
      enabled: true, createdAt: 1, updatedAt: 2,
    };
    const execution: CronJobExecution = {
      id: 'exec-1', jobId: 'job-1', status: 'completed', scheduledAt: 1, startedAt: 1,
      completedAt: 2, duration: 1, retryAttempt: 0, sessionId: 'sess-1', result: built,
    };
    notifyState.notifyTaskComplete.mockClear();
    notifyCronAgentExecution(definition, execution, new CronFailureNoticeGate());
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    const payload = notifyState.notifyTaskComplete.mock.calls[0][0];
    expect(payload.succeeded).toBe(true);
    // Rework r2：通知要点名哪一步被拒、为什么被拒——含被拒命令与原因大白话，
    // 不再只有通用「有命令没获批准」（此例 reason=timeout → 等批准超时，没有人处理）。
    expect(payload.summary).toContain('echo hi');
    expect(payload.summary).toContain('等批准超时，没有人处理');
    expect(payload.summary).toBe('定时任务需处理：「echo hi」没有获批准（等批准超时，没有人处理），没有产出。');
  });
});

// ----------------------------------------------------------------------------
// ② 判据矩阵（最小判据：被拒 ≥1 且无非只读成功结果且 digest 无产物）
// ----------------------------------------------------------------------------
describe('deriveCronPermissionDenied ② 判据矩阵', () => {
  it('被拒 + 非只读工具成功结果（有产出）→ 无标记', () => {
    const messages = [
      assistantWithCalls([bashCall('call-1', 'echo hi'), bashCall('call-2', 'cat report.md')]),
      toolResultMessage([
        deniedResult('call-1', permissionDenialError('bash', 'timeout')),
        okResult('call-2'),
      ]),
    ];
    expect(deriveCronPermissionDenied(messages, false)).toBeUndefined();
  });

  it('被拒 + digest 有产物 → 无标记（别的活干成了，仍是普通成功）', () => {
    const messages = [
      assistantWithCalls([bashCall('call-1', 'echo hi')]),
      toolResultMessage([deniedResult('call-1', permissionDenialError('bash', 'timeout'))]),
    ];
    expect(deriveCronPermissionDenied(messages, true)).toBeUndefined();
  });

  it('正常完成运行（无被拒）→ 无标记', () => {
    const messages = [
      assistantWithCalls([bashCall('call-1', 'ls')]),
      toolResultMessage([okResult('call-1')]),
    ];
    expect(deriveCronPermissionDenied(messages, false)).toBeUndefined();
  });

  it('对不回调用名的成功结果按有产出算（证不了只读）→ 无标记', () => {
    const messages = [
      { role: 'assistant', toolCalls: [{ id: 'denied', name: 'Bash', arguments: { command: 'rm x' } }] },
      {
        role: 'tool',
        toolResults: [
          { toolCallId: 'denied', success: false, metadata: { failureCode: AgentFailureCode.PermissionDenied } },
          { toolCallId: 'orphan', success: true },
        ],
      },
    ] as unknown as Parameters<typeof deriveCronPermissionDenied>[0];
    expect(deriveCronPermissionDenied(messages, false)).toBeUndefined();
  });

  it('只读放行工具的成功结果不抵消：只读成功 + 被拒 → 有标记', () => {
    const messages = [
      assistantWithCalls([
        { id: 'call-ro', name: READONLY_MCP_TOOL, arguments: {} },
        bashCall('call-1', 'echo hi'),
      ]),
      toolResultMessage([
        okResult('call-ro', '[]'),
        deniedResult('call-1', permissionDenialError('bash', 'timeout')),
      ]),
    ];
    expect(deriveCronPermissionDenied(messages, false)?.count).toBe(1);
  });

  it('空消息 / 无 tool 消息 → 无标记（不炸）', () => {
    expect(deriveCronPermissionDenied([], false)).toBeUndefined();
    expect(deriveCronPermissionDenied(
      [{ role: 'assistant' }],
      false,
    )).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// ③ reason 映射 + 摘要脱敏
// ----------------------------------------------------------------------------
describe('deriveCronPermissionDenied ③ reason 映射与脱敏', () => {
  const CASES: ReadonlyArray<{
    label: string;
    source: Parameters<typeof permissionDenialError>[1];
    reason: 'user' | 'timeout' | 'cancelled' | 'other';
  }> = [
    { label: '真人拒', source: 'user', reason: 'user' },
    { label: '等批准超时', source: 'timeout', reason: 'timeout' },
    { label: '运行取消作废', source: 'cancelled', reason: 'cancelled' },
    { label: '审批链路 fail-closed', source: 'fail-closed', reason: 'other' },
  ];

  it.each(CASES)('hostReason.code 归并：$label → $reason', ({ source, reason }) => {
    const marker = deriveCronPermissionDenied(
      [
        assistantWithCalls([bashCall('call-1', 'echo hi')]),
        toolResultMessage([deniedResult('call-1', permissionDenialError('bash', source))]),
      ],
      false,
    );
    expect(marker?.steps[0]?.reason).toBe(reason);
  });

  it('摘要不含 password=… 命令里的明文机密（审批预览同款脱敏）', () => {
    const marker = deriveCronPermissionDenied(
      [
        assistantWithCalls([bashCall('call-1', 'curl -s "https://api.test/v1?password=hunter2-secret"')]),
        toolResultMessage([deniedResult('call-1', permissionDenialError('bash', 'timeout'))]),
      ],
      false,
    );
    expect(marker?.steps[0]?.summary).not.toContain('hunter2-secret');
    expect(marker?.steps[0]?.summary).toContain('password=');
  });

  it('超长命令摘要截到 80 字符以内', () => {
    const marker = deriveCronPermissionDenied(
      [
        assistantWithCalls([bashCall('call-1', `echo "${'x'.repeat(300)}"`)]),
        toolResultMessage([deniedResult('call-1', permissionDenialError('bash', 'timeout'))]),
      ],
      false,
    );
    expect((marker?.steps[0]?.summary ?? '').length).toBeLessThanOrEqual(80);
  });
});

// ----------------------------------------------------------------------------
// metadata 存活验证：真实清洗链（sanitizeToolResultsForHistoryWithCalls，即
// messageProcessor 组装 tool 消息前对 toolResults 跑的那一趟）之后，标记推导
// 仍能从清洗产物里读到 failureCode/hostReason——getMessages() 里的就是这个形状。
// ----------------------------------------------------------------------------
describe('metadata 穿过真实落库清洗链后仍在', () => {
  it('sanitizeToolResultsForHistoryWithCalls 产物仍推出标记', () => {
    const hostReason = permissionDenialError('bash', 'timeout');
    const raw: ToolResult[] = [deniedResult('call-1', hostReason)];
    const call = bashCall('call-1', 'echo hi');
    const sanitized = sanitizeToolResultsForHistoryWithCalls(raw, [call]);
    const messages = [assistantWithCalls([call]), toolResultMessage(sanitized)];
    expect(deriveCronPermissionDenied(messages, false)?.count).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// 读取口守卫：readCronPermissionDenied 对坏形状 / 旧数据回落 undefined
// ----------------------------------------------------------------------------
describe('readCronPermissionDenied 守卫读取', () => {
  it('agent 结果带合法标记 → 读出；坏标记 / 旧结果 / 非 agent 形状 → undefined', () => {
    const marker = deriveCronPermissionDenied(
      [
        assistantWithCalls([bashCall('call-1', 'echo hi')]),
        toolResultMessage([deniedResult('call-1', permissionDenialError('bash', 'timeout'))]),
      ],
      false,
    );
    expect(readCronPermissionDenied(
      buildCronAgentActionResult({ agentType: 'default', prompt: 'p' }, undefined, 's', 'x', false, false, marker),
    )).toEqual(marker);
    expect(readCronPermissionDenied(
      buildCronAgentActionResult({ agentType: 'default', prompt: 'p' }, undefined, 's', 'x', false, false),
    )).toBeUndefined();
    expect(readCronPermissionDenied({ sessionId: 's', permissionDenied: { count: 0, steps: [] } })).toBeUndefined();
    expect(readCronPermissionDenied(undefined)).toBeUndefined();
    expect(readCronPermissionDenied('完成')).toBeUndefined();
  });
});

beforeEach(() => {
  notifyState.notifyTaskComplete.mockClear();
});
