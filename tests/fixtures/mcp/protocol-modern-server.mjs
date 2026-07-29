import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  ObservedStdioServerTransport,
  recordFixtureEvent,
} from './protocol-fixture-transport.mjs';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

const server = new Server(
  { name: 'modern-protocol-fixture', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    supportedProtocolVersions: [MODERN_PROTOCOL_VERSION],
  },
);

server.oninitialized = () => {
  recordFixtureEvent({ lifecycle: 'initialized' });
};

server.setRequestHandler('tools/list', async (request) => {
  recordFixtureEvent({ handler: 'tools/list', params: request.params });
  return {
    tools: [
      {
        name: 'echo',
        description: 'Echo a fixture value',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    ],
    resultType: 'complete',
    ttlMs: 250,
    cacheScope: 'private',
  };
});

server.setRequestHandler('tools/call', async (request) => {
  recordFixtureEvent({ handler: 'tools/call', params: request.params });
  return {
    content: [{ type: 'text', text: `modern:${String(request.params.arguments?.value)}` }],
    resultType: 'complete',
  };
});

serveStdio(() => server, {
  legacy: 'reject',
  transport: new ObservedStdioServerTransport(),
});
