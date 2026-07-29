import { appendFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const eventLog = process.env.MCP_FIXTURE_EVENT_LOG;

if (!eventLog) {
  throw new Error('MCP_FIXTURE_EVENT_LOG is required');
}

export function recordFixtureEvent(event) {
  appendFileSync(eventLog, `${JSON.stringify({ pid: process.pid, ...event })}\n`, 'utf8');
}

export class ObservedStdioServerTransport {
  constructor() {
    this.inner = new StdioServerTransport();
  }

  get onclose() {
    return this.inner.onclose;
  }

  set onclose(handler) {
    this.inner.onclose = handler;
  }

  get onerror() {
    return this.inner.onerror;
  }

  set onerror(handler) {
    this.inner.onerror = handler;
  }

  get onmessage() {
    return this.inner.onmessage;
  }

  set onmessage(handler) {
    this.inner.onmessage = (message) => {
      recordFixtureEvent({ direction: 'in', message });
      handler?.(message);
    };
  }

  async start() {
    await this.inner.start();
  }

  async send(message) {
    recordFixtureEvent({ direction: 'out', message });
    await this.inner.send(message);
  }

  async close() {
    await this.inner.close();
  }
}
