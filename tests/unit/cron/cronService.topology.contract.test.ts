// ============================================================================
// cron agent 会话拓扑标注源码契约（2026-07-13 拓扑激活批 4）
//
// cron 的 agent action 走 orchestrator.sendMessage 主路径（无 SubagentExecutionContext），
// 拓扑经 orchestrator.setExecutionTopology → ToolExecutor.setExecutionTopology 注入。
// executeAction 全链 runtime harness 成本过高（TaskManager/SessionManager 全家桶），
// 采用源码契约钉死接线；setter 本身的行为由
// tests/tools/toolExecutor.guardFabricTopology.test.ts 覆盖。
//
// 不变量：
//   1. cronService 拿到 orchestrator 后立即标 async_agent（在 sendMessage 之前）。
//   2. AgentOrchestrator.setExecutionTopology 委托给 toolExecutor。
//   3. cron 无人值守语义：async_agent 的 bash ask → requestPermission 60s 超时 deny，
//      不挂死（orchestratorPermissions PERMISSION_TIMEOUT 既有机制）。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CRON_SERVICE_PATH = path.resolve(__dirname, '../../../src/host/cron/cronService.ts');
const ORCHESTRATOR_PATH = path.resolve(__dirname, '../../../src/host/agent/agentOrchestrator.ts');
// 超时实现属于权限岛；搬文件时须同步更新这里的源码契约路径。
const PERMISSIONS_PATH = path.resolve(__dirname, '../../../src/host/agent/orchestratorPermissions.ts');

describe('cron agent 会话拓扑标注接线', () => {
  const cronSource = readFileSync(CRON_SERVICE_PATH, 'utf8');
  const orchestratorSource = readFileSync(ORCHESTRATOR_PATH, 'utf8');
  const permissionsSource = readFileSync(PERMISSIONS_PATH, 'utf8');

  it('cronService 在 sendMessage 前把 orchestrator 标为 async_agent', () => {
    expect(cronSource).toMatch(
      /setExecutionTopology\('async_agent'\)[\s\S]{0,1600}sendMessage\(\s*buildCronAgentPrompt\(\s*action\.prompt\s*,/,
    );
  });

  it('cronService 把 action.urgencyCriteria 与 action.notifyWhen 接进 buildCronAgentPrompt（N-CRON-MORNING-TRIAGE-URGENCY-RULE / N-CRON-RESTATE-HUMAN-WHEN）', () => {
    expect(cronSource).toMatch(
      /buildCronAgentPrompt\(\s*action\.prompt\s*,\s*previousSnapshot\s*,\s*snapshotTrackingEnabled\s*,\s*undefined\s*,\s*action\.urgencyCriteria\s*,\s*action\.notifyWhen\s*\)/,
    );
  });

  it('cronService 把 notifyWhen / urgencyCriteria 安静轮接进投递门与结果标记（N-CRON-RESTATE-HUMAN-WHEN / N-CRON-URGENCY-NOTIFY）', () => {
    // 判定走 cronFailurePolicy.cronNotifyQuietRound（含留痕）；hasAlert 的「值得
    // 打扰」矩阵收口在 cronNormalizers.cronAgentRunHasAlert；推送门同时看
    // quietWatchRound（external-watch）与 notifyQuietRound（判据未满足的安静轮）；
    // 结果组装带上 notifyQuietRound（→ notifySuppressed 标记，通知门用）。
    expect(cronSource).toMatch(
      /const hasAlert = cronAgentRunHasAlert\(action, \{ isExternalWatch, finalAssistantText \}\)/,
    );
    expect(cronSource).toMatch(
      /const notifyQuietRound = cronNotifyQuietRound\(action, hasAlert, definition\.id\)/,
    );
    expect(cronSource).toMatch(
      /if \(!quietWatchRound && !notifyQuietRound\) \{[\s\S]{0,400}deliverCronResult\(/,
    );
    expect(cronSource).toMatch(
      /buildCronAgentActionResult\(action, result, cronSession\.id, finalAssistantText, quietWatchRound, notifyQuietRound\)/,
    );
  });

  it('AgentOrchestrator.setExecutionTopology 委托 toolExecutor', () => {
    expect(orchestratorSource).toMatch(
      /setExecutionTopology\(topology: ExecutionTopology\): void \{\s*\n\s*this\.toolExecutor\.setExecutionTopology\(topology\);/,
    );
  });

  it('requestPermission 保留超时 deny 机制（无人值守 ask 不挂死）', () => {
    expect(permissionsSource).toMatch(/PERMISSION_TIMEOUT\s*=[^;]*\b60000\b/);
  });
});
