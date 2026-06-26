// Schema-only file for Blob artifact inspection
import type { ToolSchema } from '../../../protocol/tools';

export const blobSchema: ToolSchema = {
  name: 'Blob',
  description:
    'Inspect or read a local file as a unified artifact/blob. Use this for binary files, images, generated outputs, downloaded files, or when you need mime/size/hash metadata. For normal source text, Read is still better.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['stat', 'read_text', 'read_base64'],
        description: 'stat returns metadata only; read_text returns a UTF-8 preview; read_base64 returns base64 for small binary slices.',
      },
      file_path: {
        type: 'string',
        description: 'Absolute path, ~/ path, or path relative to the working directory.',
      },
      offset: {
        type: 'number',
        description: 'Byte offset for read_text/read_base64. Default: 0.',
      },
      max_bytes: {
        type: 'number',
        description: 'Maximum bytes to read. Default: 65536, max: 2097152.',
      },
    },
    required: ['action', 'file_path'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
