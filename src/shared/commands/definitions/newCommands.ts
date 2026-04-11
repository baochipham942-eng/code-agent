// ============================================================================
// New Commands - /agents, /status, /plugins (stubs)
// ============================================================================

import type { CommandDefinition } from '../types';

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
          const tokenStr = tokens > 0 ? `${(tokens / 1000).toFixed(1)}k tok` : '';
          const preview = run.resultPreview ? `  "${run.resultPreview.slice(0, 60)}${run.resultPreview.length > 60 ? '...' : ''}"` : '';

          lines.push(`  ${icon} ${run.name} (${run.role})  ${run.status}  ${duration}  ${tokenStr}${preview}`);
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
    const tokenStr = totalTokens > 0
      ? `${(totalTokens / 1000).toFixed(1)}k`
      : 'N/A';

    ctx.output.info(
      `Status\n` +
      `  Model:    ${config.modelConfig.provider}/${config.modelConfig.model}\n` +
      `  Session:  ${sessionId}\n` +
      `  Messages: ${history.length}\n` +
      `  Tokens:   ${tokenStr}`
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
    { name: 'subcommand', description: 'list (默认) | enable <id> | disable <id> | reload [id]', required: false },
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

      ctx.output.error(`Unknown subcommand: ${sub}. Use list | enable | disable | reload`);
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

export const newCommands: CommandDefinition[] = [
  agentsCommand,
  statusCommand,
  pluginsCommand,
  hooksCommand,
];
