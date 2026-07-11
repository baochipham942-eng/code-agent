import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function getAuthToken(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(token).toBeTruthy();
  return token!;
}

async function requestJson<T>(
  request: APIRequestContext,
  token: string,
  method: 'get' | 'post' | 'delete',
  url: string,
  data?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await request[method](url, {
    headers: { Authorization: `Bearer ${token}` },
    ...(data === undefined ? {} : { data }),
  });
  return { status: response.status(), body: await response.json() as T };
}

test('RunRegistry lifecycle stays isolated across HTTP controls', async ({ page, request }) => {
  const token = await getAuthToken(page);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionA = `e2e-run-a-${suffix}`;
  const sessionB = `e2e-run-b-${suffix}`;

  try {
    const createdA = await requestJson<{ runId: string; active: boolean }>(
      request,
      token,
      'post',
      '/api/dev/agent-loop-stub',
      { sessionId: sessionA },
    );
    expect(createdA.status).toBe(200);
    expect(createdA.body.active).toBe(true);

    const conflict = await requestJson<{ activeRunId: string }>(
      request,
      token,
      'post',
      '/api/dev/agent-loop-stub',
      { sessionId: sessionA },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.activeRunId).toBe(createdA.body.runId);

    const createdB = await requestJson<{ runId: string; active: boolean }>(
      request,
      token,
      'post',
      '/api/dev/agent-loop-stub',
      { sessionId: sessionB },
    );
    expect(createdB.status).toBe(200);
    expect(createdB.body.active).toBe(true);

    const ambiguousCancel = await requestJson<{ code: string }>(
      request,
      token,
      'post',
      '/api/cancel',
      {},
    );
    expect(ambiguousCancel.status).toBe(409);
    expect(ambiguousCancel.body.code).toBe('RUN_TARGET_REQUIRED');

    const stopStartedAt = Date.now();
    const cancelA = await requestJson<{ runId: string; sessionId: string }>(
      request,
      token,
      'post',
      '/api/cancel',
      { runId: createdA.body.runId, sessionId: sessionA },
    );
    expect(cancelA.status).toBe(200);
    expect(cancelA.body).toMatchObject({ runId: createdA.body.runId, sessionId: sessionA });

    const [stateA, stateB] = await Promise.all([
      requestJson<{ cancelCount: number; cancelReason: string | null; active: boolean; releasedAt: number | null }>(
        request, token, 'get', `/api/dev/agent-loop-stub/${encodeURIComponent(sessionA)}`,
      ),
      requestJson<{ cancelCount: number; active: boolean }>(
        request, token, 'get', `/api/dev/agent-loop-stub/${encodeURIComponent(sessionB)}`,
      ),
    ]);
    expect(stateA.body).toMatchObject({ cancelCount: 1, cancelReason: 'user', active: false });
    expect(stateA.body.releasedAt).toEqual(expect.any(Number));
    expect(stateA.body.releasedAt! - stopStartedAt).toBeLessThanOrEqual(1_000);
    expect(stateB.body).toMatchObject({ cancelCount: 0, active: true });

    const replacementA = await requestJson<{ runId: string; active: boolean }>(
      request,
      token,
      'post',
      '/api/dev/agent-loop-stub',
      { sessionId: sessionA },
    );
    expect(replacementA.status).toBe(200);
    expect(replacementA.body.active).toBe(true);
    expect(replacementA.body.runId).not.toBe(createdA.body.runId);
  } finally {
    await Promise.all([
      requestJson(request, token, 'delete', `/api/dev/agent-loop-stub/${encodeURIComponent(sessionA)}`).catch(() => undefined),
      requestJson(request, token, 'delete', `/api/dev/agent-loop-stub/${encodeURIComponent(sessionB)}`).catch(() => undefined),
    ]);
  }
});
