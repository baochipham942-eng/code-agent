import type { LibreOfficeProbeResult } from './types';

async function readFirstByte(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    await reader.read();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function defaultProbe(url: string, timeoutMs: number): Promise<LibreOfficeProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    await readFirstByte(response);
    return { url, ok: response.ok || response.status === 206, ttfbMs: Date.now() - started };
  } catch {
    return { url, ok: false, ttfbMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
