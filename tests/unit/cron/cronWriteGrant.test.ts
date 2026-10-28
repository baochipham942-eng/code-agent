// ============================================================================
// cronWriteGrant 单测（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1 ①/②）：
//   - isPathWithinWriteGrantRoot：界内 / 出界 / `..` 逃逸 / 软链逃逸 / 相对路径（对会话 cwd 归一）/ 根不存在
//   - approveByScheduleWriteGrant：cron/heartbeat 来源 + 授权 + file_write/file_edit + 界内
//     才放行；非 cron 来源、无授权、forceConfirm、其余类型一律 undefined（照旧停车）
//   - grant/revoke 落库与幂等、无文件夹抛 CRON_WRITE_SCOPE_NO_FOLDER
//   - stripWriteGrantRoot（createJob 元数据防线）
//   - CronService 窄写通道（②）：updateJob/createJob 写不进 writeGrantRoot，
//     只有 grantWriteScope/revokeWriteScope 能写（整合拆分轮自 cronWriteScopeService.test.ts 并入）
//   - Island 放行矩阵（①）：无人值守 cron 会话的界内 file_write/file_edit 在停车分支
//     **之前**被放行；出界/`..`/软链逃逸/forceConfirm/Bash/非 cron 来源照旧停车
//     （整合拆分轮自 scheduleWriteGrant.test.ts 并入，gates:fast 12 文件上限）
// 真实文件系统（tmpdir + 真软链），sessionManager 用注入 mock。
// ============================================================================
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionState = vi.hoisted(() => ({
  sessions: {} as Record<string, { id: string; origin?: { kind: string; metadata?: Record<string, unknown> }; workingDirectory?: string } | undefined>,
}));

const dbState = vi.hoisted(() => ({
  cronRows: [] as unknown[],
  runs: [] as Array<{ sql: string; args: unknown[] }>,
}));

const automationState = vi.hoisted(() => ({
  recordCreated: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
  getBySourceRef: vi.fn(() => null),
  upsert: vi.fn(() => undefined),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async (id: string) => sessionState.sessions[id] ?? null,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  // notifyTaskComplete 供 CronService 窄写通道块消费；notifyNeedsInput 供 Island 块消费。
  notificationService: { notifyTaskComplete: vi.fn(), notifyNeedsInput: vi.fn() },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: (sql: string) => ({
        all: () => (sql.includes('FROM cron_jobs') ? dbState.cronRows : []),
        get: (...args: unknown[]) => (
          sql.includes('MAX(started_at)')
            ? { last_run_at: null }
            : undefined
        ),
        run: (...args: unknown[]) => {
          dbState.runs.push({ sql, args });
          return { changes: 1, lastInsertRowid: 0 };
        },
      }),
    }),
  }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ ui: { language: 'zh' } }),
  }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

import {
  approveByScheduleWriteGrant,
  grantCronWriteScope,
  revokeCronWriteScope,
  stripWriteGrantRoot,
} from '../../../src/host/cron/cronWriteGrant';
import { CronService } from '../../../src/host/cron/cronService';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { resetPermissionModeManager, getPermissionModeManager } from '../../../src/host/permissions/modes';
import { CRON_WRITE_SCOPE_NO_FOLDER } from '../../../src/shared/cronWriteScope';
import { PermissionRequestReason } from '../../../src/shared/contract/permission';
import type { AppSettings, PermissionAskResult } from '../../../src/shared/contract';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

let grantRoot: string;

beforeEach(() => {
  grantRoot = mkdtempSync(path.join(os.tmpdir(), 'neo-write-grant-'));
  sessionState.sessions = {};
});

afterEach(() => {
  resetPermissionModeManager();
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

  it('相对路径目标：有会话工作目录且落界内放行（真模型第一发 Write 的形状），无锚点/出界 fail-closed 拒', async () => {
    // 真跑实证（2026-10-24 GLM 真跑）：模型对 cwd 下的文件写的是相对路径 `today-note.txt`，
    // 不是绝对路径——授权若只认绝对路径，最常见的第一发写必然停车。
    sessionState.sessions['rel-sess'] = {
      id: 'rel-sess',
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
      workingDirectory: grantRoot,
    };
    const relative = await approveByScheduleWriteGrant({
      sessionId: 'rel-sess', type: 'file_write', details: { path: 'today-note.txt' },
    });
    expect(relative).toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
    // `..` 拼接出界的相对路径归一后仍拒
    const relativeEscape = await approveByScheduleWriteGrant({
      sessionId: 'rel-sess', type: 'file_write', details: { path: '../stolen.txt' },
    });
    expect(relativeEscape).toBeUndefined();
    // 会话工作目录在授权界外：相对目标解析后出界拒
    sessionState.sessions['rel-outside'] = {
      id: 'rel-outside',
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
      workingDirectory: path.dirname(grantRoot),
    };
    expect(await approveByScheduleWriteGrant({
      sessionId: 'rel-outside', type: 'file_write', details: { path: 'note.txt' },
    })).toBeUndefined();
    // 无工作目录锚点：不猜落点，fail-closed 拒
    expect(await grantAllows('relative/note.txt', grantRoot)).toBe(false);
    // 不存在的授权根同样拒
    expect(await grantAllows(path.join(grantRoot, 'note.txt'), path.join(grantRoot, 'missing-root'))).toBe(false);
  });

  it('`~/` 前缀目标按执行侧 expandTilde 语义落到真实家目录，不拼进授权根（返修 r1）', async () => {
    // 判据曾把 `~/x` 当相对路径拼进会话 cwd（cron 会话 cwd=授权根）恒判界内放行，
    // 而执行侧 Write/Append 落盘前先 expandTilde 写进真实家目录——授权边界与保护
    // 路径清单被 ~ 前缀整体绕过（ai-review Important）。判据必须与执行侧同一份解析。
    sessionState.sessions['tilde-sess'] = {
      id: 'tilde-sess',
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
      workingDirectory: grantRoot,
    };
    // 家目录在授权根（tmpdir）之外：`~/notes.txt` 解析到家目录 → 出界拒
    expect(await approveByScheduleWriteGrant({
      sessionId: 'tilde-sess', type: 'file_write', details: { path: '~/notes.txt' },
    })).toBeUndefined();
    // 裸 `~` = 家目录本身，同样出界拒
    expect(await approveByScheduleWriteGrant({
      sessionId: 'tilde-sess', type: 'file_write', details: { path: '~' },
    })).toBeUndefined();
    // 授权根=真实家目录的退化授权：`~/.npmrc` 展开后界内，必须仍被保护路径拦下
    const homeGrantRoot = realpathSync(os.homedir());
    sessionState.sessions['tilde-home'] = {
      id: 'tilde-home',
      origin: { kind: 'cron', metadata: { writeGrantRoot: homeGrantRoot } },
      workingDirectory: homeGrantRoot,
    };
    expect(await approveByScheduleWriteGrant({
      sessionId: 'tilde-home', type: 'file_write', details: { path: '~/.npmrc' },
    })).toBeUndefined();
    // 同一形状的普通文件（~ 展开后界内、非保护）照常放行——修复不殃及池鱼
    expect(await approveByScheduleWriteGrant({
      sessionId: 'tilde-home', type: 'file_write', details: { path: '~/plain-note.txt' },
    })).toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
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

describe('CronService 写授权窄写通道（原 cronWriteScopeService.test.ts）', () => {
  // 整合拆分轮（2026-10-28）自独立文件并入：gates:fast 12 文件上限，两个同特性
  // 新测试文件合一。mock 并集对本块无副作用（databaseService 等仅 CronService 消费）。
  let service: CronService;

  beforeEach(() => {
    service = new CronService();
  });

  afterEach(async () => {
    await service.shutdown();
  });

  function agentJob(overrides: Partial<CronJobDefinition> = {}) {
    return {
      name: '写笔记任务',
      scheduleType: 'every' as const,
      schedule: { type: 'every' as const, interval: 1, unit: 'hours' as const },
      action: { type: 'agent' as const, agentType: 'default', prompt: '写一条笔记' },
      runsOn: 'local' as const,
      enabled: false,
      ...overrides,
    };
  }

  it('grant 经来源会话工作目录解析并落 metadata.writeGrantRoot；revoke 摘掉', async () => {
    sessionState.sessions['src'] = { id: 'src', workingDirectory: grantRoot };
    const job = await service.createJob(agentJob({
      action: { type: 'agent', agentType: 'default', prompt: '写一条笔记', context: { sourceSessionId: 'src' } },
    }));
    expect(job.metadata?.writeGrantRoot).toBeUndefined();

    const granted = await service.grantWriteScope(job.id);
    expect(granted?.metadata?.writeGrantRoot).toBe(grantRoot);
    expect(service.getJob(job.id)?.metadata?.writeGrantRoot).toBe(grantRoot);

    const revoked = await service.revokeWriteScope(job.id);
    expect(revoked?.metadata?.writeGrantRoot).toBeUndefined();
    expect(service.getJob(job.id)?.metadata).toBeUndefined();
    expect(await service.grantWriteScope('missing-job')).toBeNull();
  });

  it('解析不出工作文件夹时 grant 抛 CRON_WRITE_SCOPE_NO_FOLDER；常设刷新取产物目录', async () => {
    const plain = await service.createJob(agentJob());
    await expect(service.grantWriteScope(plain.id)).rejects.toThrow(CRON_WRITE_SCOPE_NO_FOLDER);

    const refresh = await service.createJob(agentJob({
      metadata: { artifactRefresh: { path: path.join(grantRoot, 'report.md'), instruction: '刷新', cadence: 'daily' } },
    }));
    const granted = await service.grantWriteScope(refresh.id);
    expect(granted?.metadata?.writeGrantRoot).toBe(grantRoot);
  });

  it('updateJob 不能创建 writeGrantRoot（编辑器全量 metadata 夹带被剥掉）', async () => {
    const job = await service.createJob(agentJob());
    const edited = await service.updateJob(job.id, {
      name: '改过名字',
      metadata: { sourceSessionId: 'src', writeGrantRoot: '/tmp/smuggled' },
    });
    expect(edited?.metadata).toEqual({ sourceSessionId: 'src' });
    expect(service.getJob(job.id)?.metadata?.writeGrantRoot).toBeUndefined();
  });

  it('updateJob 不能改写已有授权值（编辑器回传原值可保留，换值被忽略）', async () => {
    sessionState.sessions['src'] = { id: 'src', workingDirectory: grantRoot };
    const job = await service.createJob(agentJob({
      action: { type: 'agent', agentType: 'default', prompt: '写一条笔记', context: { sourceSessionId: 'src' } },
    }));
    await service.grantWriteScope(job.id);

    const tampered = await service.updateJob(job.id, {
      metadata: { ...(service.getJob(job.id)?.metadata ?? {}), writeGrantRoot: '/tmp/other-root' },
    });
    expect(tampered?.metadata?.writeGrantRoot).toBe(grantRoot);
  });

  it('createJob 载荷夹带的 writeGrantRoot 一律剥掉', async () => {
    const job = await service.createJob(agentJob({
      metadata: { writeGrantRoot: '/tmp/smuggled-at-create', harmless: true },
    }));
    expect(job.metadata).toEqual({ harmless: true });
  });

  it('写授权防线不改变 loginPassThroughOrigin 的既有行为（create 不剥、update 剥）', async () => {
    // create 对 login 字段的历史行为是透传（本单不扩权改动它），回归钉住这一点。
    const job = await service.createJob(agentJob({
      metadata: { loginPassThroughOrigin: 'https://a.example' },
    }));
    expect(job.metadata).toEqual({ loginPassThroughOrigin: 'https://a.example' });
    // update 对 login 字段维持「回传保留存量、换值忽略」的既有语义（存量为 create 透传值）。
    const edited = await service.updateJob(job.id, {
      metadata: { loginPassThroughOrigin: 'https://b.example', keep: 1 },
    });
    expect(edited?.metadata).toEqual({ loginPassThroughOrigin: 'https://a.example', keep: 1 });
  });
});

describe('写授权放行（schedule write grant，原 scheduleWriteGrant.test.ts ①）', () => {
  // 整合拆分轮（2026-10-28）自独立文件并入：真实 OrchestratorPermissionIsland + 真实
  // cronWriteGrant 文件系统，mock 只有 sessionManager（与上方共用 sessionState）。
  const islandSettings = (): AppSettings => ({
    permissions: {
      // write:false —— 交互路径的 autoApprove[level] 自动放行与本单无关，不许它抢答。
      autoApprove: { read: false, write: false, execute: false, network: false },
      blockedCommands: [],
      devModeAutoApprove: false,
    },
  } as unknown as AppSettings);

  /** 排空微任务链（approveByScheduleWriteGrant 里有动态 import + await，一跳不够）。 */
  const flushMicrotasks = () => new Promise<void>((resolve) => { setImmediate(resolve); });

  function makeIslandRepo(): PendingApprovalRepository & { insert: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> } {
    return {
      insert: vi.fn(),
      resolve: vi.fn(() => 1),
    } as unknown as PendingApprovalRepository & { insert: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> };
  }

  function makeIsland(repo: PendingApprovalRepository) {
    return new OrchestratorPermissionIsland({
      getSettings: () => islandSettings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent: vi.fn(),
      injectedPendingApprovalRepo: repo,
    });
  }

  function islandStillPending(promise: Promise<PermissionAskResult>): Promise<boolean> {
    const pending = Symbol('pending');
    return Promise.race([promise, Promise.resolve(pending)]).then((result) => result === pending);
  }

  it('cron 无人值守会话写授权文件夹内的文件被放行，不落停车台账', async () => {
    const sessionId = 'cron-granted';
    getPermissionModeManager().markUnattendedSession(sessionId);
    sessionState.sessions[sessionId] = {
      id: sessionId,
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    const repo = makeIslandRepo();
    const island = makeIsland(repo);
    await expect(island.requestPermission({
      type: 'file_write',
      tool: 'Write',
      details: { path: path.join(grantRoot, 'today.md') },
      sessionId,
    })).resolves.toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
    await expect(island.requestPermission({
      type: 'file_edit',
      tool: 'Edit',
      details: { path: path.join(grantRoot, 'today.md') },
      sessionId,
    })).resolves.toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('出界 / `..` 逃逸 / 软链逃逸目标照旧停车（pending_approvals 落行、Promise 挂起）', async () => {
    const sessionId = 'cron-granted-2';
    getPermissionModeManager().markUnattendedSession(sessionId);
    sessionState.sessions[sessionId] = {
      id: sessionId,
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    const outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'neo-island-out-'));
    try {
      symlinkSync(outsideRoot, path.join(grantRoot, 'link-out'));
      const repo = makeIslandRepo();
      const island = makeIsland(repo);
      for (const target of [
        path.join(path.dirname(grantRoot), 'outside.txt'),
        path.join(grantRoot, '..', 'escape.txt'),
        path.join(grantRoot, 'link-out', 'stolen.txt'),
      ]) {
        const result = island.requestPermission({
          type: 'file_write', tool: 'Write', details: { path: target }, sessionId,
        });
        await flushMicrotasks();
        expect(await islandStillPending(result)).toBe(true);
        island.drainPendingPermissions();
      }
      expect(repo.insert).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('forceConfirm（含保护路径 ask）与 Bash 照旧停车', async () => {
    const sessionId = 'cron-granted-3';
    getPermissionModeManager().markUnattendedSession(sessionId);
    sessionState.sessions[sessionId] = {
      id: sessionId,
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    const repo = makeIslandRepo();
    const island = makeIsland(repo);
    const forced = island.requestPermission({
      type: 'file_write', tool: 'Write', forceConfirm: true,
      details: { path: path.join(grantRoot, 'a.txt') }, sessionId,
    });
    const bash = island.requestPermission({
      type: 'command', tool: 'Bash',
      details: { command: `echo hi > ${grantRoot}/a.txt` }, sessionId,
    });
    await flushMicrotasks();
    expect(await islandStillPending(forced)).toBe(true);
    expect(await islandStillPending(bash)).toBe(true);
    expect(repo.insert).toHaveBeenCalledTimes(2);
    island.drainPendingPermissions();
  });

  it('非 cron 来源的会话（无来源 / channel 来源 / 未授权 cron）照旧停车', async () => {
    const plainSession = 'plain-session';
    const channelSession = 'channel-session';
    const ungrantedCron = 'cron-ungranted';
    getPermissionModeManager().markUnattendedSession(plainSession);
    getPermissionModeManager().markUnattendedSession(channelSession);
    getPermissionModeManager().markUnattendedSession(ungrantedCron);
    sessionState.sessions[channelSession] = {
      id: channelSession,
      origin: { kind: 'channel', metadata: { writeGrantRoot: grantRoot } },
    };
    sessionState.sessions[ungrantedCron] = { id: ungrantedCron, origin: { kind: 'cron' } };
    const repo = makeIslandRepo();
    const island = makeIsland(repo);
    for (const sessionId of [plainSession, channelSession, ungrantedCron]) {
      const result = island.requestPermission({
        type: 'file_write', tool: 'Write',
        details: { path: path.join(grantRoot, 'a.txt') }, sessionId,
      });
      await flushMicrotasks();
      expect(await islandStillPending(result)).toBe(true);
    }
    expect(repo.insert).toHaveBeenCalledTimes(3);
    island.drainPendingPermissions();
  });

  it('交互会话（未标 unattended）不触发授权查询，照常走交互审批路径', async () => {
    const sessionId = 'interactive-session';
    sessionState.sessions[sessionId] = {
      id: sessionId,
      origin: { kind: 'cron', metadata: { writeGrantRoot: grantRoot } },
    };
    const repo = makeIslandRepo();
    const island = makeIsland(repo);
    const result = island.requestPermission({
      type: 'file_write', tool: 'Write',
      details: { path: path.join(grantRoot, 'a.txt') }, sessionId,
    });
    await flushMicrotasks();
    // 交互路径：不停车（repo 不落行），Promise 等真人（60s 超时路径在别处已钉死）
    expect(repo.insert).not.toHaveBeenCalled();
    expect(await islandStillPending(result)).toBe(true);
    island.drainPendingPermissions();
  });
});
