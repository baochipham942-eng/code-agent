import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let root: string;
let oldDir: string;
let newDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'late-data-dir-'));
  oldDir = path.join(root, 'old');
  newDir = path.join(root, 'new');
  await mkdir(oldDir);
  await mkdir(newDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', oldDir);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

describe('用户数据目录调用时绑定', () => {
  it('background tasks 的写入、读取和删除跟随切换后的目录', async () => {
    const tasks = await import('../../../src/host/tools/shell/backgroundTasks');
    // 本例只验证持久化 API；移除本次 import 注册的退出写盘回调。
    process.removeListener('beforeExit', tasks.persistRunningTasks);
    vi.stubEnv('CODE_AGENT_DATA_DIR', newDir);
    tasks.persistRunningTasks();
    expect(JSON.parse(await readFile(path.join(newDir, 'background-tasks.json'), 'utf8'))).toEqual([]);
    expect(await readdir(oldDir)).toEqual([]);
    await writeFile(path.join(newDir, 'background-tasks.json'), JSON.stringify([{
      taskId: 'test-task', command: 'echo test', cwd: root, startTime: 1,
      outputFile: path.join(root, 'task.log'), status: 'running',
    }]));
    expect(tasks.loadPersistedTasks()).toEqual([expect.objectContaining({ taskId: 'test-task', status: 'failed' })]);
    tasks.clearPersistedTasks();
    expect(await readdir(newDir)).toEqual([]);
  });

  it('openchronicle settings 在 import 后切换目录仍正确读写', async () => {
    const supervisor = await import('../../../src/host/services/external/openchronicleSupervisor');
    const defaults = await supervisor.loadSettings();
    vi.stubEnv('CODE_AGENT_DATA_DIR', newDir);
    await supervisor.saveSettings({ ...defaults, enabled: true });
    expect(JSON.parse(await readFile(path.join(newDir, 'openchronicle-settings.json'), 'utf8')))
      .toMatchObject({ enabled: true });
    expect(await supervisor.loadSettings()).toMatchObject({ enabled: true });
    expect(await readdir(oldDir)).toEqual([]);
  });

  it('已构造的默认 session cache 下一次落盘写入新目录', async () => {
    const { getDefaultCache, SessionLocalCache } = await import('../../../src/host/session/localCache');
    const cache = getDefaultCache();
    const explicitPath = path.join(root, 'explicit.json');
    const explicit = new SessionLocalCache({ persistPath: explicitPath });
    vi.stubEnv('CODE_AGENT_DATA_DIR', newDir);
    await cache.persist();
    expect(await readFile(path.join(newDir, 'cache/sessions/sessions.json'), 'utf8')).toBe('{}');
    expect(await readdir(oldDir)).toEqual([]);
    await explicit.persist();
    expect(await readFile(explicitPath, 'utf8')).toBe('{}');
  });
});
