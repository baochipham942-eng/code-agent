// ============================================================================
// cronWriteGrant 单测（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1 ①/②）：
//   - isPathWithinWriteGrantRoot：界内 / 出界 / `..` 逃逸 / 软链逃逸 / 相对路径 / 根不存在
//   - approveByScheduleWriteGrant：cron/heartbeat 来源 + 授权 + file_write/file_edit + 界内
//     才放行；非 cron 来源、无授权、forceConfirm、其余类型一律 undefined（照旧停车）
//   - grant/revoke 落库与幂等、无文件夹抛 CRON_WRITE_SCOPE_NO_FOLDER
//   - stripWriteGrantRoot（createJob 元数据防线）
// 真实文件系统（tmpdir + 真软链），sessionManager 用注入 mock。
// ============================================================================
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionState = vi.hoisted(() => ({
  sessions: {} as Record<string, { id: string; origin?: { kind: string; metadata?: Record<string, unknown> }; workingDirectory?: string } | undefined>,
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async (id: string) => sessionState.sessions[id] ?? null,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  approveByScheduleWriteGrant,
  grantCronWriteScope,
  revokeCronWriteScope,
  stripWriteGrantRoot,
} from '../../../src/host/cron/cronWriteGrant';
import { CRON_WRITE_SCOPE_NO_FOLDER } from '../../../src/shared/cronWriteScope';
import { PermissionRequestReason } from '../../../src/shared/contract/permission';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

let grantRoot: string;

beforeEach(() => {
  grantRoot = mkdtempSync(path.join(os.tmpdir(), 'neo-write-grant-'));
  sessionState.sessions = {};
});

afterEach(() => {
  rmSync(grantRoot, { recursive: true, force: true });
});

/** 判界走生产消费口 approveByScheduleWriteGrant（isPathWithinWriteGrantRoot 是模块私有）。 */
async function grantAllows(target: string, root: string): Promise<boolean> {
  sessionState.sessions['grant-sess'] = {
    id: 'grant-sess',
    origin: { kind: 'cron', metadata: { writeGrantRoot: root } },
  };
  const result = await approveByScheduleWriteGrant({
    sessionId: 'grant-sess', type: 'file_write', details: { path: target },
  });
  return result?.approved === true;
}

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-1',
    name: '写日志任务',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action: { type: 'agent', agentType: 'default', prompt: '写一条日志' },
    runsOn: 'local',
    enabled: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeHost(definition: CronJobDefinition) {
  const active = { definition: { ...definition } };
  const persisted: CronJobDefinition[] = [];
  return {
    active,
    persisted,
    host: {
      loadActiveJob: (jobId: string) => (jobId === definition.id ? active : undefined),
      persistJob: async (job: CronJobDefinition) => { persisted.push(job); },
    },
  };
}

describe('判界 isPathWithinWriteGrantRoot（经生产消费口 approveByScheduleWriteGrant）', () => {
  it('界内目标（含尚未存在的新文件）放行', async () => {
    expect(await grantAllows(path.join(grantRoot, 'note.txt'), grantRoot)).toBe(true);
    mkdirSync(path.join(grantRoot, 'sub'));
    expect(await grantAllows(path.join(grantRoot, 'sub', 'deep.md'), grantRoot)).toBe(true);
    // 根本身也算界内（直接写目录级元数据）
    expect(await grantAllows(grantRoot, grantRoot)).toBe(true);
  });

  it('出界目标不放行', async () => {
    expect(await grantAllows(path.join(path.dirname(grantRoot), 'outside.txt'), grantRoot)).toBe(false);
  });

  it('`..` 拼接逃逸归一后不放行', async () => {
    expect(await grantAllows(path.join(grantRoot, '..', 'escape.txt'), grantRoot)).toBe(false);
    expect(await grantAllows(`${grantRoot}/../../etc/passwd`, grantRoot)).toBe(false);
  });

  it('软链逃逸（界内软链指向界外真实目录）不放行', async () => {
    const outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'neo-write-grant-out-'));
    try {
      const linkPath = path.join(grantRoot, 'link-out');
      symlinkSync(outsideRoot, linkPath);
      // 目标文件还不存在：missing-tail realpath 也要沿软链解析到界外
      expect(await grantAllows(path.join(linkPath, 'stolen.txt'), grantRoot)).toBe(false);
      // 界外真实文件已存在时同样不放行
      const realFile = path.join(outsideRoot, 'real.txt');
      writeFileSync(realFile, 'x');
      expect(await grantAllows(realFile, grantRoot)).toBe(false);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('界内软链（指向界内目录）仍算界内', async () => {
    mkdirSync(path.join(grantRoot, 'real-dir'));
    symlinkSync(path.join(grantRoot, 'real-dir'), path.join(grantRoot, 'link-in'));
    expect(await grantAllows(path.join(grantRoot, 'link-in', 'file.txt'), grantRoot)).toBe(true);
  });

  it('相对路径与不存在的授权根 fail-closed 拒', async () => {
    expect(await grantAllows('relative/note.txt', grantRoot)).toBe(false);
    expect(await grantAllows(path.join(grantRoot, 'note.txt'), path.join(grantRoot, 'missing-root'))).toBe(false);
  });
});

describe('approveByScheduleWriteGrant（放行判定矩阵）', () => {
  it('cron 会话 + 授权 + 界内 file_write/file_edit → 放行并自报来源', async () => {
    sessionState.sessions['cron-sess'] = {
      id: 'cron-sess',
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    const writeResult = await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_write', tool: 'Write',
      details: { path: path.join(grantRoot, 'note.txt') },
    });
    expect(writeResult).toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
    const editResult = await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_edit', tool: 'Edit',
      details: { path: path.join(grantRoot, 'note.txt') },
    });
    expect(editResult).toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
  });

  it('heartbeat 来源同样放行；非 cron/heartbeat 来源（channel/chat/无会话）不放行', async () => {
    sessionState.sessions['hb-sess'] = {
      id: 'hb-sess',
      origin: { kind: 'heartbeat', metadata: { writeGrantRoot: grantRoot } },
    };
    sessionState.sessions['channel-sess'] = {
      id: 'channel-sess',
      origin: { kind: 'channel', metadata: { writeGrantRoot: grantRoot } },
    };
    sessionState.sessions['plain-sess'] = { id: 'plain-sess' };
    expect(await approveByScheduleWriteGrant({
      sessionId: 'hb-sess', type: 'file_write', details: { path: path.join(grantRoot, 'a.txt') },
    })).toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
    expect(await approveByScheduleWriteGrant({
      sessionId: 'channel-sess', type: 'file_write', details: { path: path.join(grantRoot, 'a.txt') },
    })).toBeUndefined();
    expect(await approveByScheduleWriteGrant({
      sessionId: 'plain-sess', type: 'file_write', details: { path: path.join(grantRoot, 'a.txt') },
    })).toBeUndefined();
    expect(await approveByScheduleWriteGrant({
      type: 'file_write', details: { path: path.join(grantRoot, 'a.txt') },
    })).toBeUndefined();
  });

  it('无授权 / 授权字段不是绝对路径 → 不放行', async () => {
    sessionState.sessions['ungranted'] = { id: 'ungranted', origin: { kind: 'cron', metadata: {} } };
    sessionState.sessions['junk-grant'] = {
      id: 'junk-grant', origin: { kind: 'cron', metadata: { writeGrantRoot: 'relative/path' } },
    };
    expect(await approveByScheduleWriteGrant({
      sessionId: 'ungranted', type: 'file_write', details: { path: path.join(grantRoot, 'a.txt') },
    })).toBeUndefined();
    expect(await approveByScheduleWriteGrant({
      sessionId: 'junk-grant', type: 'file_write', details: { path: 'relative/path/a.txt' },
    })).toBeUndefined();
  });

  it('forceConfirm、Bash/其余类型、出界/`..`/软链逃逸 → 一律不放行（照旧停车）', async () => {
    sessionState.sessions['cron-sess'] = {
      id: 'cron-sess',
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    expect(await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_write', forceConfirm: true,
      details: { path: path.join(grantRoot, 'a.txt') },
    })).toBeUndefined();
    expect(await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'command', tool: 'Bash',
      details: { command: `echo hi > ${path.join(grantRoot, 'a.txt')}` },
    })).toBeUndefined();
    expect(await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_write',
      details: { path: path.join(path.dirname(grantRoot), 'out.txt') },
    })).toBeUndefined();
    expect(await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_write',
      details: { path: path.join(grantRoot, '..', 'escape.txt') },
    })).toBeUndefined();
    const outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'neo-write-grant-out-'));
    try {
      symlinkSync(outsideRoot, path.join(grantRoot, 'link-out'));
      expect(await approveByScheduleWriteGrant({
        sessionId: 'cron-sess', type: 'file_write',
        details: { path: path.join(grantRoot, 'link-out', 'stolen.txt') },
      })).toBeUndefined();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('forceConfirm 的 W3 写边界形态（reasonCode=file_write_outside_workspace）在界内放行', async () => {
    sessionState.sessions['cron-sess'] = {
      id: 'cron-sess',
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    // cron runContext 无 workspace 权威时一切写都带这条边界 ask（e2e 实证），
    // 授权预先回答的就是它。
    expect(await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_write', forceConfirm: true,
      reasonCode: PermissionRequestReason.FileWriteOutsideWorkspace,
      details: { path: path.join(grantRoot, 'note.txt') },
    })).toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
    // 其余 reasonCode 的 forceConfirm 不归授权管
    expect(await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_write', forceConfirm: true,
      reasonCode: PermissionRequestReason.UncertainWriteTargetWithPathDeny,
      details: { path: path.join(grantRoot, 'note.txt') },
    })).toBeUndefined();
  });

  it('保护路径（~/.npmrc 等约束自改写目标）即使落在授权文件夹内也不放行', async () => {
    // 用真实家目录当授权根（锚点按真实 HOME 解析，改 env 会撞锚点缓存）：
    // 模拟「授权根 = 家目录」的退化授权，home 锚点文件落在界内但必须照旧人工。
    // 只做路径判定，不真写任何文件。isProtectedWritePath 的清单是数据目录策略文件 +
    // projectRoot git 配置 + ~/.gitconfig / ~/.npmrc（~/.ssh 属另一套沙盒清单）。
    const homeGrantRoot = realpathSync(os.homedir());
    sessionState.sessions['cron-sess'] = {
      id: 'cron-sess',
      origin: { kind: 'cron', metadata: { writeGrantRoot: homeGrantRoot } },
    };
    expect(await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_write',
      details: { path: path.join(homeGrantRoot, '.npmrc') },
    })).toBeUndefined();
    expect(await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_write',
      details: { path: path.join(homeGrantRoot, '.gitconfig') },
    })).toBeUndefined();
    // 同一根下的普通文件仍放行（保护排除没有殃及池鱼）
    expect(await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_write',
      details: { path: path.join(homeGrantRoot, 'plain-note.txt') },
    })).toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
  });

  it('无 details.path / filePath 的 file_write（连接器写回载荷）不放行', async () => {
    sessionState.sessions['cron-sess'] = {
      id: 'cron-sess',
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    expect(await approveByScheduleWriteGrant({
      sessionId: 'cron-sess', type: 'file_write', details: { url: 'https://x.example', method: 'POST' },
    })).toBeUndefined();
  });
});

describe('grant / revoke 落库', () => {
  it('授权解析来源会话工作目录为绝对路径并写 metadata.writeGrantRoot', async () => {
    sessionState.sessions['src-sess'] = { id: 'src-sess', workingDirectory: grantRoot };
    const job = makeJob({ action: { type: 'agent', agentType: 'default', prompt: '写一条日志', context: { sourceSessionId: 'src-sess' } } });
    const { active, persisted, host } = makeHost(job);
    const updated = await grantCronWriteScope('job-1', host);
    expect(updated?.metadata?.writeGrantRoot).toBe(grantRoot);
    expect(active.definition.metadata?.writeGrantRoot).toBe(grantRoot);
    expect(persisted).toHaveLength(1);
    // 幂等：已授权不重复解析落库
    await grantCronWriteScope('job-1', host);
    expect(persisted).toHaveLength(1);
  });

  it('常设刷新任务取产物所在目录（与运行会话工作目录同源）', async () => {
    const artifactPath = path.join(grantRoot, 'report.md');
    const job = makeJob({
      metadata: { artifactRefresh: { path: artifactPath, instruction: '刷新', cadence: 'daily' } },
    });
    const { host } = makeHost(job);
    const updated = await grantCronWriteScope('job-1', host);
    expect(updated?.metadata?.writeGrantRoot).toBe(grantRoot);
  });

  it('解析不出工作文件夹抛 CRON_WRITE_SCOPE_NO_FOLDER', async () => {
    const { host } = makeHost(makeJob());
    await expect(grantCronWriteScope('job-1', host)).rejects.toThrow(CRON_WRITE_SCOPE_NO_FOLDER);
  });

  it('撤销摘掉字段；未授权时幂等返回当前定义', async () => {
    sessionState.sessions['src-sess'] = { id: 'src-sess', workingDirectory: grantRoot };
    const job = makeJob({ metadata: { sourceSessionId: 'src-sess', otherFlag: true } });
    const { host } = makeHost(job);
    await grantCronWriteScope('job-1', host);
    const revoked = await revokeCronWriteScope('job-1', host);
    expect(revoked?.metadata).toEqual({ sourceSessionId: 'src-sess', otherFlag: true });
    await revokeCronWriteScope('job-1', host); // 未授权再撤销不落库、不报错
    const missing = await revokeCronWriteScope('nope', host);
    expect(missing).toBeNull();
  });
});

describe('stripWriteGrantRoot（创建防线）', () => {
  it('剥掉外部载荷夹带的授权字段，其余 metadata 原样保留', () => {
    expect(stripWriteGrantRoot({ writeGrantRoot: '/tmp/evil', keep: 1 })).toEqual({ keep: 1 });
    expect(stripWriteGrantRoot({ keep: 1 })).toEqual({ keep: 1 });
    expect(stripWriteGrantRoot(undefined)).toBeUndefined();
    expect(stripWriteGrantRoot({ writeGrantRoot: '/tmp/evil' })).toBeUndefined();
  });
});
