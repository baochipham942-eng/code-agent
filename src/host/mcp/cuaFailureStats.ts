/**
 * CUA 失败分类统计（灰度期决策数据）。
 *
 * 在 mcpClient.callTool 的 cua-driver 分支落 JSONL —— 桌面端和 CLI 都必经
 * 这一层，与 telemetry 链路健康度解耦（2026-06-11 发现 CLI 会话的工具调用
 * 没进 telemetry_tool_calls）。三类事件入统计：锁拒绝、预算超限、调用失败。
 *
 * 分类口径回答三个灰度决策：
 *   no_ax_tree 占比高 → 视觉兜底要做；budget 占比高 → 上限值要调；
 *   任务失败但本统计无记录 → silent-drop 在作祟，F2（代码级快照 diff）提优先级。
 *
 * 报告：scripts/cua-failure-report.sh 聚合。
 */

import { appendFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';

export type CuaFailureCategory =
  | 'permission'
  | 'element'
  | 'no_ax_tree'
  | 'timeout'
  | 'budget'
  | 'lock'
  | 'other';

/** 顺序即优先级：先命中先归类（budget/lock 是 Neo 自产文案，放最前防误配） */
const CLASSIFIER: Array<[CuaFailureCategory, RegExp]> = [
  ['budget', /轨迹预算/],
  ['lock', /另一个会话.*正在使用计算机/],
  ['permission', /permission|tcc|not granted|denied|screen recording/i],
  ['no_ax_tree', /(accessibility tree|ax).*(empty|unavailable)|empty.*accessibility tree|does not expose accessibility/i],
  ['element', /stale|element.*not found|not found.*(element|index)|invalid.*element_index/i],
  ['timeout', /timed? ?out/i],
];

export function classifyCuaFailure(errorText: string): CuaFailureCategory {
  for (const [category, pattern] of CLASSIFIER) {
    if (pattern.test(errorText)) return category;
  }
  return 'other';
}

function getStatsPath(): string {
  return (
    process.env.CODE_AGENT_CUA_STATS_PATH ||
    join(homedir(), '.code-agent', 'logs', 'cua-failures.jsonl')
  );
}

/** 追加一条失败记录。失败静默吞掉——统计不能影响主链路。 */
export async function recordCuaFailure(
  tool: string,
  sessionId: string,
  errorText: string,
): Promise<void> {
  try {
    const record = {
      ts: Date.now(),
      tool,
      sessionId,
      category: classifyCuaFailure(errorText),
      error: errorText.slice(0, 200),
    };
    const path = getStatsPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(record) + '\n');
  } catch {
    // 统计失败不影响主链路
  }
}
