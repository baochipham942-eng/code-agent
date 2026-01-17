// ============================================================================
// Ask User Question Tool - Interactive questions via IPC
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import type { UserQuestionRequest, UserQuestionResponse, UserQuestion } from '../../../shared/types';
import { IPC_CHANNELS } from '../../../shared/ipc';
import { BrowserWindow, ipcMain } from 'electron';

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
  name: 'ask_user_question',
  description: 'Ask the user a question to gather information or clarify requirements',
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
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
              description: 'Available choices (2-4 options)',
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description: 'Option label',
                  },
                  description: {
                    type: 'string',
                    description: 'Option description',
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
    context: ToolContext
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
      id: `q-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      questions,
      timestamp: Date.now(),
    };

    // Get the main window to send IPC event
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      // Fallback: return questions as text if no window
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
        output: `Questions (no UI available):\n\n${formatted}\n\n[Please respond in chat]`,
      };
    }

    // Send question to renderer
    console.log(`[ask_user_question] Sending questions to UI: ${request.id}`);
    mainWindow.webContents.send(IPC_CHANNELS.USER_QUESTION_ASK, request);

    // Wait for response with timeout
    const TIMEOUT_MS = 300000; // 5 minutes

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
