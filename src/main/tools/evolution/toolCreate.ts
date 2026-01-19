// ============================================================================
// Tool Create - Dynamically create new tools at runtime
// Gen 8: Self-Evolution capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { executeSandboxed } from '../evolution/sandbox';

const execAsync = promisify(exec);

// Tool types - sandboxed_js is the new secure type
type DynamicToolType = 'bash_script' | 'http_api' | 'file_processor' | 'composite' | 'sandboxed_js';

interface DynamicTool {
  id: string;
  name: string;
  description: string;
  type: DynamicToolType;
  config: Record<string, unknown>;
  createdAt: number;
  usageCount: number;
}

// Registry of dynamically created tools
const dynamicTools: Map<string, DynamicTool> = new Map();

// Pending tool create requests waiting for user confirmation
interface PendingRequest {
  resolve: (allowed: boolean) => void;
  timeout: NodeJS.Timeout;
}
const pendingRequests: Map<string, PendingRequest> = new Map();

/**
 * Request user confirmation for tool creation
 * Called from UI via IPC
 */
export function handleToolCreateResponse(requestId: string, allowed: boolean): void {
  const pending = pendingRequests.get(requestId);
  if (pending) {
    clearTimeout(pending.timeout);
    pending.resolve(allowed);
    pendingRequests.delete(requestId);
    console.log(`[toolCreate] User ${allowed ? 'allowed' : 'denied'} tool creation: ${requestId}`);
  }
}

/**
 * Send tool create request to renderer and wait for user response
 */
async function requestUserConfirmation(
  tool: {
    name: string;
    description: string;
    type: string;
    code?: string;
    script?: string;
  }
): Promise<boolean> {
  // Check if devModeAutoApprove is enabled
  try {
    const { getConfigService } = await import('../../services');
    const configService = getConfigService();
    if (configService.isDevModeAutoApproveEnabled()) {
      console.log('[toolCreate] devModeAutoApprove enabled, auto-approving tool creation');
      return true;
    }
  } catch (e) {
    // Continue with user confirmation if config service unavailable
  }

  // Generate unique request ID
  const requestId = `tool_create_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  return new Promise<boolean>((resolve) => {
    // Set timeout (30 seconds to respond)
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      console.log(`[toolCreate] Request timed out: ${requestId}`);
      resolve(false); // Default to deny on timeout
    }, 30000);

    // Store pending request
    pendingRequests.set(requestId, { resolve, timeout });

    // Send request to renderer
    const { BrowserWindow } = require('electron');
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('security:tool-create-request', {
        id: requestId,
        name: tool.name,
        description: tool.description,
        type: tool.type,
        code: tool.code,
        script: tool.script,
      });
      console.log(`[toolCreate] Sent confirmation request to UI: ${requestId}`);
    } else {
      // No window available, deny
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      resolve(false);
    }
  });
}

export const toolCreateTool: Tool = {
  name: 'tool_create',
  description: `Dynamically create new tools at runtime.

Use this tool to:
- Create sandboxed JavaScript tools (RECOMMENDED - most secure)
- Create HTTP API caller tools
- Create file processor tools
- Create composite tools combining existing tools
- Create bash script wrappers (requires explicit approval)

Parameters:
- action: create, execute, list, delete
- name: Tool name (for create)
- description: Tool description (for create)
- type: Tool type (sandboxed_js, http_api, file_processor, composite, bash_script)
- config: Tool-specific configuration

For sandboxed_js (RECOMMENDED):
  config: { code: "// Pure JS code, no require/import/process" }
  - Runs in isolated V8 sandbox
  - 32MB memory limit, 5s timeout
  - No access to Node.js APIs

For http_api:
  config: { url: "https://...", method: "GET|POST", headers: {}, bodyTemplate: {} }

For file_processor:
  config: { pattern: "*.md", operation: "read|transform|aggregate" }

For composite:
  config: { tools: ["tool1", "tool2"], sequence: true|false }

For bash_script (DANGEROUS - requires approval):
  config: { script: "bash commands", args: ["arg1", "arg2"] }`,
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
        enum: ['sandboxed_js', 'http_api', 'file_processor', 'composite', 'bash_script'],
        description: 'Type of tool to create (sandboxed_js recommended)',
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

async function createTool(
  params: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
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

  // Request user confirmation before creating the tool
  const toolInfo = {
    name,
    description,
    type,
    code: config.code as string | undefined,
    script: config.script as string | undefined,
  };

  const allowed = await requestUserConfirmation(toolInfo);
  if (!allowed) {
    return {
      success: false,
      error: '⚠️ 工具创建已被用户拒绝',
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
      case 'sandboxed_js':
        return await executeSandboxedJs(tool, args);

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

/**
 * Execute sandboxed JavaScript code in isolated-vm
 * This is the most secure execution method
 */
async function executeSandboxedJs(
  tool: DynamicTool,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const config = tool.config as { code: string };

  if (!config.code) {
    return {
      success: false,
      error: 'sandboxed_js requires config.code',
    };
  }

  // Inject args into the code as a constant
  const argsJson = JSON.stringify(args);
  const wrappedCode = `
    const args = ${argsJson};
    ${config.code}
  `;

  const result = await executeSandboxed(wrappedCode, {
    memoryLimit: 32,
    timeout: 5000,
  });

  if (result.success) {
    return {
      success: true,
      output: `Sandboxed JS executed successfully (${result.executionTime}ms):\n\n${
        typeof result.output === 'object'
          ? JSON.stringify(result.output, null, 2)
          : String(result.output ?? 'undefined')
      }`,
    };
  } else {
    return {
      success: false,
      error: `Sandboxed execution failed: ${result.error}`,
    };
  }
}

/**
 * Execute bash script - DANGEROUS, requires explicit user approval
 * Enhanced security checks
 */
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

  // Enhanced security: Comprehensive dangerous pattern detection
  const dangerousPatterns = [
    { pattern: /rm\s+-rf\s+[\/~]/, message: 'Dangerous rm -rf command' },
    { pattern: />\s*\/dev\/sd/, message: 'Writing to disk device' },
    { pattern: /mkfs\./, message: 'Filesystem creation command' },
    { pattern: /dd\s+if=/, message: 'Dangerous dd command' },
    { pattern: /curl.*\|\s*(ba)?sh/, message: 'Piping curl to shell' },
    { pattern: /wget.*\|\s*(ba)?sh/, message: 'Piping wget to shell' },
    { pattern: /chmod\s+777/, message: 'Setting insecure permissions' },
    { pattern: /sudo\s+/, message: 'Sudo command not allowed' },
    { pattern: />\s*\/etc\//, message: 'Writing to /etc/' },
    { pattern: />\s*\/usr\//, message: 'Writing to /usr/' },
    { pattern: />\s*\/var\//, message: 'Writing to /var/' },
    { pattern: />\s*\/bin\//, message: 'Writing to /bin/' },
    { pattern: />\s*\/sbin\//, message: 'Writing to /sbin/' },
    { pattern: /:\(\)\{.*\}/, message: 'Fork bomb detected' },
    { pattern: /\$\(.*rm\s/, message: 'Command substitution with rm' },
    { pattern: /`.*rm\s/, message: 'Backtick substitution with rm' },
  ];

  for (const { pattern, message } of dangerousPatterns) {
    if (pattern.test(script)) {
      return {
        success: false,
        error: `⚠️ 安全警告: ${message}\n脚本已被阻止执行`,
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
  type: DynamicToolType,
  config: Record<string, unknown>
): { valid: boolean; error?: string } {
  switch (type) {
    case 'sandboxed_js':
      if (!config.code || typeof config.code !== 'string') {
        return { valid: false, error: 'sandboxed_js requires config.code (string)' };
      }
      break;

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
