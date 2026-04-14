// ============================================================================
// Init Soul Command — scaffold SOUL.md / PROFILE.md templates
// ============================================================================
// 把 soulTemplates.ts 里的默认模板写到 ~/.code-agent/SOUL.md
// 或 <project>/.code-agent/PROFILE.md，首次定制人格/项目上下文时使用。
// ============================================================================

import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';

interface InitSoulOptions {
  dir?: string;
  force?: boolean;
  profileOnly?: boolean;
}

export const initSoulCommand = new Command('init-soul')
  .description('生成 SOUL.md / PROFILE.md 模板（Agent 人格与项目上下文）')
  // 注：不用 -p / --project，避免和全局 `program.option('-p, --project')` 冲突
  .option('-d, --dir <path>', '同时在指定目录创建项目级 PROFILE.md（默认当前工作目录）')
  .option('-f, --force', '覆盖已存在的文件')
  .option('--profile-only', '仅创建项目级 PROFILE.md，跳过用户级 SOUL.md')
  .action(async (opts: InitSoulOptions) => {
    try {
      const { SOUL_TEMPLATE, PROFILE_TEMPLATE } = await import(
        '../../main/prompts/templates/soulTemplates'
      );
      const { getUserConfigDir, getProjectConfigDir, ensureUserConfigDir, ensureConfigDir } =
        await import('../../main/config/configPaths');

      const results: Array<{ path: string; status: 'created' | 'skipped' | 'overwritten' }> = [];

      // 1. 用户级 SOUL.md
      if (!opts.profileOnly) {
        await ensureUserConfigDir();
        const soulPath = path.join(getUserConfigDir(), 'SOUL.md');
        const status = await writeTemplateFile(soulPath, SOUL_TEMPLATE, opts.force === true);
        results.push({ path: soulPath, status });
      }

      // 2. 项目级 PROFILE.md（显式 --dir 或 --profile-only 时创建）
      if (opts.dir !== undefined || opts.profileOnly) {
        const projectDir = opts.dir ?? process.cwd();
        const resolvedProjectDir = path.resolve(projectDir);
        await ensureConfigDir(resolvedProjectDir);
        const profilePath = path.join(getProjectConfigDir(resolvedProjectDir), 'PROFILE.md');
        const status = await writeTemplateFile(profilePath, PROFILE_TEMPLATE, opts.force === true);
        results.push({ path: profilePath, status });
      }

      // 打印结果
      for (const r of results) {
        const marker =
          r.status === 'created' ? '✓' : r.status === 'overwritten' ? '↻' : '·';
        const label =
          r.status === 'created'
            ? '已创建'
            : r.status === 'overwritten'
              ? '已覆盖'
              : '已存在（跳过，使用 -f 覆盖）';
        process.stdout.write(`  ${marker} ${r.path}  ${label}\n`);
      }

      process.stdout.write(
        '\n修改后会自动热重载，无需重启 Code Agent。\n' +
          '• SOUL.md 控制跨项目的"我是谁"\n' +
          '• PROFILE.md 控制当前项目的上下文约束\n',
      );
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`init-soul failed: ${message}\n`);
      process.exit(1);
    }
  });

async function writeTemplateFile(
  targetPath: string,
  content: string,
  force: boolean,
): Promise<'created' | 'skipped' | 'overwritten'> {
  const exists = await fileExists(targetPath);
  if (exists && !force) {
    return 'skipped';
  }
  await fs.writeFile(targetPath, content, 'utf-8');
  return exists ? 'overwritten' : 'created';
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
