import { spawn } from 'child_process';

export interface ClaudeCliOptions {
  prompt: string;
  workDir: string;
  model?: string;
  allowedTools?: string[];
  timeout?: number;
  outputFormat?: 'text' | 'json' | 'stream-json';
  /** 使用的代际 (gen1-gen8)，仅 code-agent 模式有效 */
  gen?: string;
  /** 模型提供商 (deepseek, openai, zhipu)，仅 code-agent 模式有效 */
  provider?: string;
  /** 启用规划模式（复杂任务自动分解），仅 code-agent 模式有效 */
  plan?: boolean;
}

export interface ClaudeCliResult {
  output: string;
  exitCode: number;
  duration: number;
  metrics?: {
    tokensIn?: number;
    tokensOut?: number;
    toolCalls?: number;
    apiCalls?: number;
  };
}

// 支持两种模式：code-agent (默认) 和 claude (官方 CLI)
const CLI_MODE = process.env.CLI_MODE || 'code-agent';

// code-agent 配置
const CODE_AGENT_PATH =
  process.env.CODE_AGENT_PATH ||
  `${process.env.HOME}/Downloads/ai/code-agent/dist/cli/index.cjs`;

// 默认使用智谱 GLM-4.7 (Coding 套餐/开发模式)
const CODE_AGENT_PROVIDER = process.env.CODE_AGENT_PROVIDER || 'zhipu';
const CODE_AGENT_MODEL = process.env.CODE_AGENT_MODEL || 'glm-4.7';
const CODE_AGENT_GEN = process.env.CODE_AGENT_GEN || 'gen3';

const CLAUDE_PATH =
  process.env.CLAUDE_PATH || `${process.env.HOME}/.npm-global/bin/claude`;

export async function runClaude(
  options: ClaudeCliOptions
): Promise<ClaudeCliResult> {
  if (CLI_MODE === 'code-agent') {
    return runCodeAgent(options);
  }
  return runClaudeCli(options);
}

/**
 * 运行 code-agent CLI
 */
async function runCodeAgent(
  options: ClaudeCliOptions
): Promise<ClaudeCliResult> {
  const {
    prompt,
    workDir,
    model = CODE_AGENT_MODEL,
    gen = CODE_AGENT_GEN,
    provider = CODE_AGENT_PROVIDER,
    plan = false,
    timeout = 120000,
  } = options;

  // 不传 --project，因为 cwd 已设置为 workDir
  const args = ['run', prompt, '--json', '--gen', gen, '--provider', provider];

  // 总是传递 model 参数，使用默认值或指定值
  args.push('--model', model);

  // 启用规划模式
  if (plan) {
    args.push('--plan');
  }

  return executeCliProcess('node', [CODE_AGENT_PATH, ...args], workDir, timeout);
}

/**
 * 运行官方 Claude CLI
 */
async function runClaudeCli(
  options: ClaudeCliOptions
): Promise<ClaudeCliResult> {
  const {
    prompt,
    workDir,
    model = 'sonnet',
    allowedTools,
    timeout = 120000,
    outputFormat = 'stream-json',
  } = options;

  const args = [
    '-p',
    '--output-format',
    outputFormat,
    '--model',
    model,
    '--dangerously-skip-permissions',
    ...(outputFormat === 'stream-json' ? ['--verbose'] : []),
  ];

  if (allowedTools?.length) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  args.push(prompt);

  return executeCliProcess(CLAUDE_PATH, args, workDir, timeout);
}

/**
 * 执行 CLI 进程
 */
async function executeCliProcess(
  command: string,
  args: string[],
  workDir: string,
  timeout: number
): Promise<ClaudeCliResult> {
  const startTime = Date.now();
  const debug = process.env.DEBUG_CLI === '1';

  if (debug) {
    console.log(`[DEBUG] Executing: ${command} ${args.join(' ')}`);
    console.log(`[DEBUG] CWD: ${workDir}`);
    console.log(`[DEBUG] Timeout: ${timeout}ms`);
  }

  return new Promise((resolve, reject) => {
    let output = '';
    let errorOutput = '';
    let resolved = false;

    const proc = spawn(command, args, {
      cwd: workDir,
      env: {
        ...process.env,
        NO_COLOR: '1',
        PATH: `${process.env.HOME}/.npm-global/bin:${process.env.HOME}/Downloads/ai/code-agent/node_modules/.bin:${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (debug) {
      console.log(`[DEBUG] Process PID: ${proc.pid}`);
    }

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
      if (debug) {
        console.log(`[DEBUG] stdout: ${chunk.substring(0, 200)}${chunk.length > 200 ? '...' : ''}`);
      }
      // code-agent 现在会在完成后自动调用 process.exit()
      // 不需要手动检测完成状态，让进程自然退出
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      errorOutput += chunk;
      if (debug) {
        console.log(`[DEBUG] stderr: ${chunk.substring(0, 200)}${chunk.length > 200 ? '...' : ''}`);
      }
    });

    proc.on('exit', (code, signal) => {
      if (debug) {
        console.log(`[DEBUG] Process exit: code=${code}, signal=${signal}`);
      }
    });

    proc.on('close', (code, signal) => {
      if (debug) {
        console.log(`[DEBUG] Process close: code=${code}, signal=${signal}`);
      }
      if (resolved) return;
      resolved = true;

      clearTimeout(timer);
      const duration = Date.now() - startTime;
      const metrics = parseMetricsFromOutput(output);

      resolve({
        output: output || errorOutput,
        exitCode: code ?? 1,
        duration,
        metrics,
      });
    });

    proc.on('error', (err) => {
      if (debug) {
        console.log(`[DEBUG] Process error: ${err.message}`);
      }
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn CLI: ${err.message}`));
    });

    // 超时处理
    const timer = setTimeout(() => {
      if (debug) {
        console.log(`[DEBUG] Timeout triggered after ${timeout}ms`);
      }
      if (resolved) return;
      resolved = true;
      proc.kill('SIGTERM');
      reject(new Error(`Timeout after ${timeout}ms`));
    }, timeout);
  });
}

/**
 * 从 NDJSON 输出解析指标
 * 支持 code-agent 和 claude CLI 两种格式
 */
function parseMetricsFromOutput(output: string): ClaudeCliResult['metrics'] {
  try {
    const lines = output.split('\n').filter(Boolean);
    let toolCalls = 0;
    let apiCalls = 0;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        // code-agent 格式
        if (event.type === 'tool_call') {
          toolCalls++;
        }
        // claude CLI 格式
        if (event.type === 'message_start') {
          apiCalls++;
        }
        if (event.type === 'tool_use') {
          toolCalls++;
        }
      } catch {}
    }

    return { toolCalls, apiCalls };
  } catch {
    return undefined;
  }
}
