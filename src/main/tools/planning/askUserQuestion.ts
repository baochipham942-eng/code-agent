// ============================================================================
// Ask User Question Tool - Interactive questions via IPC
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import type { UserQuestionRequest, UserQuestionResponse, UserQuestion } from '../../../shared/types';
import { IPC_CHANNELS } from '../../../shared/ipc';
import { BrowserWindow, ipcMain } from 'electron';
import { createLogger } from '../../services/infra/logger';
import { INTERACTION_TIMEOUTS } from '../../../shared/constants';

const logger = createLogger('AskUserQuestion');

// Store pending question requests
const pendingQuestions = new Map<string, {
  resolve: (response: UserQuestionResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

// Register IPC handler for user responses (only once)
let handlerRegistered = false;

function registerResponseHandler() {
  if (handlerRegistered) return;
  handlerRegistered = true;

  ipcMain.handle(IPC_CHANNELS.USER_QUESTION_RESPONSE, async (_event, response: UserQuestionResponse) => {
    const pending = pendingQuestions.get(response.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingQuestions.delete(response.requestId);
      pending.resolve(response);
    }
  });
}

export const askUserQuestionTool: Tool = {
  name: 'AskUserQuestion',
  description: `Asks the user a question and waits for their response. Use when you need clarification, confirmation, or additional information to proceed. Do NOT use this for simple status updates — just output text directly.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Array of questions to ask (1-4 questions)',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question to ask',
            },
            header: {
              type: 'string',
              description: 'Short label for the question (max 12 chars)',
            },
            options: {
              type: 'array',
              description: 'Available choices (2-4 options). For technical choices, mark the recommended one with "(推荐)" suffix.',
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description: 'Option label. Add "(推荐)" suffix for AI-recommended technical choices.',
                  },
                  description: {
                    type: 'string',
                    description: 'Detailed description explaining what this option means, when to use it, and pros/cons.',
                  },
                },
              },
            },
            multiSelect: {
              type: 'boolean',
              description: 'Allow multiple selections (default: false)',
            },
          },
        },
      },
    },
    required: ['questions'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const questions = params.questions as UserQuestion[];

    if (!Array.isArray(questions) || questions.length === 0) {
      return {
        success: false,
        error: 'questions must be a non-empty array',
      };
    }

    if (questions.length > 4) {
      return {
        success: false,
        error: 'Maximum 4 questions allowed',
      };
    }

    // Validate questions
    for (const q of questions) {
      if (!q.question || !q.header || !q.options) {
        return {
          success: false,
          error: 'Each question must have question, header, and options',
        };
      }

      if (q.options.length < 2 || q.options.length > 4) {
        return {
          success: false,
          error: 'Each question must have 2-4 options',
        };
      }
    }

    // Register response handler
    registerResponseHandler();

    // Create request
    const request: UserQuestionRequest = {
      id: `q-${Date.now()}-${crypto.randomUUID().split('-')[0]}`,
      questions,
      timestamp: Date.now(),
    };

    // Get the main window to send IPC event
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      // CLI 模式：无法交互，返回明确的"用户未响应"信号。
      // 之前返回 "[Please respond in chat]" 会被模型误解为"用户没反对"从而自行决定，
      // 导致模型执行了不应执行的操作（如创建用户没要求创建的文件）。
      const formatted = questions
        .map((q, i) => {
          const optionsStr = q.options
            .map((o, j) => `  ${j + 1}. ${o.label} - ${o.description}`)
            .join('\n');
          return `[${q.header}] ${q.question}\n${optionsStr}`;
        })
        .join('\n\n');

      return {
        success: true,
        output: `[用户未响应 - CLI 模式无法交互]\n\n${formatted}\n\n⚠️ 用户无法回答问题。请不要自行选择选项，而是基于当前已知信息给出分析和建议，等待用户下一步指示。不要创建、修改或删除任何文件。`,
      };
    }

    // Send question to renderer
    logger.info('Sending questions to UI', { requestId: request.id });
    mainWindow.webContents.send(IPC_CHANNELS.USER_QUESTION_ASK, request);

    // Wait for response with timeout
    const TIMEOUT_MS = INTERACTION_TIMEOUTS.USER_QUESTION;

    try {
      const response = await new Promise<UserQuestionResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingQuestions.delete(request.id);
          reject(new Error('Question timeout - no response from user'));
        }, TIMEOUT_MS);

        pendingQuestions.set(request.id, { resolve, reject, timeout });
      });

      // Format response
      const answerLines = Object.entries(response.answers).map(([header, answer]) => {
        const answerStr = Array.isArray(answer) ? answer.join(', ') : answer;
        return `[${header}]: ${answerStr}`;
      });

      return {
        success: true,
        output: `User responses:\n${answerLines.join('\n')}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get user response',
      };
    }
  },
};
