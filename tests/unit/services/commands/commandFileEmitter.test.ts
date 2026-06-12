import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  activateCommandDraft,
  emitCommandFile,
} from '../../../../src/main/services/commands/commandFileEmitter';
import { PromptCommandService } from '../../../../src/main/services/commands/promptCommandService';
import { parsePromptCommandFile } from '../../../../src/shared/commands/promptCommands';

async function makeTmpWorkspace() {
  const wd = await fs.mkdtemp(path.join(os.tmpdir(), 'distill-cmd-'));
  const commandsDir = path.join(wd, '.code-agent', 'commands');
  const draftsDir = path.join(wd, '.code-agent', 'command-drafts');
  return { wd, commandsDir, draftsDir };
}

describe('commandFileEmitter', () => {
  it('active 产出：写入 commands 目录，promptCommandService 现扫即注册可解析调用', async () => {
    const { wd, commandsDir, draftsDir } = await makeTmpWorkspace();

    const result = await emitCommandFile(
      { name: 'deploy-report', description: '生成每周 deploy 报告', body: '为 $1 生成 deploy 报告，输出 markdown。' },
      { draft: false, commandsDir, draftsDir },
    );

    expect(result.activated).toBe(true);
    expect(result.location).toBe(path.join(commandsDir, 'deploy-report.md'));

    // 注册通道验证：promptCommandService 项目目录现扫 → /deploy-report 可真实解析
    const resolution = await new PromptCommandService().resolveInvocation('/deploy-report web-app', wd);
    expect(resolution).not.toBeNull();
    expect(resolution!.source).toBe('file');
    expect(resolution!.prompt).toContain('为 web-app 生成 deploy 报告');
  });

  it('draft 产出：落 command-drafts 目录，不被命令注册通道看到（人不在场不激活）', async () => {
    const { wd, commandsDir, draftsDir } = await makeTmpWorkspace();

    const result = await emitCommandFile(
      { name: 'auto-asset', description: 'auto produced', body: 'do the thing for $ARGUMENTS' },
      { draft: true, commandsDir, draftsDir },
    );

    expect(result.activated).toBe(false);
    expect(result.location).toBe(path.join(draftsDir, 'auto-asset.md'));
    const resolution = await new PromptCommandService().resolveInvocation('/auto-asset x', wd);
    expect(resolution).toBeNull();
  });

  it('重名拒绝：active 目标已存在 → 抛错且原文件内容不变（不静默覆盖）', async () => {
    const { commandsDir, draftsDir } = await makeTmpWorkspace();
    await fs.mkdir(commandsDir, { recursive: true });
    const existingPath = path.join(commandsDir, 'taken.md');
    await fs.writeFile(existingPath, 'ORIGINAL CONTENT', 'utf-8');

    await expect(
      emitCommandFile({ name: 'taken', description: 'd', body: 'b' }, { draft: false, commandsDir, draftsDir }),
    ).rejects.toThrow(/已存在|exists/i);
    expect(await fs.readFile(existingPath, 'utf-8')).toBe('ORIGINAL CONTENT');
  });

  it('draft 与同名 active 命令冲突也拒绝（避免确认激活时撞名）', async () => {
    const { commandsDir, draftsDir } = await makeTmpWorkspace();
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(path.join(commandsDir, 'taken.md'), 'ORIGINAL', 'utf-8');

    await expect(
      emitCommandFile({ name: 'taken', description: 'd', body: 'b' }, { draft: true, commandsDir, draftsDir }),
    ).rejects.toThrow(/已存在|exists/i);
  });

  it('frontmatter 白名单：产出文件只携带 description，注入 agent/model/subtask 的尝试被剥离', async () => {
    const { commandsDir, draftsDir } = await makeTmpWorkspace();

    await emitCommandFile(
      {
        name: 'inject-test',
        description: '描述\nagent: coder\nmodel: ultra',
        body: 'normal body',
      },
      { draft: false, commandsDir, draftsDir },
    );

    const raw = await fs.readFile(path.join(commandsDir, 'inject-test.md'), 'utf-8');
    const parsed = parsePromptCommandFile('inject-test', raw);
    expect(parsed.agent).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.subtask).toBeUndefined();
    expect(parsed.template).toBe('normal body');
  });

  it('非法 name 拒绝（路径由代码从 sanitize 后的 name 构造，LLM 不控制路径）', async () => {
    const { commandsDir, draftsDir } = await makeTmpWorkspace();
    for (const bad of ['../escape', 'UPPER', 'has space', 'a/b', '']) {
      await expect(
        emitCommandFile({ name: bad, description: 'd', body: 'b' }, { draft: false, commandsDir, draftsDir }),
      ).rejects.toThrow(/名称|name/i);
    }
  });

  it('activateCommandDraft：草稿确认后移入 commands 目录并可解析；目标重名拒绝', async () => {
    const { wd, commandsDir, draftsDir } = await makeTmpWorkspace();
    await emitCommandFile(
      { name: 'pending-cmd', description: 'd', body: 'run for $ARGUMENTS' },
      { draft: true, commandsDir, draftsDir },
    );

    const activated = await activateCommandDraft('pending-cmd', { commandsDir, draftsDir });
    expect(activated.location).toBe(path.join(commandsDir, 'pending-cmd.md'));
    const resolution = await new PromptCommandService().resolveInvocation('/pending-cmd now', wd);
    expect(resolution).not.toBeNull();
    // 草稿已被移走
    await expect(fs.access(path.join(draftsDir, 'pending-cmd.md'))).rejects.toThrow();

    // 目标已存在 → 拒绝
    await emitCommandFile({ name: 'pending2', description: 'd', body: 'b' }, { draft: true, commandsDir, draftsDir });
    await fs.writeFile(path.join(commandsDir, 'pending2.md'), 'ORIGINAL', 'utf-8');
    await expect(activateCommandDraft('pending2', { commandsDir, draftsDir })).rejects.toThrow(/已存在|exists/i);
  });
});
