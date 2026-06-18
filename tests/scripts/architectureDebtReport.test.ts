import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function runDebtReport(args: string[] = []) {
  return spawnSync('node', ['scripts/architecture-debt-report.mjs', ...args], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DEBT_REPORT_SKIP_ESLINT: '1',
    },
    encoding: 'utf8',
  });
}

describe('architecture debt report', () => {
  it('prints the core architecture debt sections in human mode', () => {
    const result = runDebtReport(['--skip-eslint', '--limit', '3']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Architecture Debt Report');
    expect(result.stdout).toContain('Large files');
    expect(result.stdout).toContain('Physical > limit:');
    expect(result.stdout).toContain('Effective > limit and not whitelisted:');
    expect(result.stdout).toContain('Any debt');
    expect(result.stdout).toContain('no-unsafe ESLint hotspots');
    expect(result.stdout).toContain('skipped');
  });

  it('emits JSON with large-file and any-debt metrics', () => {
    const result = runDebtReport(['--json', '--skip-eslint', '--limit', '5']);

    expect(result.status).toBe(0);

    const report = JSON.parse(result.stdout) as {
      sourceFileCount: number;
      topLargeFiles: Array<{
        path: string;
        physicalLines: number;
        effectiveLines: number;
        inGodFileWhitelist: boolean;
      }>;
      maxLines: {
        effectiveOverLimitNotWhitelisted: string[];
        whitelistCount: number;
      };
      anyDebt: {
        noExplicitAnyDisableCount: number;
        asAnyCount: number;
      };
      eslintNoUnsafe: {
        skipped: boolean;
      };
    };

    expect(report.sourceFileCount).toBeGreaterThan(0);
    expect(report.topLargeFiles.length).toBeGreaterThan(0);
    expect(report.topLargeFiles.every((file) => file.physicalLines > 1000 || file.effectiveLines > 1000)).toBe(true);
    expect(report.topLargeFiles.every((file) => file.path.startsWith('src/'))).toBe(true);
    expect(report.maxLines.whitelistCount).toBeGreaterThanOrEqual(0);
    expect(report.maxLines.effectiveOverLimitNotWhitelisted).toEqual([
      'src/cli/database.ts',
      'src/main/agent/runtime/contextAssembly/inference.ts',
      'src/main/agent/runtime/conversationRuntime.ts',
      'src/main/agent/subagentExecutor.ts',
      'src/main/ipc/workspace.ipc.ts',
      'src/main/services/core/configService.ts',
      'src/main/services/core/repositories/SessionRepository.ts',
      'src/main/services/skills/builtinSkills.ts',
      'src/main/telemetry/telemetryStorage.ts',
      'src/renderer/components/Sidebar.tsx',
      'src/renderer/components/WorkspacePreviewPanel.tsx',
      'src/renderer/components/features/chat/ChatInput/index.tsx',
      'src/renderer/components/features/chat/MessageBubble/MessageContent.tsx',
      'src/renderer/components/features/settings/tabs/ModelSettings.tsx',
    ]);
    expect(report.anyDebt.noExplicitAnyDisableCount).toBeGreaterThan(0);
    expect(report.anyDebt.asAnyCount).toBeGreaterThan(0);
    expect(report.eslintNoUnsafe.skipped).toBe(true);
  });

  it('is wired into package scripts', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['debt:report']).toBe('node scripts/architecture-debt-report.mjs');
  });
});
