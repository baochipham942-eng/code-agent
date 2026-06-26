// Schema-only file (P1 Wave 3 — planning native migration)
//
// IMPORTANT: This schema is read by both the LLM (via inputSchema) and renderer
// (via IPC channel USER_QUESTION_ASK). Keep field names / required / enum
// aligned with shared/contract UserQuestion type and shared/ipc legacy channels.
import type { ToolSchema } from '../../../protocol/tools';

export const askUserQuestionSchema: ToolSchema = {
  name: 'AskUserQuestion',
  description: `Asks the user a question and waits for their response. Use when you need clarification, confirmation, or additional information to proceed. Do NOT use this for simple status updates — just output text directly.`,
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
  category: 'planning',
  permissionLevel: 'execute',
};
