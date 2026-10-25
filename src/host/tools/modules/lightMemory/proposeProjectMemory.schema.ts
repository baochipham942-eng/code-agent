// Schema-only file — ProposeProjectMemory 的单一真源。
// 只写 candidate。确认前不生效，同键不覆盖。不要走 MemoryWrite（那会写成生效记忆）。
import type { ToolSchema } from '../../../protocol/tools';

export const proposeProjectMemorySchema: ToolSchema = {
  name: 'ProposeProjectMemory',
  description:
    'Save one project-memory draft for the current working directory as a candidate. ' +
    'It does not take effect until a person confirms it in Settings -> Memory. ' +
    'This tool never writes an active memory. Call it once per topic: ' +
    '"purpose" (what this project is for), "key-files" (each path plus one line), ' +
    '"conventions" (habits actually observed in the files). ' +
    'Write only facts seen in files. If this topic already exists, the tool returns the existing content ' +
    'and does not overwrite it — do not call again for that topic; suggest improvements in the reply. ' +
    'sources must be paths inside the working directory. Do not use MemoryWrite for this.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        enum: ['purpose', 'key-files', 'conventions'],
        description:
          'Which draft to save. purpose = what this project is for. ' +
          'key-files = important files, one relative path and one line each. ' +
          'conventions = habits observed in the files.',
      },
      summary: {
        type: 'string',
        description: 'One-line summary of this draft.',
      },
      content: {
        type: 'string',
        description:
          'Draft body. Only facts read from files. Use the folder\'s main language. ' +
          'An empty body is rejected.',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Relative paths, inside the working directory, of files this draft is based on. ' +
          'A path that resolves outside the folder is rejected.',
      },
    },
    required: ['topic', 'summary', 'content', 'sources'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};
