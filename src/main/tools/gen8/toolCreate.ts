// ============================================================================
// Tool Create - Dynamically create new tools at runtime
// Gen 8: Self-Evolution capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

interface DynamicTool {
  id: string;
  name: string;
  description: string;
  type: 'bash_script' | 'http_api' | 'file_processor' | 'composite';
  config: Record<string, unknown>;
  createdAt: number;
  usageCount: number;
}

// Registry of dynamically created tools
const dynamicTools: Map<string, DynamicTool> = new Map();

export const toolCreateTool: Tool = {
  name: 'tool_create',
  description: `Dynamically create new tools at runtime.

Use this tool to:
- Create bash script wrappers as tools
- Create HTTP API caller tools
- Create file processor tools
- Create composite tools combining existing tools

Parameters:
- action: create, execute, list, delete
- name: Tool name (for create)
- description: Tool description (for create)
- type: Tool type (bash_script, http_api, file_processor, composite)
- config: Tool-specific configuration

For bash_script:
  config: { script: "bash commands", args: ["arg1", "arg2"] }

For http_api:
  config: { url: "https://...", method: "GET|POST", headers: {}, bodyTemplate: {} }

For file_processor:
  config: { pattern: "*.md", operation: "read|transform|aggregate" }

For composite:
  config: { tools: ["tool1", "tool2"], sequence: true|false }`,
  generations: ['gen8'],
  requiresPermission: true,
  permissionLevel: 'execute',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'execute', 'list', 'delete', 'export'],
        description: 'Action to perform',
      },
      name: {
        type: 'string',
        description: 'Tool name (no spaces, lowercase)',
      },
      description: {
        type: 'string',
        description: 'Tool description',
      },
      type: {
        type: 'string',
        enum: ['bash_script', 'http_api', 'file_processor', 'composite'],
        description: 'Type of tool to create',
      },
      config: {
        type: 'object',
        description: 'Tool-specific configuration',
      },
      toolId: {
        type: 'string',
        description: 'Tool ID for execute/delete',
      },
      args: {
        type: 'object',
        description: 'Arguments for execute action',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'create':
        return createTool(params, context);

      case 'execute':
        return executeTool(params, context);

      case 'list':
        return listTools();

      case 'delete':
        return deleteTool(params);

      case 'export':
        return exportTool(params, context);

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};

function createTool(
  params: Record<string, unknown>,
  context: ToolContext
): ToolExecutionResult {
  const name = params.name as string;
  const description = params.description as string;
  const type = params.type as DynamicTool['type'];
  const config = params.config as Record<string, unknown>;

  if (!name || !description || !type || !config) {
    return {
      success: false,
      error: 'name, description, type, and config are required for create action',
    };
  }

  // Validate name (no spaces, lowercase, alphanumeric + underscore)
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    return {
      success: false,
      error: 'Tool name must be lowercase, start with a letter, and contain only letters, numbers, and underscores',
    };
  }

  // Check for name conflicts
  if (dynamicTools.has(name)) {
    return {
      success: false,
      error: `Tool with name "${name}" already exists`,
    };
  }

  // Validate config based on type
  const validationResult = validateConfig(type, config);
  if (!validationResult.valid) {
    return {
      success: false,
      error: validationResult.error!,
    };
  }

  const id = `dynamic_${name}_${Date.now()}`;

  const tool: DynamicTool = {
    id,
    name,
    description,
    type,
    config,
    createdAt: Date.now(),
    usageCount: 0,
  };

  dynamicTools.set(name, tool);

  return {
    success: true,
    output: `Dynamic tool created successfully:
- Name: ${name}
- Type: ${type}
- ID: ${id}

Use action='execute' with toolId='${name}' to run this tool.
Use action='export' to save as a permanent tool file.`,
  };
}

async function executeTool(
  params: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const toolId = params.toolId as string;
  const args = (params.args as Record<string, unknown>) || {};

  if (!toolId) {
    return {
      success: false,
      error: 'toolId is required for execute action',
    };
  }

  const tool = dynamicTools.get(toolId);
  if (!tool) {
    return {
      success: false,
      error: `Dynamic tool not found: ${toolId}`,
    };
  }

  tool.usageCount++;

  try {
    switch (tool.type) {
      case 'bash_script':
        return await executeBashScript(tool, args, context);

      case 'http_api':
        return await executeHttpApi(tool, args);

      case 'file_processor':
        return await executeFileProcessor(tool, args, context);

      case 'composite':
        return await executeComposite(tool, args, context);

      default:
        return { success: false, error: `Unknown tool type: ${tool.type}` };
    }
  } catch (error) {
    return {
      success: false,
      error: `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function executeBashScript(
  tool: DynamicTool,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const config = tool.config as { script: string; args?: string[] };
  let script = config.script;

  // Replace placeholders with args
  for (const [key, value] of Object.entries(args)) {
    script = script.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), String(value));
  }

  // Security: Don't allow certain dangerous patterns
  const dangerousPatterns = [
    /rm\s+-rf\s+[\/~]/,
    />\s*\/dev\/sd/,
    /mkfs\./,
    /dd\s+if=/,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(script)) {
      return {
        success: false,
        error: 'Script contains potentially dangerous commands',
      };
    }
  }

  const { stdout, stderr } = await execAsync(script, {
    cwd: context.workingDirectory,
    timeout: 30000,
  });

  return {
    success: true,
    output: `Script executed successfully:\n\n${stdout}${stderr ? `\nStderr:\n${stderr}` : ''}`,
  };
}

async function executeHttpApi(
  tool: DynamicTool,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const config = tool.config as {
    url: string;
    method: string;
    headers?: Record<string, string>;
    bodyTemplate?: Record<string, unknown>;
  };

  let url = config.url;
  let body = config.bodyTemplate ? { ...config.bodyTemplate } : undefined;

  // Replace placeholders in URL and body
  for (const [key, value] of Object.entries(args)) {
    url = url.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), String(value));
    if (body) {
      body = JSON.parse(
        JSON.stringify(body).replace(new RegExp(`\\$\\{${key}\\}`, 'g'), String(value))
      );
    }
  }

  const response = await fetch(url, {
    method: config.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...config.headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseText = await response.text();

  return {
    success: response.ok,
    output: `HTTP ${response.status} ${response.statusText}\n\n${responseText.substring(0, 2000)}`,
  };
}

async function executeFileProcessor(
  tool: DynamicTool,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const config = tool.config as {
    pattern: string;
    operation: 'read' | 'transform' | 'aggregate';
    transformScript?: string;
  };

  const pattern = config.pattern;
  const dir = (args.directory as string) || context.workingDirectory;

  // Find matching files
  const { stdout } = await execAsync(`find "${dir}" -name "${pattern}" -type f 2>/dev/null | head -100`);
  const files = stdout.trim().split('\n').filter(Boolean);

  if (files.length === 0) {
    return {
      success: true,
      output: `No files matching pattern "${pattern}" found in ${dir}`,
    };
  }

  switch (config.operation) {
    case 'read': {
      const contents = await Promise.all(
        files.slice(0, 10).map(async (file) => {
          const content = await fs.promises.readFile(file, 'utf-8');
          return `## ${path.basename(file)}\n${content.substring(0, 500)}...`;
        })
      );
      return {
        success: true,
        output: `Found ${files.length} files. First 10:\n\n${contents.join('\n\n')}`,
      };
    }

    case 'aggregate': {
      const stats = await Promise.all(
        files.map(async (file) => {
          const content = await fs.promises.readFile(file, 'utf-8');
          return {
            file: path.basename(file),
            lines: content.split('\n').length,
            chars: content.length,
          };
        })
      );

      const totalLines = stats.reduce((sum, s) => sum + s.lines, 0);
      const totalChars = stats.reduce((sum, s) => sum + s.chars, 0);

      return {
        success: true,
        output: `Aggregated stats for ${files.length} files:
- Total lines: ${totalLines}
- Total characters: ${totalChars}
- Average lines per file: ${(totalLines / files.length).toFixed(0)}`,
      };
    }

    default:
      return { success: false, error: `Unknown operation: ${config.operation}` };
  }
}

async function executeComposite(
  tool: DynamicTool,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const config = tool.config as {
    tools: string[];
    sequence: boolean;
  };

  const results: string[] = [];

  if (config.sequence) {
    // Execute tools sequentially
    for (const toolName of config.tools) {
      const subTool = dynamicTools.get(toolName);
      if (!subTool) {
        results.push(`[${toolName}] Not found`);
        continue;
      }

      const result = await executeTool({ toolId: toolName, args }, context);
      results.push(`[${toolName}] ${result.success ? '✅' : '❌'}\n${result.output || result.error}`);
    }
  } else {
    // Execute tools in parallel
    const promises = config.tools.map(async (toolName) => {
      const subTool = dynamicTools.get(toolName);
      if (!subTool) {
        return `[${toolName}] Not found`;
      }

      const result = await executeTool({ toolId: toolName, args }, context);
      return `[${toolName}] ${result.success ? '✅' : '❌'}\n${result.output || result.error}`;
    });

    const parallelResults = await Promise.all(promises);
    results.push(...parallelResults);
  }

  return {
    success: true,
    output: `Composite tool executed:\n\n${results.join('\n\n---\n\n')}`,
  };
}

function listTools(): ToolExecutionResult {
  const tools = Array.from(dynamicTools.values());

  if (tools.length === 0) {
    return {
      success: true,
      output: 'No dynamic tools created yet.',
    };
  }

  const output = tools.map((t) => {
    return `- **${t.name}** [${t.type}]
  ${t.description}
  Uses: ${t.usageCount} | Created: ${new Date(t.createdAt).toLocaleString()}`;
  }).join('\n\n');

  return {
    success: true,
    output: `## Dynamic Tools (${tools.length})\n\n${output}`,
  };
}

function deleteTool(params: Record<string, unknown>): ToolExecutionResult {
  const toolId = params.toolId as string;

  if (!toolId) {
    return {
      success: false,
      error: 'toolId is required for delete action',
    };
  }

  const tool = dynamicTools.get(toolId);
  if (!tool) {
    return {
      success: false,
      error: `Tool not found: ${toolId}`,
    };
  }

  dynamicTools.delete(toolId);

  return {
    success: true,
    output: `Tool "${tool.name}" deleted successfully.`,
  };
}

async function exportTool(
  params: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const toolId = params.toolId as string;

  if (!toolId) {
    return {
      success: false,
      error: 'toolId is required for export action',
    };
  }

  const tool = dynamicTools.get(toolId);
  if (!tool) {
    return {
      success: false,
      error: `Tool not found: ${toolId}`,
    };
  }

  // Generate TypeScript tool file
  const tsCode = generateToolCode(tool);

  const outputPath = path.join(
    context.workingDirectory,
    '.dynamic-tools',
    `${tool.name}.ts`
  );

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, tsCode);

  return {
    success: true,
    output: `Tool exported to: ${outputPath}

You can now import this tool into the ToolRegistry for permanent use.`,
  };
}

function validateConfig(
  type: DynamicTool['type'],
  config: Record<string, unknown>
): { valid: boolean; error?: string } {
  switch (type) {
    case 'bash_script':
      if (!config.script || typeof config.script !== 'string') {
        return { valid: false, error: 'bash_script requires config.script (string)' };
      }
      break;

    case 'http_api':
      if (!config.url || typeof config.url !== 'string') {
        return { valid: false, error: 'http_api requires config.url (string)' };
      }
      break;

    case 'file_processor':
      if (!config.pattern || typeof config.pattern !== 'string') {
        return { valid: false, error: 'file_processor requires config.pattern (string)' };
      }
      if (!config.operation || !['read', 'transform', 'aggregate'].includes(config.operation as string)) {
        return { valid: false, error: 'file_processor requires config.operation (read|transform|aggregate)' };
      }
      break;

    case 'composite':
      if (!Array.isArray(config.tools) || config.tools.length === 0) {
        return { valid: false, error: 'composite requires config.tools (string[])' };
      }
      break;
  }

  return { valid: true };
}

function generateToolCode(tool: DynamicTool): string {
  return `// Auto-generated tool: ${tool.name}
// Generated at: ${new Date().toISOString()}

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';

export const ${tool.name}Tool: Tool = {
  name: '${tool.name}',
  description: \`${tool.description}\`,
  generations: ['gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      // Add your input parameters here
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    // Tool configuration
    const config = ${JSON.stringify(tool.config, null, 2)};

    // Implementation based on type: ${tool.type}
    // TODO: Implement your tool logic here

    return {
      success: true,
      output: 'Tool executed successfully',
    };
  },
};
`;
}

// Export function to get dynamic tools (for SubagentExecutor)
export function getDynamicTools(): DynamicTool[] {
  return Array.from(dynamicTools.values());
}
