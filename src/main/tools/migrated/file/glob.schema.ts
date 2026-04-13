// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const globSchema: ToolSchema = {
  name: 'Glob',
  description:
    'Fast file pattern matching tool. Use this to find files by name patterns ' +
    "(e.g. '**/*.ts', 'src/**/*.tsx'). Returns matching file paths. " +
    'Use this instead of Bash find or ls commands.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Glob pattern to match files. MUST be a string. ' +
          'Common patterns: "**/*.ts" (all .ts files recursively), ' +
          '"src/**/*.tsx" (TSX files in src), "*.json" (JSON in current dir), ' +
          '"**/*test*.ts" (all test files). ' +
          'Use ** for recursive matching, * for single-level wildcard.',
      },
      path: {
        type: 'string',
        description:
          'Directory to search in. MUST be a string. ' +
          'Default: current working directory. ' +
          'Examples: "/Users/name/project", "~/Documents", "./src". ' +
          'Supports absolute paths, ~ for home, and relative paths.',
      },
    },
    required: ['pattern'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
