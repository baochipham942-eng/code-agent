#!/usr/bin/env npx tsx
// ============================================================================
// 连接器 429 Retry-After 遵守验收（N-CONNECTOR-POLISH-AUDIT-FU2）
// ============================================================================
// 本地 mock HTTP MCP 服务器：每次 run 的第一次 tools/call 回 429 + Retry-After: 2，
// 第二次回 200。用真实 MCPClient（http-streamable 传输）驱动 N 轮，逐轮打印耗时与
// 结果，验证「等服务器说的秒数再重试」而不是拆会话立刻重打。
//
// 用法：
//   npx tsx scripts/acceptance/mcpRateLimitRetryAfter.ts [--runs 10] [--probe]
//   --probe：单轮，额外打印 429 错误对象的形状（开发用）

import { createServer, type Server } from 'node:http';
import { MCPClient } from '../../src/host/mcp/mcpClient';

const args = process.argv.slice(2);
const runs = numberArg('--runs') ?? 10;
const probe = args.includes('--probe');

function numberArg(flag: string): number | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = Number(args[idx + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** 第一次 tools/call 回 429，其余回 200；每轮 run 前重置。 */
function startMockMCPServer(): Promise<{ server: Server; port: number; reset: () => void; calls: () => number }> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/mcp')) {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      let message: { id?: number | string; method?: string; params?: Record<string, unknown> };
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const respond = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          ...headers,
        });
        res.end(JSON.stringify(payload));
      };
      switch (message.method) {
        case 'initialize':
          respond(200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: (message.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-ratelimit', version: '1.0.0' },
            },
          });
          return;
        case 'notifications/initialized':
          res.writeHead(202).end();
          return;
        case 'tools/list':
          respond(200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [{ name: 'echo', description: 'echo the input', inputSchema: { type: 'object' } }],
            },
          });
          return;
        case 'tools/call': {
          toolsCalls += 1;
          if (toolsCalls === 1) {
            res.writeHead(429, { 'retry-after': '2', 'content-type': 'text/plain' });
            res.end('rate limited, retry later');
            return;
          }
          respond(200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{ type: 'text', text: `ok-after-retry (call #${toolsCalls})` }],
              isError: false,
            },
          });
          return;
        }
        default:
          respond(200, {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `unknown method ${message.method}` },
          });
      }
    });
  });
  let toolsCalls = 0;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, reset: () => { toolsCalls = 0; }, calls: () => toolsCalls });
    });
  });
}

async function main() {
  const { server, port, reset } = await startMockMCPServer();
  const config = {
    name: 'mock-429',
    type: 'http-streamable' as const,
    serverUrl: `http://127.0.0.1:${port}/mcp`,
    enabled: true,
    lazyLoad: false,
  };

  let successes = 0;
  const elapsedList: number[] = [];
  for (let run = 1; run <= runs; run += 1) {
    // 每轮重置计数 + 新 MCPClient，保证第一发 tools/call 必是 429
    reset();
    const mcpClient = new MCPClient();
    try {
      await mcpClient.connect(config);
      const startedAt = Date.now();
      const result = await mcpClient.callTool(`run-${run}`, 'mock-429', 'echo', { text: `run-${run}` });
      const elapsed = Date.now() - startedAt;
      elapsedList.push(elapsed);
      if (result.success) {
        successes += 1;
        console.log(`run ${String(run).padStart(2)}: success in ${elapsed}ms`);
      } else {
        console.log(`run ${String(run).padStart(2)}: FAILED in ${elapsed}ms :: ${result.error}`);
        if (probe) describeError(result.error);
      }
      await mcpClient.disconnect('mock-429');
    } catch (error) {
      console.log(`run ${String(run).padStart(2)}: THREW :: ${error instanceof Error ? error.message : String(error)}`);
      if (probe) describeError(error);
    }
  }

  server.close();
  console.log('---');
  console.log(`success rate: ${successes}/${runs}`);
  console.log(`elapsed (ms): ${elapsedList.join(', ')}`);
  process.exit(successes === runs ? 0 : 1);
}

function describeError(error: unknown) {
  if (!(error instanceof Error)) return;
  console.log(`  [probe] error name=${error.name} ctor=${error.constructor.name}`);
  console.log(`  [probe] own keys: ${Object.keys(error).join(', ') || '(none)'}`);
  console.log(`  [probe] message: ${error.message.slice(0, 200)}`);
}

void main().catch((error) => {
  console.error('acceptance script failed:', error);
  process.exit(1);
});
