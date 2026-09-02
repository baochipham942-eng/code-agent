import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/eval-harness-gate.yml');
const rendererPluginSignal = 'slots/|SlotHost';
const coverageRule = '你的文件 import 了 slots/ 或渲染了任一 *SlotHost，或 E2E 断言了你文件里的字符串/testid ⇒ 必须补进 pull_request.paths 和 push.paths 两处';

type TriggerEvent = 'pull_request' | 'push';

interface WorkflowTrigger {
  paths?: unknown;
}

interface WorkflowDocument {
  on?: Partial<Record<TriggerEvent, WorkflowTrigger>>;
}

function workflowPaths(event: TriggerEvent): string[] {
  let workflow: WorkflowDocument;
  try {
    workflow = parseYaml(fs.readFileSync(workflowPath, 'utf8')) as WorkflowDocument;
  } catch (error) {
    throw new Error(`盲区：${workflowPath} 解析失败，插件门无法判定 paths`, { cause: error });
  }

  const paths = workflow.on?.[event]?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((entry) => typeof entry !== 'string')) {
    throw new Error(`盲区：on.${event}.paths 缺失、为空或不是字符串清单`);
  }
  return paths as string[];
}

function isTestFile(file: string): boolean {
  return file.includes('/__tests__/') || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);
}

function rendererPluginFiles(): string[] {
  const grep = spawnSync(
    'git',
    ['grep', '--no-index', '-l', '-E', rendererPluginSignal, '--', 'src/renderer'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const output = grep.stdout.trim();
  if ((grep.status === 1 && output.length === 0) || output.length === 0) {
    throw new Error(`盲区：git grep -l 没有扫到任何 renderer 插件座位宿主（匹配式：${rendererPluginSignal}）`);
  }
  if (grep.status !== 0) {
    throw new Error(`盲区：git grep -l 扫描 renderer 失败：${grep.stderr.trim() || `exit ${grep.status}`}`);
  }

  const files = output
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => !file.startsWith('src/renderer/slots/'))
    .filter((file) => !isTestFile(file))
    .sort();
  if (files.length === 0) {
    throw new Error('盲区：git grep -l 的命中在排除 slots/ 与测试后为空，没有实际宿主可守');
  }
  return files;
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true }));
}

function expectCoveredByBothEvents(file: string): void {
  for (const event of ['pull_request', 'push'] as const) {
    expect(
      matchesAny(file, workflowPaths(event)),
      `${file} 未被 on.${event}.paths 命中。${coverageRule}`,
    ).toBe(true);
  }
}

describe('eval harness plugin lifecycle paths', () => {
  it('从 renderer 座位引用与 SlotHost 渲染点推导受影响文件', () => {
    for (const file of rendererPluginFiles()) expectCoveredByBothEvents(file);
  });

  it('不命中无关 renderer 组件与文档', () => {
    const unrelatedFiles = [
      'src/renderer/components/features/voice/VoiceChrome.tsx',
      'docs/ARCHITECTURE.md',
    ];
    for (const event of ['pull_request', 'push'] as const) {
      const paths = workflowPaths(event);
      for (const file of unrelatedFiles) {
        expect(matchesAny(file, paths), `${file} 不应被 on.${event}.paths 命中`).toBe(false);
      }
    }
  });

  it('回放 PR #1563 的九个座位落地文件', () => {
    const pr1563Files = [
      'src/renderer/App.tsx',
      'src/renderer/components/features/capabilityHub/CapabilityHubPage.tsx',
      'src/renderer/components/features/chat/TurnBasedTraceView.tsx',
      'src/renderer/components/features/settings/SettingsModal.tsx',
      'src/renderer/components/features/sidebar/SidebarAccountMenu.tsx',
      'src/renderer/slots/productSlotHosts.tsx',
      'src/renderer/utils/settingsTabs.ts',
      'tests/renderer/components/secondaryPagesNavigationContract.test.ts',
      'tests/renderer/slots/productSlotHosts.test.tsx',
    ];
    for (const file of pr1563Files) expectCoveredByBothEvents(file);
  });
});
