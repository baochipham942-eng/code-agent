import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { setHookEnabled } from '../../../src/host/ipc/hook.ipc';
import { makeHookKey } from '../../../src/host/hooks/configParser';

function writeConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-toggle-'));
  const filePath = join(dir, 'hooks.json');
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8');
  return filePath;
}

const SESSION_START_HOOK = { type: 'command' as const, command: '~/.code-agent/hooks/memory-loader.sh', timeout: 5000 };

describe('setHookEnabled', () => {
  it('停用只加一个字段，其余配置原样保留', async () => {
    const filePath = writeConfig({
      SessionStart: [{ hooks: [SESSION_START_HOOK] }],
    });
    const key = makeHookKey('SessionStart', SESSION_START_HOOK);

    expect(await setHookEnabled(filePath, key, false)).toEqual({ matched: 1 });

    const after = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(after.SessionStart[0].hooks[0]).toEqual({ ...SESSION_START_HOOK, disabled: true });

    // 重新启用要把字段删掉，不是写 false——留着 false 等于给配置文件积垃圾
    await setHookEnabled(filePath, key, true);
    expect(JSON.parse(readFileSync(filePath, 'utf-8')).SessionStart[0].hooks[0]).toEqual(SESSION_START_HOOK);
  });

  it('找不到目标就报错，不静默写回一份没改动的配置', async () => {
    const filePath = writeConfig({ SessionStart: [{ hooks: [SESSION_START_HOOK] }] });

    await expect(setHookEnabled(filePath, 'SessionStart::command::别的脚本.sh', false))
      .rejects.toThrow(/没找到这条 hook/);
  });

  it('拒绝写 legacy settings.json（那份格式不一样，写了会毁配置）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-legacy-'));
    const filePath = join(dir, 'settings.json');
    writeFileSync(filePath, '{"hooks":{}}', 'utf-8');

    await expect(setHookEnabled(filePath, 'x', false)).rejects.toThrow(/hooks\.json/);
  });
});
