// ============================================================================
// Serve Command - HTTP API 服务模式
// ============================================================================

import { Command } from 'commander';
import http from 'http';
import { createCLIAgent, CLIAgent } from '../adapter';
import { terminalOutput } from '../output';
import { cleanup, initializeCLIServices, buildCLIConfig } from '../bootstrap';
import type { CLIGlobalOptions, APIRunRequest, APIStatusResponse, SSEEvent } from '../types';
import type { AgentEvent } from '../../shared/types';
import { createLogger } from '../../main/services/infra/logger';
import { DEFAULT_GENERATION } from '../../shared/constants';

const logger = createLogger('CLI-Serve');

// 全局状态
let currentTask: {
  id: string;
  prompt: string;
  startTime: number;
  agent: CLIAgent;
} | null = null;

export const serveCommand = new Command('serve')
  .description('启动 HTTP API 服务')
  .option('--port <port>', '服务端口', '8080')
  .option('--host <host>', '绑定地址', '127.0.0.1')
  .action(async (options: { port: string; host: string }, command: Command) => {
    const globalOpts = command.parent?.opts() as CLIGlobalOptions;
    const port = parseInt(options.port, 10);
    const host = options.host;

    try {
      // 初始化服务
      await initializeCLIServices();

      terminalOutput.info(`项目目录: ${globalOpts?.project || process.cwd()}`);
      terminalOutput.info(`代际: ${globalOpts?.gen || DEFAULT_GENERATION}`);

      // 创建 HTTP 服务器
      const server = http.createServer(async (req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url || '/', `http://${host}:${port}`);

        try {
          // 路由
          if (url.pathname === '/api/run' && req.method === 'POST') {
            await handleRun(req, res, globalOpts);
          } else if (url.pathname === '/api/status' && req.method === 'GET') {
            handleStatus(res);
          } else if (url.pathname === '/api/health' && req.method === 'GET') {
            handleHealth(res);
          } else if (url.pathname === '/api/cancel' && req.method === 'POST') {
            handleCancel(res);
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
          }
        } catch (error) {
          logger.error('Request error', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: error instanceof Error ? error.message : 'Internal Server Error',
          }));
        }
      });

      // 启动服务
      server.listen(port, host, () => {
        terminalOutput.success(`HTTP API 服务已启动: http://${host}:${port}`);
        console.log(`
可用接口:
  POST /api/run     执行任务 (SSE 流式响应)
  GET  /api/status  获取当前状态
  POST /api/cancel  取消当前任务
  GET  /api/health  健康检查

示例:
  curl -X POST http://${host}:${port}/api/run \\
    -H "Content-Type: application/json" \\
    -d '{"prompt": "列出当前目录文件"}'
`);
      });

      // 优雅退出
      const shutdown = async () => {
        console.log('\n正在关闭服务...');
        server.close();
        await cleanup();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      terminalOutput.error(message);
      await cleanup();
      process.exit(1);
    }
  });

/**
 * 处理 /api/run 请求
 */
async function handleRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  globalOpts: CLIGlobalOptions
): Promise<void> {
  // 检查是否已有任务在运行
  if (currentTask) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'A task is already running',
      taskId: currentTask.id,
    }));
    return;
  }

  // 解析请求体
  const body = await readBody(req);
  let request: APIRunRequest;

  try {
    request = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  if (!request.prompt) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing prompt' }));
    return;
  }

  // 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // 创建 Agent
  const agent = await createCLIAgent({
    project: request.project || globalOpts?.project,
    gen: request.generation || globalOpts?.gen,
    model: request.model || globalOpts?.model,
    provider: request.provider || globalOpts?.provider,
    json: true, // 内部使用 JSON 格式
    debug: globalOpts?.debug,
  });

  // 设置当前任务
  const taskId = `task-${Date.now()}`;
  currentTask = {
    id: taskId,
    prompt: request.prompt,
    startTime: Date.now(),
    agent,
  };

  // 发送任务开始事件
  sendSSE(res, 'task_start', { taskId, prompt: request.prompt });

  // 运行任务
  try {
    // 创建自定义的 AgentLoop 来捕获事件
    const config = agent.getConfig();
    const { createAgentLoop } = await import('../bootstrap');

    const agentLoop = createAgentLoop(
      config,
      (event: AgentEvent) => {
        // 转发事件到 SSE
        sendSSE(res, event.type, event.data);
      }
    );

    await agentLoop.run(request.prompt);

    // 发送完成事件
    sendSSE(res, 'task_complete', {
      taskId,
      duration: Date.now() - currentTask.startTime,
    });
  } catch (error) {
    sendSSE(res, 'error', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    currentTask = null;
    res.end();
  }
}

/**
 * 处理 /api/status 请求
 */
function handleStatus(res: http.ServerResponse): void {
  const status: APIStatusResponse = currentTask
    ? {
        running: true,
        taskId: currentTask.id,
        task: currentTask.prompt,
        startTime: currentTask.startTime,
        duration: Date.now() - currentTask.startTime,
      }
    : {
        running: false,
      };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status));
}

/**
 * 处理 /api/health 请求
 */
function handleHealth(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    timestamp: Date.now(),
  }));
}

/**
 * 处理 /api/cancel 请求
 */
function handleCancel(res: http.ServerResponse): void {
  if (!currentTask) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No task running' }));
    return;
  }

  // TODO: 实现取消逻辑
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'Cancel requested',
    taskId: currentTask.id,
  }));
}

/**
 * 发送 SSE 事件
 */
function sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 读取请求体
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', reject);
  });
}
