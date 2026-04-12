// ============================================================================
// TUI Chat Runner — Replaces readline loop with TUI screen + input manager
// ============================================================================

import chalk from 'chalk';
import { execSync } from 'child_process';
import { createTUI } from './index';
import type { TUIScreen } from './screen';
import type { CLIAgent } from '../adapter';
import { terminalOutput } from '../output';
import type { AgentEvent } from '../../shared/contract';
import { MODEL_PRICING_PER_1M } from '../../shared/constants/pricing';

/**
 * Run the TUI chat loop.
 * Replaces readline with raw-mode input + persistent status bar.
 */
export async function runTUIChat(
  agent: CLIAgent,
  handleCommand: (input: string, agent: CLIAgent) => Promise<boolean>,
  cleanupFn: () => Promise<void>,
  globalOpts?: { project?: string },
): Promise<void> {
  const { screen, input, unpatch } = createTUI();

  // Get git branch for status bar
  let gitBranch = '';
  try {
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
  } catch { /* not in git repo */ }

  screen.updateStatus({ gitBranch, phase: 'idle' });

  // Register event observer for status bar updates
  agent.setEventObserver((event) => updateStatusFromEvent(screen, event));

  // Enable TUI mode in terminal output (routes ora/error through stdout)
  terminalOutput.setTUIMode(true);

  // Enter TUI mode
  screen.enter();

  // Show a welcome separator in scroll region
  console.log(chalk.dim('─'.repeat(Math.min(process.stdout.columns || 80, 60))));
  console.log('');

  return new Promise<void>((resolve) => {
    const handleSubmit = async (text: string) => {
      input.pause();

      // Shell shortcut
      if (text.startsWith('!')) {
        const shellCmd = text.slice(1).trim();
        if (shellCmd) {
          try {
            const output = execSync(shellCmd, {
              cwd: globalOpts?.project || process.cwd(),
              encoding: 'utf-8',
              timeout: 30000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (output.trim()) console.log(output);
          } catch (error: unknown) {
            const e = error as Record<string, unknown>;
            if (e.stdout) console.log(e.stdout);
            if (e.stderr) console.log(chalk.red(String(e.stderr)));
          }
        }
        input.resume();
        return;
      }

      // Slash commands
      if (text.startsWith('/')) {
        if (text === '/exit' || text === '/quit' || text === '/q') {
          terminalOutput.setTUIMode(false);
          screen.leave();
          unpatch();
          console.log('\n再见！\n');
          await cleanupFn();
          resolve();
          return;
        }

        await handleCommand(text, agent);
        input.resume();
        return;
      }

      // Agent run
      screen.updateStatus({ phase: 'thinking' });
      try {
        const result = await agent.run(text);
        if (!result.success && result.error) {
          terminalOutput.error(result.error);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminalOutput.error(message);
      }
      screen.updateStatus({ phase: 'idle' });
      input.resume();
    };

    const handleCancel = () => {
      if (agent.getIsRunning()) {
        agent.cancel();
        console.log(chalk.blue('\n  ⎋ Interrupted'));
        screen.updateStatus({ phase: 'idle' });
        input.resume();
      } else {
        // Ctrl+C at prompt — exit
        screen.leave();
        unpatch();
        console.log('\n再见！\n');
        cleanupFn().then(() => resolve());
      }
    };

    input.start(handleSubmit, handleCancel);

    // Prevent SIGINT from killing the process
    process.on('SIGINT', () => {
      // Handled by InputManager's Ctrl+C handler
    });
  });
}

// Accumulative session stats for status bar
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalCost = 0;
let currentModel = '';

/** Calculate cost for tokens based on model pricing */
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING_PER_1M[model] || MODEL_PRICING_PER_1M['default'];
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

/** Update status bar from agent events */
function updateStatusFromEvent(screen: TUIScreen, event: AgentEvent): void {
  switch (event.type) {
    case 'task_progress':
      if (event.data?.phase === 'thinking') {
        screen.updateStatus({ phase: 'thinking' });
      } else if (event.data?.phase === 'tool_running') {
        screen.updateStatus({ phase: 'running' });
      }
      break;

    case 'model_response': {
      const d = event.data as { model?: string; provider?: string; inputTokens?: number; outputTokens?: number } | undefined;
      if (d?.model) currentModel = d.model;
      if (d?.inputTokens || d?.outputTokens) {
        totalInputTokens += d?.inputTokens || 0;
        totalOutputTokens += d?.outputTokens || 0;
        totalCost += estimateCost(currentModel, d?.inputTokens || 0, d?.outputTokens || 0);
      }
      screen.updateStatus({
        ...(d?.model ? { model: d.model } : {}),
        ...(d?.provider ? { provider: d.provider } : {}),
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cost: totalCost,
      });
      break;
    }

    case 'stream_usage': {
      const su = event.data as { inputTokens?: number; outputTokens?: number } | undefined;
      if (su) {
        totalInputTokens = su.inputTokens || totalInputTokens;
        totalOutputTokens = su.outputTokens || totalOutputTokens;
        totalCost = estimateCost(currentModel, totalInputTokens, totalOutputTokens);
        screen.updateStatus({
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cost: totalCost,
        });
      }
      break;
    }

    case 'task_complete': {
      const tc = event.data as { duration?: number; toolsUsed?: string[] } | undefined;
      screen.updateStatus({
        duration: tc?.duration || 0,
        toolCount: tc?.toolsUsed ? new Set(tc.toolsUsed).size : 0,
        phase: 'idle',
      });
      break;
    }

    case 'task_stats': {
      const ts = event.data as { contextUsage?: number } | undefined;
      if (ts?.contextUsage != null) {
        screen.updateStatus({ contextPercent: ts.contextUsage * 100 });
      }
      break;
    }

    case 'turn_start': {
      const ti = event.data as { iteration?: number } | undefined;
      if (ti?.iteration) {
        screen.updateStatus({ turns: ti.iteration });
      }
      break;
    }

    case 'agent_complete':
      screen.updateStatus({ phase: 'idle' });
      break;
  }
}
