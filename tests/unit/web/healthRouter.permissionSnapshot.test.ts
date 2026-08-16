import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { sendPendingPermissionSnapshots } from '../../../src/web/routes/health';

describe('health SSE pending permission snapshots', () => {
  it('sends the original request id as an agent permission event without adding it to replay', () => {
    const chunks: string[] = [];
    const response = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as Response;
    const request: PermissionRequest = {
      id: 'permission-original',
      sessionId: 'session-1',
      type: 'file_write',
      tool: 'Write',
      details: { path: '/tmp/probe.md' },
      timestamp: 100,
    };

    expect(sendPendingPermissionSnapshots(response, [request])).toBe(1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).not.toContain('id:');
    expect(chunks[0]).toContain('"channel":"agent:event"');
    expect(chunks[0]).toContain('"type":"permission_request"');
    expect(chunks[0]).toContain('"id":"permission-original"');
    expect(chunks[0]).toContain('"snapshot":true');
  });
});
