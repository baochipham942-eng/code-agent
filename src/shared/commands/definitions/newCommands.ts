// ============================================================================
// New Commands - /agents, /status, /plugins, /hooks, /cost, /context
// ============================================================================

import type { CommandDefinition } from '../types';
import { MODEL_PRICING_PER_1M } from '../../constants';

// Formatting helpers
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtCost(n: number): string {
  return `$${n.toFixed(3)}`;
}
function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

export const agentsCommand: CommandDefinition = {
  id: 'agents',
  name: 'Agent 列表',
  description: '查看运行中和历史 Agent 记录',
  category: 'status',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    const lines: string[] = [];

    // --- 运行中 ---
    try {
      const { getSessionStateManager } = await import(
        '../../../main/session/sessionStateManager'
      );
      const manager = getSessionStateManager();
      const running = manager.getRunning();

      lines.push('运行中');
      if (running.length === 0) {
        lines.push('  (无)');
      } else {
        for (const session of running) {
          const agentCount = manager.getActiveAgentCount(session.sessionId);
          lines.push(`  ● ${session.sessionId}  agents: ${agentCount}  status: ${session.status}`);
        }
      }
    } catch {
      lines.push('运行中');
      lines.push('  (无法获取)');
    }

    lines.push('');

    // --- 最近完成 ---
    try {
      const { getRecentAgentHistory } = await import(
        '../../../main/session/agentHistoryPersistence'
      );
      const history = await getRecentAgentHistory(10);

      lines.push('最近完成');
      if (history.length === 0) {
        lines.push('  (无历史记录)');
      } else {
        for (const run of history) {
          const icon = run.status === 'completed' ? '✓' : run.status === 'failed' ? '✗' : '○';
          const duration = run.durationMs < 1000
            ? `${run.durationMs}ms`
            : `${(run.durationMs / 1000).toFixed(1)}s`;
          const tokens = run.tokenUsage.input + run.tokenUsage.output;
          const tokenStr = tokens > 0 ? `${fmtTokens(tokens)} tok` : '';
          const defaultPricing = MODEL_PRICING_PER_1M['default'];
          const cost = (run.tokenUsage.input * defaultPricing.input + run.tokenUsage.output * defaultPricing.output) / 1_000_000;
          const costStr = cost > 0 ? ` (${fmtCost(cost)})` : '';
          const preview = run.resultPreview ? `  "${run.resultPreview.slice(0, 60)}${run.resultPreview.length > 60 ? '...' : ''}"` : '';

          lines.push(`  ${icon} ${run.name} (${run.role})  ${run.status}  ${duration}  ${tokenStr}${costStr}${preview}`);
        }
      }
    } catch {
      lines.push('最近完成');
      lines.push('  (无法获取)');
    }

    ctx.output.info(lines.join('\n'));
    return { success: true };
  },
};

export const statusCommand: CommandDefinition = {
  id: 'status',
  name: '状态',
  description: '查看当前会话状态',
  category: 'status',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    const agent = ctx.agent as {
      getConfig?: () => { modelConfig: { provider: string; model: string } };
      getHistory?: () => Array<unknown>;
      getSessionId?: () => string | null;
      getTokenUsage?: () => { inputTokens: number; outputTokens: number };
      getCostInfo?: () => { inputTokens: number; outputTokens: number; model: string; provider: string };
    } | undefined;

    if (!agent?.getConfig) {
      ctx.output.info('Agent not available');
      return { success: false };
    }

    const config = agent.getConfig();
    const history = agent.getHistory?.() ?? [];
    const sessionId = agent.getSessionId?.() ?? 'N/A';
    const usage = agent.getTokenUsage?.();

    const totalTokens = usage ? usage.inputTokens + usage.outputTokens : 0;
    const tokenStr = totalTokens > 0 ? fmtTokens(totalTokens) : 'N/A';

    // Cost info
    let costSuffix = '';
    if (agent.getCostInfo && totalTokens > 0) {
      const info = agent.getCostInfo();
      const pricing = MODEL_PRICING_PER_1M[info.model] || MODEL_PRICING_PER_1M['default'];
      const totalCost = (info.inputTokens * pricing.input + info.outputTokens * pricing.output) / 1_000_000;
      costSuffix = ` (${fmtCost(totalCost)})`;
    }

    // Context info
    let contextLine = '';
    try {
      const { getContextHealthService } = await import('../../../main/context/contextHealthService');
      const health = getContextHealthService().getLatest();
      if (health.lastUpdated > 0) {
        contextLine = `\n  Context:  ${health.usagePercent.toFixed(1)}% (~${health.estimatedTurnsRemaining} turns remaining)`;
      }
    } catch { /* context service not available */ }

    ctx.output.info(
      `Status\n` +
      `  Model:    ${config.modelConfig.provider}/${config.modelConfig.model}\n` +
      `  Session:  ${sessionId}\n` +
      `  Messages: ${history.length}\n` +
      `  Tokens:   ${tokenStr}${costSuffix}${contextLine}`
    );

    return {
      success: true,
      data: {
        model: `${config.modelConfig.provider}/${config.modelConfig.model}`,
        sessionId,
        messageCount: history.length,
        totalTokens,
      },
    };
  },
};

export const pluginsCommand: CommandDefinition = {
  id: 'plugins',
  name: '插件',
  description: '列出并管理已安装扩展（插件 + 技能）',
  category: 'tools',
  surfaces: ['cli', 'gui'],
  args: [
    { name: 'subcommand', description: 'list | install <spec> | uninstall <id> | enable <id> | disable <id> | reload [id] | validate <id>', required: false },
  ],
  handler: async (ctx, args) => {
    try {
      const { getExtensionOpsService } = await import(
        '../../../main/services/extensionOpsService'
      );
      const svc = getExtensionOpsService();

      const sub = args[0]?.toLowerCase() ?? 'list';

      // -- list ---------------------------------------------------------------
      if (sub === 'list' || args.length === 0) {
        const extensions = await svc.list();
        if (extensions.length === 0) {
          ctx.output.info('No extensions installed');
          return { success: true, data: { count: 0 } };
        }

        const lines: string[] = [`Extensions (${extensions.length})`];
        for (const ext of extensions) {
          const badge = ext.status === 'active' ? '+' : ext.status === 'error' ? '!' : '-';
          const ver = ext.version ? ` v${ext.version}` : '';
          const src = ext.source !== 'local' ? ` [${ext.source}]` : '';
          const err = ext.error ? ` (${ext.error})` : '';
          lines.push(`  ${badge} ${ext.id}  ${ext.type}  ${ext.status}${ver}${src}${err}`);
        }
        ctx.output.info(lines.join('\n'));
        return { success: true, data: { count: extensions.length } };
      }

      // -- enable / disable ---------------------------------------------------
      if (sub === 'enable' || sub === 'disable') {
        const id = args[1];
        if (!id) {
          ctx.output.error(`Usage: /plugins ${sub} <id>`);
          return { success: false };
        }
        if (sub === 'enable') {
          await svc.enable(id);
          ctx.output.success(`Enabled: ${id}`);
        } else {
          await svc.disable(id);
          ctx.output.success(`Disabled: ${id}`);
        }
        return { success: true };
      }

      // -- reload -------------------------------------------------------------
      if (sub === 'reload') {
        const id = args[1]; // optional
        await svc.reload(id);
        ctx.output.success(id ? `Reloaded: ${id}` : 'All extensions reloaded');
        return { success: true };
      }

      // -- install --------------------------------------------------------------
      if (sub === 'install') {
        const spec = args[1];
        if (!spec) {
          ctx.output.error('Usage: /plugins install <spec>');
          return { success: false };
        }
        await svc.install(spec);
        ctx.output.success(`Installed: ${spec}`);
        return { success: true };
      }

      // -- uninstall ------------------------------------------------------------
      if (sub === 'uninstall') {
        const id = args[1];
        if (!id) {
          ctx.output.error('Usage: /plugins uninstall <id>');
          return { success: false };
        }
        await svc.uninstall(id);
        ctx.output.success(`Uninstalled: ${id}`);
        return { success: true };
      }

      // -- validate -------------------------------------------------------------
      if (sub === 'validate') {
        const id = args[1];
        if (!id) {
          ctx.output.error('Usage: /plugins validate <id>');
          return { success: false };
        }
        const result = await svc.validate(id);
        if (result.valid) {
          ctx.output.success(`Valid: ${id}`);
        } else {
          const lines = [`Invalid: ${id}`];
          for (const err of result.errors) {
            lines.push(`  [error] ${err.field}: ${err.message}`);
          }
          for (const warn of result.warnings) {
            lines.push(`  [warn]  ${warn.field}: ${warn.message}`);
          }
          ctx.output.error(lines.join('\n'));
        }
        return { success: result.valid };
      }

      ctx.output.error(`Unknown subcommand: ${sub}. Use list | install | uninstall | enable | disable | reload | validate`);
      return { success: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.output.error(`Plugin operation failed: ${message}`);
      return { success: false, message };
    }
  },
};

export const hooksCommand: CommandDefinition = {
  id: 'hooks',
  name: 'Hooks',
  description: '查看 Hook 配置和最近触发历史',
  category: 'status',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    const lines: string[] = [];

    try {
      const agent = ctx.agent as {
        getHookManager?: () => { getHookStats: () => Record<string, number>; getTriggerHistory: () => Array<{ timestamp: number; event: string; action: string; durationMs: number; hookCount: number; modified: boolean }> } | null;
      } | undefined;

      const hookManager = agent?.getHookManager?.();
      if (!hookManager) {
        ctx.output.info('Hook system not initialized');
        return { success: true };
      }

      // Hook Configurations
      const stats = hookManager.getHookStats();
      const eventEntries = Object.entries(stats).filter(([, count]) => count > 0);

      lines.push('Hook Configurations:');
      if (eventEntries.length === 0) {
        lines.push('  (no hooks configured)');
      } else {
        for (const [event, count] of eventEntries) {
          lines.push(`  ${event}: ${count} hook(s)`);
        }
      }

      lines.push('');

      // Recent Triggers
      const history = hookManager.getTriggerHistory();
      const recent = history.slice(-10);

      lines.push(`Recent Triggers (${history.length} total, showing last ${recent.length}):`);
      if (recent.length === 0) {
        lines.push('  (no triggers yet)');
      } else {
        for (const entry of recent) {
          const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
          const mod = entry.modified ? ' [modified]' : '';
          lines.push(`  ${time} ${entry.event} → ${entry.action} (${entry.durationMs}ms, ${entry.hookCount} hooks)${mod}`);
        }
      }

      ctx.output.info(lines.join('\n'));
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.output.error(`Hooks command failed: ${message}`);
      return { success: false, message };
    }
  },
};

export const costCommand: CommandDefinition = {
  id: 'cost',
  name: 'Cost',
  description: '查看当前会话的 token 用量和成本',
  category: 'status',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    const agent = ctx.agent as {
      getCostInfo?: () => { inputTokens: number; outputTokens: number; model: string; provider: string };
    } | undefined;

    const info = agent?.getCostInfo?.();
    if (!info) {
      ctx.output.info('Cost data not available');
      return { success: true };
    }

    const pricing = MODEL_PRICING_PER_1M[info.model] || MODEL_PRICING_PER_1M['default'];
    const inputCost = (info.inputTokens * pricing.input) / 1_000_000;
    const outputCost = (info.outputTokens * pricing.output) / 1_000_000;
    const totalCost = inputCost + outputCost;

    const lines: string[] = [
      'Cost (session)',
      `  Model:    ${info.provider}/${info.model}`,
      `  Input:    ${fmtTokens(info.inputTokens)} tokens (${fmtCost(inputCost)})`,
      `  Output:   ${fmtTokens(info.outputTokens)} tokens (${fmtCost(outputCost)})`,
      `  Total:    ${fmtCost(totalCost)}`,
    ];

    // Budget info (optional)
    try {
      const { getBudgetService } = await import('../../../main/services/core/budgetService');
      const budget = getBudgetService();
      const status = budget.checkBudget();
      if (status.maxBudget > 0) {
        lines.push(`  Budget:   ${fmtCost(status.currentCost)} / ${fmtCost(status.maxBudget)} (${status.usagePercentage.toFixed(1)}%)`);
      }
    } catch { /* budget service not available */ }

    ctx.output.info(lines.join('\n'));
    return { success: true };
  },
};

export const contextCommand: CommandDefinition = {
  id: 'context',
  name: 'Context',
  description: '查看上下文窗口使用情况',
  category: 'context',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    try {
      const { getContextHealthService } = await import('../../../main/context/contextHealthService');
      const health = getContextHealthService().getLatest();

      if (health.lastUpdated === 0 || health.currentTokens === 0) {
        ctx.output.info('Context data not yet available (send a message first)');
        return { success: true };
      }

      const total = health.currentTokens;
      const pctSys = total > 0 ? ((health.breakdown.systemPrompt / total) * 100).toFixed(1) : '0';
      const pctMsg = total > 0 ? ((health.breakdown.messages / total) * 100).toFixed(1) : '0';
      const pctTool = total > 0 ? ((health.breakdown.toolResults / total) * 100).toFixed(1) : '0';

      const lines: string[] = [
        'Context',
        `  Usage:    ${fmtNum(health.currentTokens)} / ${fmtNum(health.maxTokens)} tokens (${health.usagePercent.toFixed(1)}%)`,
        `  System:   ${fmtNum(health.breakdown.systemPrompt)} tokens (${pctSys}%)`,
        `  Messages: ${fmtNum(health.breakdown.messages)} tokens (${pctMsg}%)`,
        `  Tools:    ${fmtNum(health.breakdown.toolResults)} tokens (${pctTool}%)`,
        `  Turns:    ~${health.estimatedTurnsRemaining} remaining`,
      ];

      // Compression stats
      try {
        const { getAutoCompressor } = await import('../../../main/context/autoCompressor');
        const stats = getAutoCompressor().getStats();
        if (stats.compressionCount > 0) {
          lines.push(`  Compressed: ${stats.compressionCount} times, saved ${fmtNum(stats.totalSavedTokens)} tokens`);
        }
      } catch { /* compressor not available */ }

      ctx.output.info(lines.join('\n'));
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.output.error(`Context command failed: ${message}`);
      return { success: false, message };
    }
  },
};

function fmtRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export const permissionsCommand: CommandDefinition = {
  id: 'permissions',
  name: 'Permissions',
  description: '查看安全决策链状态',
  category: 'status',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    const lines: string[] = [];

    // Section 1: Mode
    try {
      const { getPermissionModeManager } = await import('../../../main/permissions/modes');
      const manager = getPermissionModeManager();
      const mode = manager.getMode();
      const config = manager.getModeConfig();
      lines.push('Permissions');
      lines.push(`  Mode:     ${mode} — ${config.description}`);
    } catch {
      lines.push('Permissions');
      lines.push('  Mode:     default');
    }

    lines.push('');

    // Section 2: Exec Policy Rules
    try {
      const { getExecPolicyStore } = await import('../../../main/security/execPolicy');
      const rules = getExecPolicyStore().getRules();
      lines.push(`  Exec Policy (${rules.length} rules):`);
      if (rules.length === 0) {
        lines.push('    (no rules learned yet)');
      } else {
        for (const rule of rules.slice(0, 15)) {
          const pattern = rule.pattern.join(' ') + ' *';
          const time = fmtRelativeTime(rule.createdAt);
          const src = rule.source === 'builtin' ? 'builtin' : time;
          lines.push(`    ${pattern.padEnd(24)} → ${rule.decision}  (${src})`);
        }
        if (rules.length > 15) {
          lines.push(`    ... and ${rules.length - 15} more`);
        }
      }
    } catch {
      lines.push('  Exec Policy: (not initialized)');
    }

    lines.push('');

    // Section 3: Recent Decisions
    try {
      const { getDecisionHistory } = await import('../../../main/security/decisionHistory');
      const recent = getDecisionHistory().getRecent(10);
      const total = getDecisionHistory().getAll().length;
      lines.push(`  Recent Decisions (${total} total, showing last ${recent.length}):`);
      if (recent.length === 0) {
        lines.push('    (no decisions yet)');
      } else {
        for (const entry of recent) {
          const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
          lines.push(`    ${time} ${entry.toolName}(${entry.summary.substring(0, 40)}) → ${entry.outcome}  (${entry.reason}, ${entry.durationMs}ms)`);
        }
      }
    } catch {
      lines.push('  Recent Decisions: (not available)');
    }

    ctx.output.info(lines.join('\n'));
    return { success: true };
  },
};

export const newCommands: CommandDefinition[] = [
  agentsCommand,
  statusCommand,
  pluginsCommand,
  hooksCommand,
  costCommand,
  contextCommand,
  permissionsCommand,
];
