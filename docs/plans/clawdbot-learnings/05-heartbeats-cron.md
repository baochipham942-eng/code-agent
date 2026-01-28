# 定时任务与 Heartbeat 系统

## 问题描述

当前 Code Agent 没有定时任务能力。Clawdbot 支持：

1. **Heartbeat**：定期唤醒 Agent 处理待办事项
2. **Cron Jobs**：用户可配置的定时任务
3. **Isolated Agent**：在独立会话中执行定时任务

## Clawdbot 实现分析

### 核心文件
- `src/cron/types.ts` - 类型定义
- `src/cron/service.ts` - Cron 服务
- `src/cron/service/timer.ts` - 定时器管理
- `src/cron/isolated-agent/` - 隔离执行

### 调度类型

```typescript
type CronSchedule =
  | { kind: "at"; atMs: number }              // 一次性：在指定时间执行
  | { kind: "every"; everyMs: number }        // 间隔：每 N 毫秒执行
  | { kind: "cron"; expr: string; tz?: string }; // Cron 表达式
```

### 任务定义

```typescript
type CronJob = {
  id: string;
  agentId?: string;           // 绑定到特定 Agent
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;   // 执行后自动删除（一次性任务）
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";  // 主会话 or 隔离执行
  wakeMode: "next-heartbeat" | "now";  // 唤醒方式
  payload: CronPayload;
  isolation?: CronIsolation;  // 隔离执行配置
  state: CronJobState;        // 运行状态
};
```

### 执行载荷

```typescript
type CronPayload =
  | { kind: "systemEvent"; text: string }  // 系统事件，注入到会话
  | {
      kind: "agentTurn";                   // Agent 执行
      message: string;                     // 任务指令
      model?: string;                      // 模型覆盖
      thinking?: string;                   // 思考模式
      timeoutSeconds?: number;             // 超时
      deliver?: boolean;                   // 是否发送结果
      channel?: string;                    // 发送渠道
      to?: string;                         // 发送目标
    };
```

### 隔离执行

```typescript
type CronIsolation = {
  postToMainPrefix?: string;   // 结果前缀
  postToMainMode?: "summary" | "full";  // 结果模式
  postToMainMaxChars?: number; // 最大字符数
};
```

## Code Agent 现状

无定时任务能力，只能响应用户主动输入。

## 借鉴方案

### Step 1: 类型定义

```typescript
// src/shared/types/cron.ts

export type ScheduleKind = 'at' | 'every' | 'cron';

export interface Schedule {
  kind: ScheduleKind;
  // at: 一次性执行时间（Unix ms）
  atMs?: number;
  // every: 间隔毫秒数
  everyMs?: number;
  // cron: Cron 表达式
  expr?: string;
  // cron: 时区
  tz?: string;
}

export interface CronJobPayload {
  kind: 'systemEvent' | 'agentTurn';
  // systemEvent: 注入到会话的文本
  text?: string;
  // agentTurn: Agent 执行的任务描述
  message?: string;
  // agentTurn: 模型覆盖
  model?: string;
  // agentTurn: 超时（秒）
  timeoutSeconds?: number;
}

export interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
}

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  schedule: Schedule;
  sessionTarget: 'main' | 'isolated';
  payload: CronJobPayload;
  state: CronJobState;
  createdAt: number;
  updatedAt: number;
}

export interface CronJobCreate {
  name: string;
  description?: string;
  schedule: Schedule;
  sessionTarget?: 'main' | 'isolated';
  payload: CronJobPayload;
}
```

### Step 2: Cron 服务

```typescript
// src/main/cron/cronService.ts
import Croner from 'croner';
import { CronJob, CronJobCreate, CronJobState } from '@shared/types/cron';
import { DatabaseService } from '../services/database';
import { AgentOrchestrator } from '../agent/agentOrchestrator';

export class CronService {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, NodeJS.Timeout | Croner>();
  private running = false;

  constructor(
    private db: DatabaseService,
    private orchestrator: AgentOrchestrator,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // 从数据库加载 jobs
    const jobs = await this.db.getCronJobs();
    for (const job of jobs) {
      this.jobs.set(job.id, job);
      if (job.enabled) {
        this.armTimer(job);
      }
    }

    console.log(`[Cron] Started with ${jobs.length} jobs`);
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      if (timer instanceof Croner) {
        timer.stop();
      } else {
        clearTimeout(timer);
      }
    }
    this.timers.clear();
  }

  // 创建任务
  async add(input: CronJobCreate): Promise<CronJob> {
    const job: CronJob = {
      id: `cron_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: input.name,
      description: input.description,
      enabled: true,
      schedule: input.schedule,
      sessionTarget: input.sessionTarget || 'main',
      payload: input.payload,
      state: {
        nextRunAtMs: this.computeNextRun(input.schedule),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.db.saveCronJob(job);
    this.jobs.set(job.id, job);
    this.armTimer(job);

    return job;
  }

  // 更新任务
  async update(id: string, updates: Partial<CronJob>): Promise<CronJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;

    Object.assign(job, updates, { updatedAt: Date.now() });

    // 重新计算下次执行时间
    if (updates.schedule) {
      job.state.nextRunAtMs = this.computeNextRun(job.schedule);
    }

    await this.db.saveCronJob(job);

    // 重设定时器
    this.disarmTimer(id);
    if (job.enabled) {
      this.armTimer(job);
    }

    return job;
  }

  // 删除任务
  async remove(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;

    this.disarmTimer(id);
    this.jobs.delete(id);
    await this.db.deleteCronJob(id);

    return true;
  }

  // 列出任务
  list(opts?: { includeDisabled?: boolean }): CronJob[] {
    const jobs = Array.from(this.jobs.values());
    if (opts?.includeDisabled) return jobs;
    return jobs.filter(j => j.enabled);
  }

  // 手动执行
  async run(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job ${id} not found`);
    await this.executeJob(job, { forced: true });
  }

  // 设置定时器
  private armTimer(job: CronJob): void {
    this.disarmTimer(job.id);

    switch (job.schedule.kind) {
      case 'at': {
        const delay = Math.max((job.schedule.atMs || 0) - Date.now(), 0);
        const timer = setTimeout(() => this.onTick(job.id), delay);
        this.timers.set(job.id, timer);
        break;
      }

      case 'every': {
        const timer = setInterval(
          () => this.onTick(job.id),
          job.schedule.everyMs || 60000
        );
        this.timers.set(job.id, timer);
        break;
      }

      case 'cron': {
        if (!job.schedule.expr) break;
        const timer = new Croner(job.schedule.expr, {
          timezone: job.schedule.tz,
        }, () => this.onTick(job.id));
        this.timers.set(job.id, timer);
        break;
      }
    }
  }

  private disarmTimer(id: string): void {
    const timer = this.timers.get(id);
    if (!timer) return;

    if (timer instanceof Croner) {
      timer.stop();
    } else if (typeof timer === 'object') {
      clearTimeout(timer);
      clearInterval(timer);
    }

    this.timers.delete(id);
  }

  private async onTick(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || !job.enabled) return;
    if (job.state.runningAtMs) return; // 已在执行

    await this.executeJob(job, { forced: false });
  }

  private async executeJob(job: CronJob, opts: { forced: boolean }): Promise<void> {
    const startedAt = Date.now();
    job.state.runningAtMs = startedAt;
    job.state.lastError = undefined;

    console.log(`[Cron] Executing job: ${job.name}`);

    try {
      if (job.payload.kind === 'systemEvent') {
        // 注入系统事件到主会话
        await this.orchestrator.injectSystemEvent(job.payload.text || '');
      } else {
        // Agent 执行
        if (job.sessionTarget === 'isolated') {
          await this.runIsolated(job);
        } else {
          await this.orchestrator.processMessage(
            job.payload.message || '',
            { source: 'cron', cronJobId: job.id }
          );
        }
      }

      job.state.lastStatus = 'ok';
    } catch (err) {
      job.state.lastStatus = 'error';
      job.state.lastError = String(err);
      console.error(`[Cron] Job ${job.name} failed:`, err);
    } finally {
      const endedAt = Date.now();
      job.state.runningAtMs = undefined;
      job.state.lastRunAtMs = startedAt;
      job.state.lastDurationMs = endedAt - startedAt;

      // 一次性任务处理
      if (job.schedule.kind === 'at' && job.state.lastStatus === 'ok') {
        if (job.deleteAfterRun) {
          await this.remove(job.id);
        } else {
          job.enabled = false;
          this.disarmTimer(job.id);
        }
      }

      // 更新下次执行时间
      if (job.enabled && job.schedule.kind !== 'at') {
        job.state.nextRunAtMs = this.computeNextRun(job.schedule);
      }

      await this.db.saveCronJob(job);
    }
  }

  private async runIsolated(job: CronJob): Promise<void> {
    // 创建隔离的 Agent 执行环境
    const result = await this.orchestrator.runIsolated({
      message: job.payload.message || '',
      model: job.payload.model,
      timeoutSeconds: job.payload.timeoutSeconds || 300,
    });

    // 可选：将结果汇总到主会话
    if (result.output) {
      const summary = result.output.slice(0, 500);
      await this.orchestrator.injectSystemEvent(
        `[Cron: ${job.name}] ${summary}`
      );
    }
  }

  private computeNextRun(schedule: Schedule): number | undefined {
    const now = Date.now();

    switch (schedule.kind) {
      case 'at':
        return schedule.atMs;

      case 'every':
        return now + (schedule.everyMs || 60000);

      case 'cron': {
        if (!schedule.expr) return undefined;
        try {
          const cron = new Croner(schedule.expr, { timezone: schedule.tz });
          const next = cron.nextRun();
          cron.stop();
          return next?.getTime();
        } catch {
          return undefined;
        }
      }

      default:
        return undefined;
    }
  }
}
```

### Step 3: Heartbeat 服务

```typescript
// src/main/cron/heartbeatService.ts

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;        // 心跳间隔（默认 10 分钟）
  prompt: string;            // 心跳时的提示
}

export class HeartbeatService {
  private timer: NodeJS.Timeout | null = null;
  private config: HeartbeatConfig;

  constructor(
    private orchestrator: AgentOrchestrator,
    config?: Partial<HeartbeatConfig>,
  ) {
    this.config = {
      enabled: config?.enabled ?? false,
      intervalMs: config?.intervalMs ?? 10 * 60 * 1000, // 10 分钟
      prompt: config?.prompt ?? '检查是否有待处理的任务或提醒',
    };
  }

  start(): void {
    if (this.timer) return;
    if (!this.config.enabled) return;

    this.timer = setInterval(() => {
      this.beat();
    }, this.config.intervalMs);

    console.log(`[Heartbeat] Started with interval ${this.config.intervalMs}ms`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // 手动触发心跳
  async beat(): Promise<void> {
    console.log('[Heartbeat] Beat');

    try {
      await this.orchestrator.injectSystemEvent(this.config.prompt);
    } catch (err) {
      console.error('[Heartbeat] Failed:', err);
    }
  }

  // 立即唤醒（用于外部触发）
  async wakeNow(text: string): Promise<void> {
    console.log('[Heartbeat] Wake now:', text);
    await this.orchestrator.injectSystemEvent(text);
  }

  updateConfig(updates: Partial<HeartbeatConfig>): void {
    const wasEnabled = this.config.enabled;
    Object.assign(this.config, updates);

    // 重启定时器
    if (wasEnabled) {
      this.stop();
    }
    if (this.config.enabled) {
      this.start();
    }
  }
}
```

### Step 4: 数据库 Schema

```sql
-- Cron Jobs 表
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  delete_after_run INTEGER DEFAULT 0,
  schedule_kind TEXT NOT NULL,
  schedule_at_ms INTEGER,
  schedule_every_ms INTEGER,
  schedule_expr TEXT,
  schedule_tz TEXT,
  session_target TEXT DEFAULT 'main',
  payload_kind TEXT NOT NULL,
  payload_text TEXT,
  payload_message TEXT,
  payload_model TEXT,
  payload_timeout_seconds INTEGER,
  state_next_run_at_ms INTEGER,
  state_last_run_at_ms INTEGER,
  state_last_status TEXT,
  state_last_error TEXT,
  state_last_duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(state_next_run_at_ms);
```

### Step 5: UI 支持

```typescript
// src/renderer/components/features/settings/CronTab.tsx
export function CronTab() {
  const [jobs, setJobs] = useState<CronJob[]>([]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3>定时任务</h3>
        <Button onClick={handleAddJob}>添加任务</Button>
      </div>

      <div className="space-y-2">
        {jobs.map(job => (
          <CronJobCard
            key={job.id}
            job={job}
            onToggle={() => handleToggle(job.id)}
            onEdit={() => handleEdit(job)}
            onRun={() => handleRun(job.id)}
            onDelete={() => handleDelete(job.id)}
          />
        ))}
      </div>

      <div className="mt-6 border-t pt-4">
        <h4>Heartbeat 设置</h4>
        <HeartbeatConfig />
      </div>
    </div>
  );
}

function CronJobCard({ job, onToggle, onEdit, onRun, onDelete }) {
  return (
    <div className="p-3 border rounded flex justify-between items-center">
      <div>
        <div className="font-medium">{job.name}</div>
        <div className="text-sm text-gray-500">
          {formatSchedule(job.schedule)}
          {job.state.nextRunAtMs && (
            <span className="ml-2">
              下次执行: {formatTime(job.state.nextRunAtMs)}
            </span>
          )}
        </div>
        {job.state.lastStatus && (
          <div className="text-xs mt-1">
            上次: {job.state.lastStatus}
            {job.state.lastDurationMs && ` (${job.state.lastDurationMs}ms)`}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <Switch checked={job.enabled} onChange={onToggle} />
        <Button size="sm" onClick={onRun}>执行</Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>编辑</Button>
        <Button size="sm" variant="danger" onClick={onDelete}>删除</Button>
      </div>
    </div>
  );
}
```

### Step 6: 快速创建 API

```typescript
// 便捷方法：设置提醒
cronService.add({
  name: '下午会议提醒',
  schedule: { kind: 'at', atMs: Date.now() + 2 * 60 * 60 * 1000 },
  payload: { kind: 'systemEvent', text: '提醒：你有一个下午 3 点的会议' },
  deleteAfterRun: true,
});

// 便捷方法：每日任务
cronService.add({
  name: '每日代码审查',
  schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'Asia/Shanghai' },
  sessionTarget: 'isolated',
  payload: {
    kind: 'agentTurn',
    message: '检查昨天的 PR，生成审查报告',
  },
});

// 便捷方法：定期健康检查
cronService.add({
  name: '服务健康检查',
  schedule: { kind: 'every', everyMs: 30 * 60 * 1000 },
  payload: {
    kind: 'agentTurn',
    message: 'curl https://api.example.com/health 并报告结果',
    timeoutSeconds: 60,
  },
});
```

## 验收标准

1. **基础调度**：支持 at/every/cron 三种调度方式
2. **任务管理**：CRUD + 启用/禁用
3. **执行监控**：记录执行状态、时长、错误
4. **隔离执行**：支持在独立会话中执行任务
5. **Heartbeat**：支持定期唤醒 Agent
6. **持久化**：任务配置和状态持久化到数据库
7. **UI 管理**：可通过界面管理定时任务

## 风险与注意事项

1. **资源占用**：大量定时任务可能占用系统资源
2. **并发控制**：避免同一任务重复执行
3. **错误恢复**：任务失败后的重试机制
4. **时区处理**：Cron 表达式的时区支持

## 依赖

- [croner](https://github.com/hexagon/croner) - Cron 表达式解析和调度

## 参考资料

- [Clawdbot cron/types.ts](https://github.com/clawdbot/clawdbot/blob/main/src/cron/types.ts)
- [Clawdbot cron/service.ts](https://github.com/clawdbot/clawdbot/blob/main/src/cron/service.ts)
- [Clawdbot cron/service/timer.ts](https://github.com/clawdbot/clawdbot/blob/main/src/cron/service/timer.ts)
