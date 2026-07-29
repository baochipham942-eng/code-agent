import { Server } from '@modelcontextprotocol/server';
import {
  ObservedStdioServerTransport,
  recordFixtureEvent,
} from './protocol-fixture-transport.mjs';

const LEGACY_PROTOCOL_VERSION = '2025-11-25';

const server = new Server(
  { name: 'legacy-protocol-fixture', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION],
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
  };
});

server.setRequestHandler('tools/call', async (request) => {
  recordFixtureEvent({ handler: 'tools/call', params: request.params });
  return {
    content: [{ type: 'text', text: `legacy:${String(request.params.arguments?.value)}` }],
  };
});

await server.connect(new ObservedStdioServerTransport());
