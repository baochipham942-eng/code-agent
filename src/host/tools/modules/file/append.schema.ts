import type { ToolSchema } from '../../../protocol/tools';

export const appendSchema: ToolSchema = {
  name: 'Append',
  description:
    'Appends text to a local file. Use this for large generated artifacts that are too big ' +
    'for one Write call: Write the initial file or first chunk, then Append ordered chunks. ' +
    'Parent directories are created automatically. Set final=true only on the last chunk so ' +
    'the runtime can run post-write validation.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute path where content will be appended. MUST be a string. ' +
          'Supports ~ for home directory and creates parent directories automatically.',
      },
      content: {
        type: 'string',
        description:
          'The exact text chunk to append. Keep large generated artifacts in ordered chunks ' +
          'instead of sending the complete file in one tool call.',
      },
      final: {
        type: 'boolean',
        description:
          'Set to true only for the last chunk of a generated artifact. This enables final validation.',
      },
    },
    required: ['file_path', 'content'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
