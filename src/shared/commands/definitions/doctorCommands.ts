// ============================================================================
// Doctor Commands - /doctor
// 跨 CLI + GUI 的统一健康检查入口。
//
// CLI surface: 直接动态 import runDoctor()，按表格分段打印。
// GUI surface: 通过 IPC（provider:run_doctor）调用，输出文本结果到对话流。
//   GUI 用户也可通过设置面板的"诊断"按钮调起 ProviderDoctorDialog（旧路径）。
// ============================================================================

import type {
  CommandContext,
  CommandDefinition,
  CommandResult,
} from '../types';

// 与 src/host/diagnostics/types.ts 对齐的轻量副本，避免 shared 引用 main
type DoctorCategory =
  | 'environment'
  | 'database'
  | 'config'
  | 'disk'
  | 'network'
  | 'provider_health'
  | 'mcp'
  | 'hooks'
  | 'version';

type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

interface DoctorItem {
  category: DoctorCategory;
  name: string;
  status: DoctorStatus;
  message: string;
  details?: string;
  suggestion?: string;
  durationMs?: number;
}

interface DoctorReport {
  timestamp: number;
  durationMs: number;
  items: DoctorItem[];
  summary: { pass: number; warn: number; fail: number; skip: number };
}

// ----------------------------------------------------------------------------
// Rendering helpers
// ----------------------------------------------------------------------------

const CATEGORY_LABELS: Record<DoctorCategory, string> = {
  environment: 'Environment',
  database: 'Database',
  config: 'Config',
  disk: 'Disk',
  network: 'Network',
  provider_health: 'Provider Health',
  mcp: 'MCP',
  hooks: 'Hooks',
  version: 'Version',
};

const CATEGORY_ORDER: DoctorCategory[] = [
  'environment',
  'database',
  'config',
  'disk',
  'network',
  'provider_health',
  'mcp',
  'hooks',
  'version',
];

const STATUS_GLYPH: Record<DoctorStatus, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
  skip: '-',
};

function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  const grouped = new Map<DoctorCategory, DoctorItem[]>();
  for (const item of report.items) {
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category)!.push(item);
  }

  for (const cat of CATEGORY_ORDER) {
    const items = grouped.get(cat);
    if (!items || items.length === 0) continue;
    lines.push('');
    lines.push(`── ${CATEGORY_LABELS[cat]} ──`);
    for (const item of items) {
      const glyph = STATUS_GLYPH[item.status];
      const main = `  ${glyph} ${item.name.padEnd(28)} ${item.message}`;
      lines.push(main);
      if (item.suggestion) {
        lines.push(`      → ${item.suggestion}`);
      }
    }
  }

  const { pass, warn, fail, skip } = report.summary;
  lines.push('');
  lines.push(
    `Summary: ${pass} pass / ${warn} warn / ${fail} fail / ${skip} skip   ⏱ ${(report.durationMs / 1000).toFixed(1)}s`,
  );

  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Surface-specific dispatchers
// ----------------------------------------------------------------------------

async function runViaCliSurface(): Promise<DoctorReport> {
  // 动态 import 避免 renderer 打包时把 main 拽进去
  const { runDoctor } = await import('../../../host/diagnostics/doctorRunner');
  return runDoctor();
}

async function runViaGuiSurface(): Promise<DoctorReport> {
  // 通过 renderer-only 包装模块走 IPC，避免把 ipcService 作为无效 dynamic import 打进主包。
  const { runDoctorViaGuiSurface } = await import('../../../renderer/services/doctorGuiSurface');
  return runDoctorViaGuiSurface<DoctorReport>();
}

// ----------------------------------------------------------------------------
// Command definition
// ----------------------------------------------------------------------------

export const doctorCommand: CommandDefinition = {
  id: 'doctor',
  name: '系统诊断',
  description: '运行 9 类健康检查（环境/数据库/网络/MCP/Hooks/版本…）',
  category: 'system',
  surfaces: ['cli', 'gui'],
  aliases: ['diagnose'],
  handler: async (ctx: CommandContext): Promise<CommandResult> => {
    ctx.output.info('/doctor running... 这可能需要几秒钟');
    try {
      const report =
        ctx.surface === 'cli' ? await runViaCliSurface() : await runViaGuiSurface();
      ctx.output.info(formatReport(report));

      if (report.summary.fail > 0) {
        ctx.output.error(`存在 ${report.summary.fail} 项失败，建议查看上面的修复建议`);
        return { success: false, data: report };
      }
      if (report.summary.warn > 0) {
        ctx.output.warn(`存在 ${report.summary.warn} 项警告`);
      } else {
        ctx.output.success('所有检查通过');
      }
      return { success: true, data: report };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.output.error(`诊断失败：${msg}`);
      return { success: false, message: msg };
    }
  },
};

export const doctorCommands: CommandDefinition[] = [doctorCommand];
