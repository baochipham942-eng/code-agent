// ============================================================================
// CronService 写授权窄写通道（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1 ②）：
//   - updateJob 不能创建/改写 metadata.writeGrantRoot（sanitize 同 loginPassThroughOrigin）
//   - createJob 载荷夹带的一律剥掉（no-self-grant）
//   - 只有 grantWriteScope / revokeWriteScope 能写；revoke 摘字段
//   - grant 解析不出文件夹抛 CRON_WRITE_SCOPE_NO_FOLDER；常设刷新取产物目录
// ============================================================================
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const sessionState = vi.hoisted(() => ({
  sessions: {} as Record<string, { id: string; workingDirectory?: string } | undefined>,
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

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: vi.fn(), notifyNeedsInput: vi.fn() },
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async (id: string) => sessionState.sessions[id] ?? null,
  }),
}));

import { CronService } from '../../../src/host/cron/cronService';
import { CRON_WRITE_SCOPE_NO_FOLDER } from '../../../src/shared/cronWriteScope';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

let service: CronService;
let grantRoot: string;

beforeEach(() => {
  service = new CronService();
  grantRoot = mkdtempSync(path.join(os.tmpdir(), 'neo-svc-grant-'));
  sessionState.sessions = {};
});

afterEach(async () => {
  await service.shutdown();
  rmSync(grantRoot, { recursive: true, force: true });
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

describe('CronService 写授权窄写通道', () => {
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
