// ============================================================================
// Init Memory Commands - /init-memory
// 给新项目一键播种记忆草稿：确定性扫描当前工作目录的白名单清单文件
// （package.json / pyproject.toml / go.mod / Cargo.toml / Makefile / README 与
// 顶层目录名），产出技术栈 / 目录结构 / 常用命令 / README 定位四类 project
// 候选记忆，进 Light Memory 等人工 review——与 /init（写 CLAUDE.md 的
// prompt 模板命令）互补，互不改写。
//
// CLI surface: ctx.loadProjectMemoryDrafter 注入 host 的 runProjectMemoryDraft。
// GUI surface: renderer 包装模块走 memory 域 IPC（memoryInitProjectDraft）。
// ============================================================================

import type { ProjectMemoryDraftResult, ProjectMemoryDraftTopic } from '../../contract/memory';
import type { CommandContext, CommandDefinition, CommandResult } from '../types';
import { loadCommandPort } from '../loadCommandPort';

const SKIPPED_REASON_LABELS: Record<ProjectMemoryDraftResult['skipped'][number]['reason'], string> = {
  'existing-key': '同键记忆已存在，未覆盖',
  'source-absent': '来源缺失',
};

const TOPIC_LABELS: Record<ProjectMemoryDraftTopic, string> = {
  'tech-stack': '技术栈',
  'directory-layout': '目录结构',
  'common-commands': '常用命令',
  'readme-purpose': '项目定位',
};

function formatDraftResult(result: ProjectMemoryDraftResult): string {
  const skippedLines = result.skipped.map((item) => {
    const label = SKIPPED_REASON_LABELS[item.reason];
    return `  - ${TOPIC_LABELS[item.topic]}：${label}`;
  });
  return [
    `/init-memory 完成：写入 ${result.written} 条候选记忆，跳过 ${result.skipped.length} 条主题。`,
    ...(skippedLines.length > 0 ? ['跳过明细：', ...skippedLines] : []),
    '候选记忆需在记忆管理中人工确认后才会生效。',
  ].join('\n');
}

async function runViaCliSurface(ctx: CommandContext, projectDir: string): Promise<ProjectMemoryDraftResult> {
  const { runProjectMemoryDraft } = await loadCommandPort<{
    runProjectMemoryDraft: (projectDir: string) => Promise<ProjectMemoryDraftResult>;
  }>(ctx, 'loadProjectMemoryDrafter');
  return runProjectMemoryDraft(projectDir);
}

async function runViaGuiSurface(): Promise<ProjectMemoryDraftResult> {
  // 通过 renderer-only 包装模块走 IPC，避免把 ipcService 作为无效 dynamic import 打进主包。
  const { initProjectMemoryViaGuiSurface } = await import('../../../renderer/services/memoryGuiSurface');
  return initProjectMemoryViaGuiSurface();
}

// 仅导出数组（index.ts 注册消费）；单条定义经 registry.get('init-memory') 取用，
// 避免生产图里出现只有测试引用的 dead export。
const initMemoryCommand: CommandDefinition = {
  id: 'init-memory',
  name: '初始化项目记忆',
  description: '扫描当前项目生成记忆候选（技术栈/目录/常用命令/README 定位），需人工确认后生效',
  category: 'system',
  surfaces: ['cli', 'gui'],
  handler: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const agent = ctx.agent as
        | { getConfig?: () => { workingDirectory?: string } }
        | undefined;
      const projectDir = ctx.surface === 'cli'
        ? agent?.getConfig?.().workingDirectory || process.cwd()
        : '';
      const result = ctx.surface === 'cli'
        ? await runViaCliSurface(ctx, projectDir)
        : await runViaGuiSurface();
      ctx.output.info(formatDraftResult(result));
      return { success: true, data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.output.error(`/init-memory 失败：${msg}`);
      return { success: false, message: msg };
    }
  },
};

export const initMemoryCommands: CommandDefinition[] = [initMemoryCommand];

