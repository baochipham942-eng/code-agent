// ============================================================================
// ComboRecorder - 从对话自动录制工作流，生成可复用的 Combo Skill
// ============================================================================
// 借鉴 FloatBoat 的 Combo Skills 概念：
// 将多轮对话中的工具调用序列固化为 SKILL.md，支持参数化复用。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getEventBus, type BusEvent } from '../../protocol/events';
import type { ToolResult } from '@shared/contract';
import { getSkillsDir } from '../../config/configPaths';
import { createLogger } from '../infra/logger';

const logger = createLogger('ComboRecorder');

// ── Types ──

export interface ComboStep {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  outputPreview: string;
  duration: number;
  timestamp: number;
}

export interface ComboTurn {
  userMessage: string;
  steps: ComboStep[];
  timestamp: number;
}

export interface ComboRecording {
  sessionId: string;
  turns: ComboTurn[];
  startedAt: number;
  toolNames: Set<string>;
}

export interface ComboSuggestion {
  sessionId: string;
  suggestedName: string;
  suggestedDescription: string;
  turnCount: number;
  stepCount: number;
  toolNames: string[];
}

// ── Constants ──

const OUTPUT_PREVIEW_LENGTH = 200;
const MIN_TURNS_FOR_SUGGESTION = 2;
const MIN_STEPS_FOR_SUGGESTION = 3;

// ── Service ──

class ComboRecorderService {
  private recordings = new Map<string, ComboRecording>();
  private unsubscribe: (() => void) | null = null;

  /**
   * Start listening to tool execution events via EventBus
   */
  init(): void {
    if (this.unsubscribe) return;

    const bus = getEventBus();

    this.unsubscribe = bus.subscribe('agent:tool_call_end', (event: BusEvent) => {
      const sessionId = event.sessionId;
      if (!sessionId) return;

      const toolResult = event.data as ToolResult;
      if (!toolResult?.toolCallId) return;

      this.recordStep(sessionId, toolResult);
    });

    logger.info('ComboRecorder initialized');
  }

  /**
   * Start or resume recording for a session
   */
  startRecording(sessionId: string): void {
    if (!this.recordings.has(sessionId)) {
      this.recordings.set(sessionId, {
        sessionId,
        turns: [],
        startedAt: Date.now(),
        toolNames: new Set(),
      });
    }
  }

  /**
   * Mark a new turn (user message) in the recording
   */
  markTurn(sessionId: string, userMessage: string): void {
    const recording = this.recordings.get(sessionId);
    if (!recording) return;

    recording.turns.push({
      userMessage: userMessage.substring(0, 500),
      steps: [],
      timestamp: Date.now(),
    });
  }

  /**
   * Record a tool execution step
   */
  private recordStep(sessionId: string, toolResult: ToolResult): void {
    const recording = this.recordings.get(sessionId);
    if (!recording) return;

    // Ensure there's at least one turn
    if (recording.turns.length === 0) {
      recording.turns.push({
        userMessage: '(auto)',
        steps: [],
        timestamp: Date.now(),
      });
    }

    const currentTurn = recording.turns[recording.turns.length - 1];
    const step: ComboStep = {
      toolCallId: toolResult.toolCallId,
      toolName: (toolResult as unknown as { toolName?: string }).toolName ?? 'unknown',
      args: {},
      success: toolResult.success,
      outputPreview: (toolResult.output ?? toolResult.error ?? '').substring(0, OUTPUT_PREVIEW_LENGTH),
      duration: toolResult.duration ?? 0,
      timestamp: Date.now(),
    };

    currentTurn.steps.push(step);
    recording.toolNames.add(step.toolName);
  }

  /**
   * Enrich the last recorded step with tool call args (called from onToolExecutionLog)
   */
  enrichLastStep(sessionId: string, toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    const recording = this.recordings.get(sessionId);
    if (!recording || recording.turns.length === 0) return;

    const currentTurn = recording.turns[recording.turns.length - 1];
    const step = currentTurn.steps.find(s => s.toolCallId === toolCallId);
    if (step) {
      step.toolName = toolName;
      step.args = sanitizeArgs(args);
    }
  }

  /**
   * Check if current recording is worth suggesting as a Combo Skill
   */
  checkSuggestion(sessionId: string): ComboSuggestion | null {
    const recording = this.recordings.get(sessionId);
    if (!recording) return null;

    const totalSteps = recording.turns.reduce((sum, t) => sum + t.steps.length, 0);
    if (recording.turns.length < MIN_TURNS_FOR_SUGGESTION || totalSteps < MIN_STEPS_FOR_SUGGESTION) {
      return null;
    }

    const toolNames = Array.from(recording.toolNames);
    return {
      sessionId,
      suggestedName: generateSkillName(toolNames, recording.turns),
      suggestedDescription: generateSkillDescription(recording.turns),
      turnCount: recording.turns.length,
      stepCount: totalSteps,
      toolNames,
    };
  }

  /**
   * Get recording data for a session
   */
  getRecording(sessionId: string): ComboRecording | null {
    return this.recordings.get(sessionId) ?? null;
  }

  /**
   * Generate and save a SKILL.md from the recording
   */
  async saveAsSkill(
    sessionId: string,
    name: string,
    description: string,
    workingDirectory?: string,
  ): Promise<{ success: boolean; skillPath?: string; error?: string }> {
    const recording = this.recordings.get(sessionId);
    if (!recording || recording.turns.length === 0) {
      return { success: false, error: 'No recording found for this session' };
    }

    try {
      const skillContent = generateSkillMd(name, description, recording);
      const skillsDir = getSkillsDir(workingDirectory);
      const targetDir = path.join(skillsDir.user.new, name);
      await fs.mkdir(targetDir, { recursive: true });

      const skillPath = path.join(targetDir, 'SKILL.md');
      await fs.writeFile(skillPath, skillContent, 'utf-8');

      logger.info('Combo Skill saved', { name, path: skillPath });
      return { success: true, skillPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to save Combo Skill', { name, error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Stop recording for a session
   */
  stopRecording(sessionId: string): void {
    this.recordings.delete(sessionId);
  }

  /**
   * Cleanup
   */
  shutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.recordings.clear();
  }
}

// ── Helpers ──

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 500) {
      sanitized[key] = value.substring(0, 500) + '...';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function generateSkillName(toolNames: string[], turns: ComboTurn[]): string {
  // Derive name from dominant tool patterns
  if (toolNames.includes('bash') && toolNames.includes('edit_file')) {
    return 'fix-and-verify';
  }
  if (toolNames.includes('glob') && toolNames.includes('read_file')) {
    return 'search-and-read';
  }
  if (toolNames.includes('write_file')) {
    return 'generate-files';
  }
  // Fallback: use first user intent keywords
  const firstMessage = turns[0]?.userMessage ?? '';
  const words = firstMessage
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 3);
  return words.length > 0 ? words.join('-').toLowerCase() : 'combo-workflow';
}

function generateSkillDescription(turns: ComboTurn[]): string {
  const steps = turns.flatMap(t => t.steps);
  const uniqueTools = [...new Set(steps.map(s => s.toolName))];
  const actions = uniqueTools.map(t => {
    switch (t) {
      case 'bash': return '执行命令';
      case 'read_file': return '读取文件';
      case 'edit_file': return '编辑文件';
      case 'write_file': return '写入文件';
      case 'glob': return '搜索文件';
      case 'grep': return '搜索内容';
      case 'web_fetch': return '获取网页';
      default: return t;
    }
  });
  return `自动录制的工作流：${actions.join(' → ')}（${steps.length} 步）`;
}

function generateSkillMd(name: string, description: string, recording: ComboRecording): string {
  const toolNames = Array.from(recording.toolNames);

  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: "${description}"`,
    'user-invocable: true',
    `allowed-tools: "${toolNames.join(',')}"`,
    'context: inline',
    `metadata:`,
    `  source: combo-recorded`,
    `  recorded-at: "${new Date().toISOString().split('T')[0]}"`,
    `  session: "${recording.sessionId}"`,
    `  steps: "${recording.turns.reduce((s, t) => s + t.steps.length, 0)}"`,
    '---',
  ].join('\n');

  const body: string[] = [];
  body.push('');
  body.push(`# ${name}`);
  body.push('');
  body.push(`> ${description}`);
  body.push('');
  body.push('## 工作流步骤');
  body.push('');

  let stepNum = 1;
  for (const turn of recording.turns) {
    if (turn.userMessage && turn.userMessage !== '(auto)') {
      body.push(`### 用户意图: ${turn.userMessage}`);
      body.push('');
    }
    for (const step of turn.steps) {
      const status = step.success ? '✓' : '✗';
      body.push(`${stepNum}. [${status}] \`${step.toolName}\``);
      if (Object.keys(step.args).length > 0) {
        const argsPreview = Object.entries(step.args)
          .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.substring(0, 80) : JSON.stringify(v)}`)
          .join(', ');
        body.push(`   - 参数: ${argsPreview}`);
      }
      stepNum++;
    }
    body.push('');
  }

  body.push('## 执行指南');
  body.push('');
  body.push('按照上述步骤顺序执行。如果某一步失败，尝试分析原因并修复后重试。');
  body.push('用户可能会根据具体场景修改参数。');

  return frontmatter + '\n' + body.join('\n') + '\n';
}

// ── Singleton ──

let instance: ComboRecorderService | null = null;

export function getComboRecorder(): ComboRecorderService {
  if (!instance) {
    instance = new ComboRecorderService();
  }
  return instance;
}

export function shutdownComboRecorder(): void {
  instance?.shutdown();
  instance = null;
}
