// ContextAssembly - Research, planning, and adaptive thinking injections.
import type { Message, ToolCall, ToolResult } from '../../../../shared/contract';
import { getToolSearchService } from '../../../services/toolSearch';
import { CONFIG_DIR_NEW } from '../../../config/configPaths';
import { join } from 'path';
import type { ContextAssemblyCtx } from '../contextAssembly';
import { cachedReadFileSync, logger } from '../contextAssembly';

export function loadResearchSkillPrompt(ctx: ContextAssemblyCtx): string | null {
  // Try project-level skill first, then user-level
  const candidates = [
    join(ctx.runtime.workingDirectory || process.cwd(), CONFIG_DIR_NEW, 'skills', 'research', 'SKILL.md'),
    join(process.env.HOME || '~', CONFIG_DIR_NEW, 'skills', 'research', 'SKILL.md'),
  ];

  for (const skillPath of candidates) {
    try {
      const content = cachedReadFileSync(skillPath);
      // Strip YAML frontmatter
      const stripped = content.replace(/^---[\s\S]*?---\n*/m, '');
      logger.info('Loaded research skill prompt', { path: skillPath });
      return stripped.trim();
    } catch {
      // continue to next candidate
    }
  }

  logger.warn('Research skill not found, using fallback prompt');
  return null;
}

export function injectResearchModePrompt(ctx: ContextAssemblyCtx, _userMessage: string): void {
  // Try loading from skill file
  const skillPrompt = ctx.loadResearchSkillPrompt();
  const prompt = skillPrompt || `## 研究模式已激活\n\n用户的请求需要深入调研。请制定研究计划，从多个角度搜索，使用 web_fetch 深入抓取关键结果，最终形成结构化报告。\n\n报告要求：数据标注来源编号 [S1][S2]...，区分实证数据与趋势推断，至少执行 4 次不同角度的搜索。`;

  ctx.pushPersistentSystemContext(prompt);

  // Engineering logic
  ctx.runtime._researchModeActive = true;
  ctx.runtime._researchIterationCount = 0;

  // Pre-load web_fetch for research mode to avoid wasting an iteration on tool_search
  try {
    const toolSearchService = getToolSearchService();
    toolSearchService.selectTool('web_fetch');
    logger.info('[ResearchMode] Pre-loaded web_fetch tool');
  } catch (error) {
    logger.debug('[ResearchMode] Could not pre-load web_fetch', { error: String(error) });
  }
  logger.info('Research mode prompt injected');
}

export async function buildPlanContextMessage(ctx: ContextAssemblyCtx): Promise<string | null> {
  if (!ctx.runtime.planningService) return null;

  const plan = ctx.runtime.planningService.plan.getCurrentPlan()
    ?? await ctx.runtime.planningService.plan.read();
  if (!plan) return null;

  // Don't inject for fully completed plans
  if (ctx.runtime.planningService.plan.isComplete()) return null;

  const { completedSteps, totalSteps } = plan.metadata;
  const lines: string[] = [
    `<current-plan>`,
    `## Current Plan: ${plan.title}`,
    `Progress: ${completedSteps}/${totalSteps} steps completed`,
    ``,
  ];

  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      if (step.status === 'completed') {
        lines.push(`✅ ${step.content}`);
      } else if (step.status === 'in_progress') {
        lines.push(`→ ${step.content} (CURRENT)`);
      } else if (step.status === 'skipped') {
        lines.push(`⊘ ${step.content} (skipped)`);
      } else {
        lines.push(`○ ${step.content}`);
      }
    }
  }

  lines.push(`</current-plan>`);
  return lines.join('\n');
}

export function shouldThink(ctx: ContextAssemblyCtx, hasErrors: boolean): boolean {
  ctx.runtime.thinkingStepCount++;

  switch (ctx.runtime.effortLevel) {
    case 'max':
      return true; // 每次 tool call 后都思考
    case 'high':
      return ctx.runtime.thinkingStepCount % 2 === 0 || hasErrors; // 每隔一次 + 错误时
    case 'medium':
      return hasErrors || ctx.runtime.thinkingStepCount === 1; // 仅在错误恢复或首次
    case 'low':
      return ctx.runtime.thinkingStepCount === 1; // 仅初始规划
    default:
      return false;
  }
}

export function generateThinkingPrompt(
  ctx: ContextAssemblyCtx,
  toolCalls: ToolCall[],
  toolResults: ToolResult[]
): string {
  const hasErrors = toolResults.some(r => !r.success);
  const toolNames = toolCalls.map(tc => tc.name).join(', ');

  if (hasErrors) {
    const errors = toolResults
      .filter(r => !r.success)
      .map(r => `${r.toolCallId}: ${r.error}`)
      .join('\n');
    return (
      `<thinking>\n` +
      `刚执行了 ${toolNames}，其中有工具失败。\n` +
      `错误信息：\n${errors}\n\n` +
      `请分析：\n` +
      `1. 错误的根本原因是什么？\n` +
      `2. 是否需要更换策略？\n` +
      `3. 下一步应该怎么做？\n` +
      `</thinking>`
    );
  }

  return (
    `<thinking>\n` +
    `刚执行了 ${toolNames}。\n` +
    `请简要分析：\n` +
    `1. 执行结果是否符合预期？\n` +
    `2. 离最终目标还有多远？\n` +
    `3. 下一步的最优行动是什么？\n` +
    `</thinking>`
  );
}

export async function maybeInjectThinking(
  ctx: ContextAssemblyCtx,
  toolCalls: ToolCall[],
  toolResults: ToolResult[]
): Promise<void> {
  const hasErrors = toolResults.some(r => !r.success);

  if (!ctx.shouldThink(hasErrors)) {
    return;
  }

  try {
    const thinkingPrompt = ctx.generateThinkingPrompt(toolCalls, toolResults);
    ctx.injectSystemMessage(thinkingPrompt);

    // 记录思考注入
    const thinkingMessage: Message = {
      id: ctx.generateId(),
      role: 'system',
      content: thinkingPrompt,
      timestamp: Date.now(),
      thinking: thinkingPrompt,
      isMeta: true, // 不渲染到 UI，但发送给模型
    };

    // 发送思考事件到 UI（可折叠显示）
    ctx.runtime.onEvent({
      type: 'agent_thinking',
      data: {
        message: `[Thinking Step ${ctx.runtime.thinkingStepCount}] Effort: ${ctx.runtime.effortLevel}`,
        progress: undefined,
      },
    });

    logger.debug(`[AgentLoop] Thinking step ${ctx.runtime.thinkingStepCount} injected (effort: ${ctx.runtime.effortLevel})`);
  } catch (error) {
    logger.warn('[AgentLoop] Failed to inject thinking step:', error);
  }
}
