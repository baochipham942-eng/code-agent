// ============================================================================
// youtube_transcript (P0-6.3 Batch 9 — network: native ToolModule rewrite)
//
// 获取 YouTube 视频字幕。Supadata API 主路径 + 公共 API fallback。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { YOUTUBE_TRANSCRIPT_ENDPOINTS } from '../../../../shared/constants';

const {
  SUPADATA: SUPADATA_API_URL,
  OEMBED: YT_OEMBED_URL,
  FALLBACK: FALLBACK_TRANSCRIPT_APIS,
} = YOUTUBE_TRANSCRIPT_ENDPOINTS;

interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

interface SupadataTranscriptResponse {
  content: Array<{
    text: string;
    offset: number;
    duration: number;
    lang?: string;
  }>;
  lang?: string;
  availableLangs?: string[];
}

const schema: ToolSchema = {
  name: 'youtube_transcript',
  description: `获取 YouTube 视频的字幕/文字稿。

支持的 URL 格式：
- https://www.youtube.com/watch?v=VIDEO_ID
- https://youtu.be/VIDEO_ID
- 直接提供 VIDEO_ID

**使用示例：**
\`\`\`
youtube_transcript { "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
youtube_transcript { "url": "dQw4w9WgXcQ", "language": "zh" }
\`\`\`

**注意**：
- 只能获取已有字幕的视频
- 自动生成的字幕也可以获取
- 部分视频可能禁用字幕下载`,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'YouTube 视频 URL 或 Video ID',
      },
      language: {
        type: 'string',
        description: '字幕语言代码（默认: en）',
      },
      text_only: {
        type: 'boolean',
        description: '仅返回纯文本（不含时间戳，默认 false）',
      },
    },
    required: ['url'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:[^&]+&)*v=)([^&\n?#]+)/,
    /(?:youtu\.be\/)([^&\n?#]+)/,
    /(?:youtube\.com\/embed\/)([^&\n?#]+)/,
    /(?:youtube\.com\/shorts\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function getVideoInfo(videoId: string): Promise<{ title: string; author: string } | null> {
  try {
    const response = await fetch(
      `${YT_OEMBED_URL}?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    );
    if (response.ok) {
      const data = await response.json();
      return {
        title: data.title || 'Unknown',
        author: data.author_name || 'Unknown',
      };
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchTranscriptFromSupadata(
  videoId: string,
  language: string | undefined,
  ctx: ToolContext,
): Promise<{ segments: TranscriptSegment[]; lang: string; availableLangs?: string[] }> {
  const apiKey = process.env.SUPADATA_API_KEY || '';
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const params = new URLSearchParams({ url: youtubeUrl });
  if (language) {
    params.append('lang', language);
  }

  const response = await fetch(`${SUPADATA_API_URL}?${params.toString()}`, {
    headers: { 'x-api-key': apiKey },
  });

  if (!response.ok) {
    const errorText = await response.text();
    ctx.logger.warn('Supadata API failed', { status: response.status, error: errorText });
    throw new Error(`Supadata API error: ${response.status} - ${errorText}`);
  }

  const data: SupadataTranscriptResponse = await response.json();

  if (!data.content || data.content.length === 0) {
    throw new Error('No transcript content returned');
  }

  const segments: TranscriptSegment[] = data.content.map((item) => ({
    text: item.text,
    start: item.offset / 1000,
    duration: item.duration / 1000,
  }));

  return {
    segments,
    lang: data.lang || language || 'unknown',
    availableLangs: data.availableLangs,
  };
}

async function fetchTranscriptFallback(
  videoId: string,
  ctx: ToolContext,
): Promise<TranscriptSegment[]> {
  for (const base of FALLBACK_TRANSCRIPT_APIS) {
    try {
      const apiUrl = `${base}?part=transcript&id=${videoId}`;
      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });
      if (response.ok) {
        const data = await response.json();
        if (data.items?.[0]?.transcript?.content) {
          const content = data.items[0].transcript.content;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return content.map((item: any) => ({
            text: item.text || '',
            start: parseFloat(item.start) || 0,
            duration: parseFloat(item.duration) || 0,
          }));
        }
      }
    } catch (e) {
      ctx.logger.warn('Fallback API failed', { error: (e as Error).message });
    }
  }
  throw new Error('所有 API 都失败了');
}

async function fetchTranscript(
  videoId: string,
  language: string | undefined,
  ctx: ToolContext,
): Promise<{ segments: TranscriptSegment[]; lang: string; availableLangs?: string[] }> {
  try {
    const result = await fetchTranscriptFromSupadata(videoId, language, ctx);
    ctx.logger.info('Fetched transcript from Supadata', { videoId, lang: result.lang });
    return result;
  } catch (supadataError) {
    ctx.logger.warn('Supadata failed, trying fallback', {
      error: (supadataError as Error).message,
    });
  }

  try {
    const segments = await fetchTranscriptFallback(videoId, ctx);
    return { segments, lang: language || 'en' };
  } catch {
    ctx.logger.error('All transcript APIs failed', { videoId });
    throw new Error('无法获取字幕。可能原因：1) 视频没有字幕 2) 字幕被禁用 3) API 限制');
  }
}

export async function executeYoutubeTranscript(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const url = args.url;
  const language = (args.language as string | undefined) ?? 'en';
  const textOnly = Boolean(args.text_only);

  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, error: 'url is required and must be a string', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: 'youtube_transcript' });

  const videoId = extractVideoId(url);
  if (!videoId) {
    return { ok: false, error: `无效的 YouTube URL: ${url}`, code: 'INVALID_ARGS' };
  }

  onProgress?.({ stage: 'running', detail: `获取视频字幕: ${videoId}` });

  try {
    const videoInfo = await getVideoInfo(videoId);
    const transcriptResult = await fetchTranscript(videoId, language, ctx);
    const { segments, lang, availableLangs } = transcriptResult;

    if (segments.length === 0) {
      return { ok: false, error: '该视频没有可用的字幕', code: 'NETWORK_ERROR' };
    }

    let output = `📺 YouTube 视频字幕\n\n`;
    if (videoInfo) {
      output += `**标题**: ${videoInfo.title}\n`;
      output += `**作者**: ${videoInfo.author}\n`;
    }
    output += `**视频ID**: ${videoId}\n`;
    output += `**语言**: ${lang}\n`;
    if (availableLangs && availableLangs.length > 0) {
      output += `**可用语言**: ${availableLangs.join(', ')}\n`;
    }
    output += `**链接**: https://www.youtube.com/watch?v=${videoId}\n`;
    output += `${'─'.repeat(50)}\n\n`;

    if (textOnly) {
      // Plain text without timestamps
      output += segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
      output += '\n';
    } else {
      // Merge adjacent segments into paragraphs
      let currentParagraph = '';
      let paragraphStart = 0;

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (currentParagraph === '') {
          paragraphStart = segment.start;
        }
        currentParagraph += segment.text + ' ';
        const isEndOfSentence = /[.!?。！？]$/.test(segment.text.trim());
        const timeSinceParagraphStart = segment.start - paragraphStart;
        if (isEndOfSentence || timeSinceParagraphStart > 30 || i === segments.length - 1) {
          output += `[${formatTimestamp(paragraphStart)}] ${currentParagraph.trim()}\n\n`;
          currentParagraph = '';
        }
      }
    }

    const lastSegment = segments[segments.length - 1];
    const totalDuration = lastSegment.start + lastSegment.duration;

    ctx.logger.info('Transcript fetched', { videoId, segments: segments.length, lang });
    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output,
      meta: {
        videoId,
        title: videoInfo?.title,
        author: videoInfo?.author,
        language: lang,
        availableLanguages: availableLangs,
        segmentCount: segments.length,
        duration: totalDuration,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      },
    };
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error('YouTube transcript failed', { error: message });
    return { ok: false, error: `获取字幕失败: ${message}`, code: 'NETWORK_ERROR' };
  }
}

class YoutubeTranscriptHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeYoutubeTranscript(args, ctx, canUseTool, onProgress);
  }
}

export const youtubeTranscriptModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new YoutubeTranscriptHandler();
  },
};
