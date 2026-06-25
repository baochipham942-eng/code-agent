// Schema-only file — read archived tool outputs by ArchiveRef.
import type { ToolSchema } from '../../../protocol/tools';

export const toolResultArchiveSchema: ToolSchema = {
  name: 'read_tool_result_archive',
  description:
    'Reads a previously archived large tool result by artifact_id. Use this when a tool result notice includes archive=... ' +
    'and you need the original output instead of the truncated context copy. Supports offset and limit for line pagination.',
  inputSchema: {
    type: 'object',
    properties: {
      artifact_id: {
        type: 'string',
        description: 'Archive artifact id from a tool result spill notice, for example tool_result:session:Bash:call:hash.',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from. Integer, 1-indexed. Default: 1.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read. Default: 2000, maximum: 5000.',
      },
    },
    required: ['artifact_id'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
