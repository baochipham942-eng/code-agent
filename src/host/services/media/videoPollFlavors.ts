export type VideoFlavor = 'standard' | 'agnes' | 'openrouter';

/** 按端点 host 选 flavor。未知 host → standard（Sora 收敛约定）。 */
export function pickVideoFlavor(baseUrl: string): VideoFlavor {
  const host = (() => { try { return new URL(baseUrl).host.toLowerCase(); } catch { return ''; } })();
  if (host.includes('agnes-ai.com')) return 'agnes';
  if (host.includes('openrouter.ai')) return 'openrouter';
  return 'standard';
}

/** 各 flavor 的轮询 URL。agnes 走 origin 下 /agnesapi，其余 {base}/videos/{id}。 */
export function buildPollUrl(flavor: VideoFlavor, baseUrl: string, id: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (flavor === 'agnes') {
    const origin = (() => { try { return new URL(baseUrl).origin; } catch { return trimmed.replace(/\/v1$/, ''); } })();
    return `${origin}/agnesapi?video_id=${encodeURIComponent(id)}`;
  }
  return `${trimmed}/videos/${encodeURIComponent(id)}`;
}

function deepGet(obj: any, path: string): unknown {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : (acc as any)[k]), obj);
}

/** 从完成响应抽取视频 URL；未完成或无字段返回 undefined。 */
export function extractVideoUrl(flavor: VideoFlavor, body: any): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (flavor === 'agnes') return typeof body.remixed_from_video_id === 'string' ? body.remixed_from_video_id : undefined;
  if (flavor === 'openrouter') return Array.isArray(body.unsigned_urls) && typeof body.unsigned_urls[0] === 'string' ? body.unsigned_urls[0] : undefined;
  if (typeof body.url === 'string') return body.url;
  const dataUrl = deepGet(body, 'data.0.url');
  return typeof dataUrl === 'string' ? dataUrl : undefined;
}

/** 判终态。done=成功可取 URL；failed=失败应抛错。 */
export function isVideoTerminal(status?: string): { done: boolean; failed: boolean } {
  const s = (status || '').toLowerCase();
  return {
    done: ['completed', 'succeeded', 'success'].includes(s),
    failed: ['failed', 'error', 'cancelled', 'canceled'].includes(s),
  };
}
