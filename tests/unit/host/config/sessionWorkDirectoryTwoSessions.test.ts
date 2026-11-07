// ============================================================================
// N-FIX-DELIVERABLE-FOLDER-WRONG-SESSION：两个无文件夹聊天必须各自拿到自己的产出目录。
// renderer 新建普通会话必须传空目录，然后由这里的规划/重规划/撞名改道链路
// 为每个会话分配独立的 任务_MMDD_<标题> 目录。用一张内存「会话表」
// 模拟会话行回写，覆盖：并发、前一个已落盘、标题后到、改道。
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
  async function startChat(id: string, title: string): Promise<string> {
    rows.set(id, undefined);
    const reservedPaths = await listSessionWorkDirectoryReservations({ env, exceptSessionId: id });
    const planned = await planSessionWorkDirectory({ sessionTitle: title, userMessage: title, env, reservedPaths });
    rows.set(id, planned);
    return planned;
  }

  it('B starts folderless and plans its own directory while A is already on disk', async () => {
    const a = await startChat('A', '写一篇文章');
    await materializeSessionWorkDirectory(a);
    const b = await startChat('B', '写一篇文章');
    expect(b).not.toBe(a);
    expect(path.dirname(b)).toBe(path.dirname(a));
  });

  it('B starts folderless and plans its own directory while A is only reserved in its session row', async () => {
    const a = await startChat('A', '写一篇文章');
    const b = await startChat('B', '写一篇文章');
    expect(b).not.toBe(a);
  });

  it('two concurrent first turns with the same title plan different folders', async () => {
    const [a, b] = await Promise.all([
      startChat('A', '写一篇文章'),
      startChat('B', '写一篇文章'),
    ]);
    expect(a).not.toBe(b);
  });

  it('replan by a late smart title never lands on another session\'s folder', async () => {
    const a = await startChat('A', '写一篇文章');
    const b = await startChat('B', '整理会议纪要');
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

});
