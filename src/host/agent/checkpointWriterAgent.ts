// ============================================================================
// Checkpoint Writer Agent - 真 LLM 后台子代理（audit C-H1/C-H2 返工）
// ============================================================================
// 参照 MiMo actor.spawn({background, agentType:"checkpoint-writer"}) 模式：
// CheckpointWriterService.start 把本 runner 作为后台 actor 运行（fire-and-forget），
// runner 内部组装会话上下文 → 调 LLM 产出完整 11 段文档 → 强化版 validator
// 独立把关 → 原子写入。验证失败不落盘，上游 fail-closed 跳过重建边界。
// ============================================================================

import type { Message, ModelConfig, ModelProvider } from '../../shared/contract';
import type { SessionTask } from '../../shared/contract/planning';
import { CHECKPOINT_WRITER, DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import { ModelRouter } from '../model/modelRouter';
import { getConfigService } from '../services';
import { listTasks } from '../services/planning/taskStore';
import {
  collectExactFormLiterals,
  validateCheckpointDocument,
  type CheckpointPathTable,
  type CheckpointValidationResult,
} from '../context/checkpoint';
import {
  ensureCheckpointStore,
  readCheckpointStore,
  resolveCheckpointStorePaths,
  writeCheckpointFile,
  type CheckpointStorePaths,
} from '../context/checkpoint/store';
import {
  CHECKPOINT_SECTIONS,
  createCheckpointTemplate,
  replaceSectionBody,
} from '../context/checkpoint/templates';
import {
  buildCheckpointWriterPrompt,
  parseCheckpointWriterResponse,
} from './checkpointWriterPrompt';

const logger = createLogger('CheckpointWriterAgent');

export interface CheckpointWriterJob {
  sessionId: string;
  workingDirectory: string;
  messages: Message[];
  reason: 'periodic' | 'pressure' | 'manual' | 'test';
  rootDir?: string;
  now?: number;
}

export interface CheckpointWriterResult {
  success: boolean;
  checkpointPath: string;
  memoryPath: string;
  error?: string;
  writtenAt: number;
}

/** writer 子代理的 LLM 调用：输入完整 prompt，返回原始文本（测试可注入假实现） */
export type CheckpointWriterLlm = (prompt: string) => Promise<string>;

export interface CheckpointWriterDeps {
  llm?: CheckpointWriterLlm;
  listSessionTasks?: (sessionId: string) => SessionTask[];
}

function pathTable(paths: CheckpointStorePaths): CheckpointPathTable {
  return {
    CHECKPOINT_PATH: paths.checkpointPath,
    MEMORY_PATH: paths.memoryPath,
    TASK_MEM_DIR: paths.taskMemoryDir,
    NOTES_PATH: paths.notesPath,
  };
}

const MEMORY_REQUIRED_HEADINGS = [
  '## Project context',
  '## Rules',
  '## Architecture decisions',
  '## Discovered durable knowledge',
];

function isStructurallyValidMemory(memory: string): boolean {
  return MEMORY_REQUIRED_HEADINGS.every((heading) => memory.includes(heading));
}

/**
 * 结构修复（live-run 加固）：LLM 经常 paraphrase 或漏掉斜体 instruction 行。
 * 结构归代码、内容归 LLM——按 11 个规范头提取 LLM 产出的 body，重组到规范
 * 模板上；标题缺失或乱序时返回 null，交给验证反馈重试。
 */
export function normalizeCheckpointStructure(llmDocument: string): string | null {
  const positions = CHECKPOINT_SECTIONS.map((section) => ({
    section,
    index: llmDocument.indexOf(section.heading),
  }));
  if (positions.some((entry) => entry.index < 0)) return null;
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i].index <= positions[i - 1].index) return null;
  }

  let document = createCheckpointTemplate();
  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i].index + positions[i].section.heading.length;
    const end = i + 1 < positions.length ? positions[i + 1].index : llmDocument.length;
    const lines = llmDocument.slice(start, end).trim().split('\n');
    const first = lines[0]?.trim() ?? '';
    if (first.startsWith('_') && first.endsWith('_') && first.length > 1) {
      lines.shift();
    }
    document = replaceSectionBody(document, positions[i].section.number, lines.join('\n').trim());
  }
  return document;
}

function summarizeValidation(validation: CheckpointValidationResult): string {
  const failures: string[] = [];
  if (validation.missingSections.length > 0) {
    failures.push(`missing sections: ${validation.missingSections.map((n) => `§${n}`).join(', ')}`);
  }
  if (!validation.activeIntentHasVerbatimQuote) {
    failures.push('§1 lacks a block-quoted verbatim user request (> "...")');
  }
  if (validation.missingExactLiterals.length > 0) {
    failures.push(`missing exact-form literals: ${validation.missingExactLiterals.join(' | ')}`);
  }
  if (validation.pathViolations.length > 0) {
    failures.push(`absolute paths outside path table: ${validation.pathViolations.map((v) => v.path).join(', ')}`);
  }
  if (validation.tamperedInstructionSections.length > 0) {
    failures.push(`italic instruction lines modified in: ${validation.tamperedInstructionSections.map((n) => `§${n}`).join(', ')}`);
  }
  if (validation.taskTreeViolations.length > 0) {
    failures.push(validation.taskTreeViolations.join('; '));
  }
  return failures.join('\n');
}

// ----------------------------------------------------------------------------
// 默认 LLM：主模型直调（模型解析仿 compactModel.initializeMainModel）
// ----------------------------------------------------------------------------

let writerModelRouter: ModelRouter | null = null;

function resolveWriterModelConfig(): ModelConfig {
  const configService = getConfigService();
  const settings = configService.getSettings();
  const provider = (settings.model?.provider || DEFAULT_PROVIDER) as ModelProvider;
  const model = settings.model?.model || DEFAULT_MODELS.chat;
  const apiKey = configService.getApiKey(provider)
    || (provider === 'moonshot' ? process.env.KIMI_K25_API_KEY : undefined);
  if (!apiKey) {
    throw new Error(`checkpoint writer: no API key available for provider ${provider}`);
  }
  return {
    provider,
    model,
    apiKey,
    baseUrl: settings.models?.providers?.[provider]?.baseUrl,
    temperature: CHECKPOINT_WRITER.LLM_TEMPERATURE,
    maxTokens: CHECKPOINT_WRITER.LLM_MAX_OUTPUT_TOKENS,
  };
}

async function defaultCheckpointWriterLlm(prompt: string): Promise<string> {
  const config = resolveWriterModelConfig();
  if (!writerModelRouter) {
    writerModelRouter = new ModelRouter();
  }
  const response = await writerModelRouter.inference(
    [{ role: 'user', content: prompt }],
    [],
    config,
  );
  if (!response.content) {
    throw new Error('checkpoint writer: empty LLM response');
  }
  return response.content;
}

// ----------------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------------

export async function runCheckpointWriterAgent(
  job: CheckpointWriterJob,
  deps: CheckpointWriterDeps = {},
): Promise<CheckpointWriterResult> {
  const writtenAt = job.now ?? Date.now();
  const paths = resolveCheckpointStorePaths(job);
  const llm = deps.llm ?? defaultCheckpointWriterLlm;
  const listSessionTasks = deps.listSessionTasks ?? listTasks;

  try {
    await ensureCheckpointStore(paths);
    const current = await readCheckpointStore(paths);
    const tasks = listSessionTasks(job.sessionId);
    const requiredExactLiterals = job.messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => collectExactFormLiterals(message.content));
    const table = pathTable(paths);
    const basePrompt = buildCheckpointWriterPrompt({
      pathTable: table,
      currentCheckpoint: current.checkpoint,
      currentMemory: current.memory,
      currentNotes: current.notes,
      tasks,
      messages: job.messages,
      requiredExactLiterals,
      sessionId: job.sessionId,
      workingDirectory: job.workingDirectory,
      reason: job.reason,
      writtenAt,
      conversationMaxTokens: CHECKPOINT_WRITER.PROMPT_CONVERSATION_MAX_TOKENS,
    });

    let lastFailure = 'writer produced no output';
    for (let attempt = 1; attempt <= CHECKPOINT_WRITER.LLM_MAX_ATTEMPTS; attempt += 1) {
      const prompt = attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nVALIDATION FAILURES of your previous attempt — fix ALL of them:\n${lastFailure}`;
      const raw = await llm(prompt);
      const parsed = parseCheckpointWriterResponse(raw);
      if (!parsed.checkpoint) {
        lastFailure = 'response did not contain a <checkpoint>...</checkpoint> block';
        logger.warn('[CheckpointWriterAgent] unparseable writer response', {
          sessionId: job.sessionId,
          attempt,
        });
        continue;
      }
      const normalized = normalizeCheckpointStructure(parsed.checkpoint);
      if (!normalized) {
        lastFailure = 'checkpoint is missing one of the 11 "## §N <title>" headers, or they are out of order — copy them verbatim from CURRENT CHECKPOINT';
        logger.warn('[CheckpointWriterAgent] checkpoint structure unrecoverable', {
          sessionId: job.sessionId,
          attempt,
        });
        continue;
      }
      const validation = validateCheckpointDocument(normalized, {
        requiredExactLiterals,
        pathTable: table,
        tasks: tasks.map((task) => ({ id: task.id, status: task.status })),
      });
      if (!validation.valid) {
        lastFailure = summarizeValidation(validation);
        logger.warn('[CheckpointWriterAgent] checkpoint validation failed', {
          sessionId: job.sessionId,
          attempt,
          failures: lastFailure,
        });
        continue;
      }

      await writeCheckpointFile(paths.checkpointPath, normalized);
      if (parsed.memory) {
        if (isStructurallyValidMemory(parsed.memory)) {
          await writeCheckpointFile(paths.memoryPath, parsed.memory);
        } else {
          // memory 是次要产物：结构残缺时跳过写入，不拖垮 checkpoint 本身
          logger.warn('[CheckpointWriterAgent] memory block missing required headings; skipped', {
            sessionId: job.sessionId,
          });
        }
      }
      logger.info('[CheckpointWriterAgent] checkpoint written by LLM subagent', {
        sessionId: job.sessionId,
        reason: job.reason,
        attempt,
        taskCount: tasks.length,
      });
      return {
        success: true,
        checkpointPath: paths.checkpointPath,
        memoryPath: paths.memoryPath,
        writtenAt,
      };
    }
    throw new Error(`checkpoint validation failed after ${CHECKPOINT_WRITER.LLM_MAX_ATTEMPTS} attempts: ${lastFailure}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[CheckpointWriterAgent] checkpoint write failed', {
      sessionId: job.sessionId,
      reason: job.reason,
      error: message,
    });
    return {
      success: false,
      checkpointPath: paths.checkpointPath,
      memoryPath: paths.memoryPath,
      error: message,
      writtenAt,
    };
  }
}
