// ============================================================================
// typesafeProvider.systemOne —— 超时必须盖住响应体消费，不只是响应头
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderApiKey: () => 'test-typesafe-key',
}));

import { systemOne } from '../../../src/host/model/providers/typesafeProvider';

describe('typesafeProvider.systemOne timeout', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('body 永不结束 + timeoutMs:50 ⇒ 抛 TYPESAFE_TIMEOUT', async () => {
    const body = new ReadableStream({ start() {} });
    globalThis.fetch = vi.fn(async () => new Response(body)) as unknown as typeof fetch;

    try {
      await expect(systemOne({}, {}, { timeoutMs: 50 })).rejects.toMatchObject({
        code: 'TYPESAFE_TIMEOUT',
      });
    } finally {
      await body.cancel().catch(() => undefined);
    }
  });
});
