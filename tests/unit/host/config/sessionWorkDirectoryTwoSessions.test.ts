// ============================================================================
// N-FIX-DELIVERABLE-FOLDER-WRONG-SESSION：两个无文件夹聊天必须各自拿到自己的产出目录。
// 根因：renderer 新建会话默认继承全局当前工作目录，而上一个聊天首轮规划出的
// 任务_MMDD_<标题> 会被回写成这个全局值，新会话带着它创建 → 共用别人的目录。
// 入口过滤 dropForeignPlannedSessionWorkDirectory + 规划/重规划/撞名改道串起来，
// 用一张内存「会话表」模拟会话行回写，覆盖：并发、前一个已落盘、标题后到、改道。
// ============================================================================
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => new Map<string, string | undefined>());

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    listRecordedWorkingDirectories: (except?: string) =>
      [...rows.entries()].filter(([id]) => id !== except).map(([, dir]) => dir ?? ''),
  }),
}));

import {
  materializeSessionWorkDirectory,
  maybeDivertCollidingSessionWorkDirectory,
  maybeReplanSessionWorkDirectory,
  planSessionWorkDirectory,
} from '../../../../src/host/config/sessionWorkDirectory';
import {
  dropForeignPlannedSessionWorkDirectory,
  listSessionWorkDirectoryReservations,
} from '../../../../src/host/config/sessionWorkDirectoryReservations';

describe('two folderless chats get distinct work directories', () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    rows.clear();
    tempHome = await mkdtemp(path.join(tmpdir(), 'neo-two-sessions-'));
    env = { ...process.env, HOME: tempHome, USERPROFILE: tempHome, CODE_AGENT_DATA_DIR: path.join(tempHome, 'data') };
  });
  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  /** 模拟「新建会话 → 首轮 preflight 规划 → 回写会话行」 */
  async function startChat(id: string, inherited: string | undefined, title: string): Promise<string> {
    const created = await dropForeignPlannedSessionWorkDirectory(inherited, { env });
    rows.set(id, created);
    if (created) return created;
    const reservedPaths = await listSessionWorkDirectoryReservations({ env, exceptSessionId: id });
    const planned = await planSessionWorkDirectory({ sessionTitle: title, userMessage: title, env, reservedPaths });
    rows.set(id, planned);
    return planned;
  }

  it('B created while the app-level directory is still A\'s planned folder plans its own (A on disk)', async () => {
    const a = await startChat('A', undefined, '写一篇文章');
    await materializeSessionWorkDirectory(a);
    const b = await startChat('B', a, '写一篇文章');
    expect(b).not.toBe(a);
    expect(path.dirname(b)).toBe(path.dirname(a));
  });

  it('same, with A\'s folder never materialized (pure Q&A so far)', async () => {
    const a = await startChat('A', undefined, '写一篇文章');
    const b = await startChat('B', a, '写一篇文章');
    expect(b).not.toBe(a);
  });

  it('two concurrent first turns with the same title plan different folders', async () => {
    const [a, b] = await Promise.all([
      startChat('A', undefined, '写一篇文章'),
      startChat('B', undefined, '写一篇文章'),
    ]);
    expect(a).not.toBe(b);
  });

  it('replan by a late smart title never lands on another session\'s folder', async () => {
    const a = await startChat('A', undefined, '写一篇文章');
    const b = await startChat('B', a, '整理会议纪要');
    const replannedA = await maybeReplanSessionWorkDirectory({
      workingDirectory: a,
      sessionTitle: '整理会议纪要',
      reservedPaths: await listSessionWorkDirectoryReservations({ env, exceptSessionId: 'A' }),
      env,
    });
    if (replannedA) rows.set('A', replannedA);
    expect(rows.get('A')).not.toBe(rows.get('B'));
    expect(b).not.toBe(a);
  });

  it('divert moves a not-yet-materialized shared row to a free name, leaving the other session\'s alone', async () => {
    const shared = await planSessionWorkDirectory({ sessionTitle: '写一篇文章', env });
    rows.set('A', shared);
    rows.set('B', shared);
    const diverted = await maybeDivertCollidingSessionWorkDirectory({
      workingDirectory: shared,
      reservedPaths: await listSessionWorkDirectoryReservations({ env, exceptSessionId: 'B' }),
      env,
    });
    expect(diverted).toBeDefined();
    expect(diverted).not.toBe(shared);
  });

  it('keeps a user-chosen ordinary project folder and an unrecorded planned folder', async () => {
    const project = path.join(tempHome, 'my-project');
    rows.set('A', project);
    await expect(dropForeignPlannedSessionWorkDirectory(project, { env })).resolves.toBe(project);
    const planned = await planSessionWorkDirectory({ sessionTitle: '孤儿目录', env });
    await expect(dropForeignPlannedSessionWorkDirectory(planned, { env })).resolves.toBe(planned);
    await expect(dropForeignPlannedSessionWorkDirectory(undefined, { env })).resolves.toBeUndefined();
  });
});
