// ============================================================================
// WebDeliverablePreviewRepair — 网页交付物写后确定性预览体检 + 至多一次自动修复
// ============================================================================
// N-DESIGN-PREVIEW-REPAIR-WIRE（RQ-270 A）：把 designPreviewRepair 的构件接进真实
// 会话。runDesignPreviewRepairLoop 是「同步等待 repairAgent」的语义，而会话内修复由
// 模型在后续迭代完成，所以这里复用它的 assessment/spec/prompt 构件，用 run 级状态机
// 复刻同一契约：发现问题 → 会话内可见通知 + 注入一份修复指令（本轮该路径唯一一次）
// → 模型改完后复检一次 → 如实汇报「已修复 / 仍有 N 个问题」。
// 只做确定性检测（runArtifactPreviewHealth 既有路由，无 vision）；检查器不可用时
// warn 带可区分原因并持久化未检查通知，绝不弄失败用户回合。

import { basename, extname } from 'path';
import type { Message, ToolCall, ToolResult } from '../../../shared/contract';
import type { SystemEventMessageMetadata } from '../../../shared/contract/systemEventRegistry';
import { formatPreviewHealthMessage } from '../../../shared/i18n/previewHealth';
import { app } from '../../platform';
import { createLogger } from '../../services/infra/logger';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer } from './runFinalizer';
import type { RuntimeContext } from './runtimeContext';
import type {
  DesignPreviewHealthRunner,
  DesignPreviewRepairAssessment,
} from './browser/designPreviewRepair';
import { isAppendTool } from './toolArtifactRepairPolicy';

// designPreviewRepair → artifactPreviewHealth → browserPool 的链条在模块加载期就会
// 实例化 BrowserService 单例；lifecycle/messageProcessor 的静态 import 图不该连带
// 拖进这个副作用（对齐 playwrightRuntime 的 loadPlaywrightChromium 延迟装载先例），
// 首次真正要体检网页交付物时才加载。
type DesignPreviewRepairHelpers = {
  runDesignPreviewRepairAssessment: (
    artifactPath: string,
    options?: { healthRunner?: DesignPreviewHealthRunner },
  ) => Promise<DesignPreviewRepairAssessment>;
  createDesignPreviewRepairSpec: typeof import('./browser/designPreviewRepair').createDesignPreviewRepairSpec;
  formatDesignPreviewRepairSpecForPrompt: typeof import('./browser/designPreviewRepair').formatDesignPreviewRepairSpecForPrompt;
};

let designPreviewRepairHelpers: Promise<DesignPreviewRepairHelpers> | undefined;

function loadDesignPreviewRepairHelpers(): Promise<DesignPreviewRepairHelpers> {
  designPreviewRepairHelpers ??= import('./browser/designPreviewRepair');
  return designPreviewRepairHelpers;
}

const logger = createLogger('WebDeliverablePreviewRepair');

/** 本 run 内每个网页交付物的修复轮状态（RuntimeContext 每 run 重建，WeakMap 随之失效）。 */
interface WebDeliverableRepairRunState {
  /** 已注入修复指令、尚待唯一一次复检的路径 */
  pending: Map<string, WebDeliverablePreviewRepairArgs>;
  /** 已复检并汇报过结局的路径（之后行为与旧代码一致，不再触发任何额外消息） */
  reported: Set<string>;
}

const runStates = new WeakMap<RuntimeContext, WebDeliverableRepairRunState>();

function isWebDeliverablePath(absolutePath: string): boolean {
  const extension = extname(absolutePath).toLowerCase();
  return extension === '.html' || extension === '.htm';
}

function buildWebDeliverableRepairInstruction(
  absolutePath: string,
  findingCount: number,
  formattedSpec: string,
): string {
  return [
    '<design-preview-repair kind="web_deliverable">',
    `target file: ${absolutePath}`,
    `deterministic preview findings: ${findingCount} (headless multi-viewport check; no vision model involved)`,
    'The web page deliverable was written, but its deterministic preview check found display problems such as a blank render, a missing main element, horizontal overflow, broken images, runtime errors, or buttons that cannot be seen.',
    'Fix the target file in place now with Write/Edit so the rendered page passes the preview check. Do not ask the user to confirm or fill these gaps.',
    'This is the only automatic repair round for this file in this run: after your fix the page is re-checked once and the outcome is reported to the user as-is.',
    formattedSpec,
    '</design-preview-repair>',
  ].join('\n');
}

export interface WebDeliverablePreviewRepairArgs {
  ctx: RuntimeContext;
  contextAssembly: ContextAssembly;
  runFinalizer: RunFinalizer;
  toolCall: ToolCall;
  absolutePath: string;
  toolResult: ToolResult;
  /** 测试注入点：生产缺省走 runDesignPreviewRepairAssessment 的既有路由（无 vision）。 */
  healthRunner?: DesignPreviewHealthRunner;
}

export async function maybeRunWebDeliverablePreviewRepair(args: WebDeliverablePreviewRepairArgs): Promise<void> {
  if (!isWebDeliverablePath(args.absolutePath)) return;
  // append 中途的分片不是完整交付物；旧游戏修复闸进行中不叠加第二套修复机制。
  if (isAppendTool(args.toolCall.name)) return;
  if (args.ctx.artifact.repairGuard) return;
  await checkWebDeliverablePreview(args);
}

/** 收尾必须等待未改写文件的唯一一次复检，再发送终态事件。 */
export async function finalizeWebDeliverablePreviewRepairs(ctx: RuntimeContext): Promise<void> {
  const state = runStates.get(ctx);
  if (!state) return;
  for (const args of state.pending.values()) {
    try {
      await checkWebDeliverablePreview(args);
    } catch (error) {
      logger.warn('[WebDeliverablePreviewRepair] final outcome could not be persisted', {
        filePath: args.absolutePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function persistPreviewNotice(args: WebDeliverablePreviewRepairArgs, content: string): Promise<void> {
  const message: Message = {
    id: args.contextAssembly.generateId(),
    role: 'system',
    content: `${basename(args.absolutePath)}: ${content}`,
    timestamp: Date.now(),
    metadata: { agentRecoveryNotice: { kind: 'web_preview_repair' } } satisfies SystemEventMessageMetadata,
  };
  await args.contextAssembly.addAndPersistMessage(message);
  args.ctx.onEvent({ type: 'message', data: message });
}

async function checkWebDeliverablePreview(args: WebDeliverablePreviewRepairArgs): Promise<void> {
  const { ctx, contextAssembly, runFinalizer, absolutePath, toolResult, healthRunner } = args;
  let state = runStates.get(ctx);
  if (!state) {
    state = { pending: new Map(), reported: new Set() };
    runStates.set(ctx, state);
  }
  if (state.reported.has(absolutePath)) return;

  const awaitingRecheck = state.pending.has(absolutePath);
  // 先消费复检资格，检查器不可用或重复收尾也不能再跑一次。
  if (awaitingRecheck) {
    state.pending.delete(absolutePath);
    state.reported.add(absolutePath);
  }
  const locale = app.getLocale?.() ?? null;
  let helpers: DesignPreviewRepairHelpers;
  let assessment;
  try {
    helpers = await loadDesignPreviewRepairHelpers();
    assessment = await helpers.runDesignPreviewRepairAssessment(
      absolutePath,
      healthRunner ? { healthRunner } : {},
    );
  } catch (error) {
    // 检查器崩溃 ≠ 产物有问题：warn 留痕后放行，绝不弄失败用户回合。
    logger.warn('[WebDeliverablePreviewRepair] assessment crashed; deliverable left unverified', {
      filePath: absolutePath,
      error: error instanceof Error ? error.message : String(error),
    });
    state.reported.add(absolutePath);
    await persistPreviewNotice(args, formatPreviewHealthMessage('webRepairUnavailable', {}, locale));
    return;
  }

  const health = assessment.health;
  if (health.skipped || health.checkerFailed) {
    // 无浏览器/检查器自崩：行为不变但必须留可区分的原因，不允许无声降级。
    logger.warn('[WebDeliverablePreviewRepair] preview health unavailable; repair skipped', {
      filePath: absolutePath,
      skipped: Boolean(health.skipped),
      checkerFailed: Boolean(health.checkerFailed),
      cause: health.failures[0] ?? health.checks[0] ?? 'unknown',
    });
    state.reported.add(absolutePath);
    await persistPreviewNotice(args, formatPreviewHealthMessage('webRepairUnavailable', {}, locale));
    return;
  }

  const categories = [...new Set(health.findings.map((finding) => finding.code))];

  if (awaitingRecheck) {
    // 修复后的唯一一次复检：如实汇报结局，之后该路径回归旧代码行为。
    const remaining = categories.length;
    const outcome = remaining === 0
      ? formatPreviewHealthMessage('webRepairFixed', {}, locale)
      : formatPreviewHealthMessage('webRepairRemaining', {
        count: remaining,
        categories: categories.map((code) => formatPreviewHealthMessage(code, {}, locale)).join('、'),
      }, locale);
    runFinalizer.emitTaskProgress('tool_running', outcome);
    await persistPreviewNotice(args, outcome);
    toolResult.metadata = {
      ...toolResult.metadata,
      designPreviewRepair: {
        stage: 'recheck-reported',
        repaired: remaining === 0,
        remainingFindings: remaining,
      },
    };
    return;
  }

  // 无问题路径：不加消息、不改 tool result（与旧代码逐字节一致）。
  if (assessment.findings.length === 0) return;

  state.pending.set(absolutePath, args);
  const spec = helpers.createDesignPreviewRepairSpec({ artifactPath: absolutePath, attempt: 1, assessment });
  const prompt = helpers.formatDesignPreviewRepairSpecForPrompt(spec);
  runFinalizer.emitTaskProgress(
    'tool_running',
    formatPreviewHealthMessage('webRepairNotice', { count: categories.length }, locale),
  );
  contextAssembly.injectSystemMessage(
    buildWebDeliverableRepairInstruction(absolutePath, categories.length, prompt),
    'artifact-validation',
  );
  toolResult.metadata = {
    ...toolResult.metadata,
    designPreviewRepair: {
      stage: 'repair-instructed',
      findings: assessment.findings.map((finding) => ({ source: finding.source, code: finding.code })),
    },
  };
}
