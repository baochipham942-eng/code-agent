// ============================================================================
// Doctor Runner - 聚合层
// 把所有 check 串/并联起来，对每个 category 加超时保护，
// 输出统一的 DoctorReport。
// ============================================================================

import {
  checkConfigDir,
  checkDatabase,
  checkDiskUsage,
  checkNodeVersion,
} from './checks/environment';
import { checkProviderConnectivity } from './checks/network';
import { checkProviderHealth } from './checks/providerHealth';
import { checkMcpServers } from './checks/mcp';
import { checkHooksConfig } from './checks/hooks';
import { checkAppVersion } from './checks/version';
import type {
  DoctorCategory,
  DoctorItem,
  DoctorReport,
  RunDoctorOptions,
} from './types';

/** 默认单项超时 */
const DEFAULT_PER_CHECK_TIMEOUT_MS = 10_000;

/** 包一层 Promise.race 加超时，超时时返回兜底 warn 项 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: () => T,
): Promise<{ value: T; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ value: T; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ value: fallback(), timedOut: true }), timeoutMs);
  });
  try {
    const value = await Promise.race([
      promise.then((v) => ({ value: v, timedOut: false as const })),
      timeoutPromise,
    ]);
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 单项超时兜底项 */
function timeoutItem(category: DoctorCategory, name: string, timeoutMs: number): DoctorItem {
  return {
    category,
    name,
    status: 'warn',
    message: `检查超时（${(timeoutMs / 1000).toFixed(0)}s）`,
    suggestion: '可能是网络或外部进程响应慢；可重试',
  };
}

interface CheckJob {
  category: DoctorCategory;
  name: string;
  /** 是否依赖网络（受 skipNetwork 控制） */
  network?: boolean;
  run: () => Promise<DoctorItem[]>;
}

export async function runDoctor(opts?: RunDoctorOptions): Promise<DoctorReport> {
  const startedAt = Date.now();
  const timeoutMs = opts?.perCheckTimeoutMs ?? DEFAULT_PER_CHECK_TIMEOUT_MS;
  const skipNetwork = !!opts?.skipNetwork;

  // 顺序与 DOCTOR_CATEGORIES 保持一致 — 影响 CLI 输出顺序
  const jobs: CheckJob[] = [
    {
      category: 'environment',
      name: 'Node.js',
      run: async () => [checkNodeVersion()],
    },
    {
      category: 'database',
      name: 'SQLite database',
      run: async () => [await checkDatabase()],
    },
    {
      category: 'config',
      name: 'Config directory',
      run: async () => [checkConfigDir()],
    },
    {
      category: 'disk',
      name: 'Disk usage',
      run: async () => [await checkDiskUsage()],
    },
    {
      category: 'network',
      name: 'Provider connectivity',
      network: true,
      run: checkProviderConnectivity,
    },
    {
      category: 'provider_health',
      name: 'Provider health',
      run: async () => checkProviderHealth(),
    },
    {
      category: 'mcp',
      name: 'MCP servers',
      run: async () => checkMcpServers(),
    },
    {
      category: 'hooks',
      name: 'Hooks 配置',
      run: async () => checkHooksConfig(process.cwd()),
    },
    {
      category: 'version',
      name: '应用版本',
      network: true,
      run: async () => [await checkAppVersion()],
    },
  ];

  const items: DoctorItem[] = [];

  for (const job of jobs) {
    const jobStart = Date.now();

    if (job.network && skipNetwork) {
      items.push({
        category: job.category,
        name: job.name,
        status: 'skip',
        message: '已跳过（skipNetwork=true）',
      });
      continue;
    }

    try {
      const { value } = await withTimeout(
        job.run(),
        timeoutMs,
        () => [timeoutItem(job.category, job.name, timeoutMs)],
      );

      const durationMs = Date.now() - jobStart;
      const checkItems = value.map((item) => ({
        ...item,
        durationMs: item.durationMs ?? durationMs,
      }));

      items.push(...checkItems);
    } catch (err) {
      items.push({
        category: job.category,
        name: job.name,
        status: 'fail',
        message: '检查抛错',
        details: err instanceof Error ? err.message : String(err),
        suggestion: '查看 details 排查；如非可恢复错误，提 issue',
        durationMs: Date.now() - jobStart,
      });
    }
  }

  const summary = {
    pass: items.filter((i) => i.status === 'pass').length,
    warn: items.filter((i) => i.status === 'warn').length,
    fail: items.filter((i) => i.status === 'fail').length,
    skip: items.filter((i) => i.status === 'skip').length,
  };

  return {
    timestamp: startedAt,
    durationMs: Date.now() - startedAt,
    items,
    summary,
  };
}
