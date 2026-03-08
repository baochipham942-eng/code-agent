// ============================================================================
// YouTube Transcript Tool - 获取 YouTube 视频字幕
// 主要使用 Supadata API，备用公开 API
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('YouTubeTranscript');

// Supadata API 配置
const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY || '';
const SUPADATA_API_URL = 'https://api.supadata.ai/v1/youtube/transcript';

interface YouTubeTranscriptParams {
  url: string;
  language?: string;
  text_only?: boolean;
}

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

/**
 * 从 URL 提取视频 ID
 * 支持多种 YouTube URL 格式
 */
function extractVideoId(url: string): string | null {
  const patterns = [
    // 标准 watch URL
    /(?:youtube\.com\/watch\?(?:[^&]+&)*v=)([^&\n?#]+)/,
    // 短链接
    /(?:youtu\.be\/)([^&\n?#]+)/,
    // 嵌入链接
    /(?:youtube\.com\/embed\/)([^&\n?#]+)/,
    // Shorts
    /(?:youtube\.com\/shorts\/)([^&\n?#]+)/,
    // 直接是 video ID (11 字符)
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * 格式化时间戳
 */
function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * 获取视频信息
 */
async function getVideoInfo(videoId: string): Promise<{ title: string; author: string } | null> {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (response.ok) {
      const data = await response.json();
      return {
        title: data.title || 'Unknown',
        author: data.author_name || 'Unknown',
      };
    }
  } catch {
    // 忽略错误
  }
  return null;
}

/**
 * 使用 Supadata API 获取字幕
 */
async function fetchTranscriptFromSupadata(
  videoId: string,
  language?: string
): Promise<{ segments: TranscriptSegment[]; lang: string; availableLangs?: string[] }> {
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const params = new URLSearchParams({ url: youtubeUrl });
  if (language) {
    params.append('lang', language);
  }

  const response = await fetch(`${SUPADATA_API_URL}?${params.toString()}`, {
    headers: {
      'x-api-key': SUPADATA_API_KEY,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.warn('Supadata API failed', { status: response.status, error: errorText });
    throw new Error(`Supadata API error: ${response.status} - ${errorText}`);
  }

  const data: SupadataTranscriptResponse = await response.json();

  if (!data.content || data.content.length === 0) {
    throw new Error('No transcript content returned');
  }

  const segments: TranscriptSegment[] = data.content.map(item => ({
    text: item.text,
    start: item.offset / 1000, // 转换为秒
    duration: item.duration / 1000,
  }));

  return {
    segments,
    lang: data.lang || language || 'unknown',
    availableLangs: data.availableLangs,
  };
}

/**
 * 备用方案：使用公开 API 获取字幕
 */
async function fetchTranscriptFallback(videoId: string, language: string = 'en'): Promise<TranscriptSegment[]> {
  const apis = [
    `https://yt.lemnoslife.com/videos?part=transcript&id=${videoId}`,
  ];

  for (const apiUrl of apis) {
    try {
      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      if (response.ok) {
        const data = await response.json();

        if (data.items?.[0]?.transcript?.content) {
          const content = data.items[0].transcript.content;
          return content.map((item: any) => ({
            text: item.text || '',
            start: parseFloat(item.start) || 0,
            duration: parseFloat(item.duration) || 0,
          }));
        }
      }
    } catch (e) {
      logger.warn('Fallback API failed', { api: apiUrl, error: (e as Error).message });
    }
  }

  throw new Error('所有 API 都失败了');
}

/**
 * 获取字幕（主入口）
 * 优先使用 Supadata API，失败后回退到公开 API
 */
async function fetchTranscript(
  videoId: string,
  language?: string
): Promise<{ segments: TranscriptSegment[]; lang: string; availableLangs?: string[] }> {
  // 1. 优先尝试 Supadata API
  try {
    const result = await fetchTranscriptFromSupadata(videoId, language);
    logger.info('Fetched transcript from Supadata', { videoId, lang: result.lang });
    return result;
  } catch (supadataError) {
    logger.warn('Supadata API failed, trying fallback', { error: (supadataError as Error).message });
  }

  // 2. 回退到公开 API
  try {
    const segments = await fetchTranscriptFallback(videoId, language || 'en');
    return { segments, lang: language || 'en' };
  } catch (fallbackError) {
    logger.error('All transcript APIs failed', { videoId });
    throw new Error('无法获取字幕。可能原因：1) 视频没有字幕 2) 字幕被禁用 3) API 限制');
  }
}

export const youtubeTranscriptTool: Tool = {
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
  requiresPermission: true,
  permissionLevel: 'network',
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
        default: 'en',
      },
    },
    required: ['url'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      url,
      language = 'en',
    } = params as unknown as YouTubeTranscriptParams;

    try {
      // 提取视频 ID
      const videoId = extractVideoId(url);
      if (!videoId) {
        return {
          success: false,
          error: `无效的 YouTube URL: ${url}`,
        };
      }

      context.emit?.('tool_output', {
        tool: 'youtube_transcript',
        message: `📺 正在获取视频字幕: ${videoId}`,
      });

      // 获取视频信息
      const videoInfo = await getVideoInfo(videoId);

      // 获取字幕
      const transcriptResult = await fetchTranscript(videoId, language);
      const { segments, lang, availableLangs } = transcriptResult;

      if (segments.length === 0) {
        return {
          success: false,
          error: '该视频没有可用的字幕',
        };
      }

      // 格式化输出
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

      // 合并相邻字幕段落
      let currentParagraph = '';
      let paragraphStart = 0;

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];

        if (currentParagraph === '') {
          paragraphStart = segment.start;
        }

        currentParagraph += segment.text + ' ';

        // 每 30 秒或句子结束时换段
        const isEndOfSentence = /[.!?。！？]$/.test(segment.text.trim());
        const timeSinceParagraphStart = segment.start - paragraphStart;

        if (isEndOfSentence || timeSinceParagraphStart > 30 || i === segments.length - 1) {
          output += `[${formatTimestamp(paragraphStart)}] ${currentParagraph.trim()}\n\n`;
          currentParagraph = '';
        }
      }

      // 计算总时长
      const lastSegment = segments[segments.length - 1];
      const totalDuration = lastSegment.start + lastSegment.duration;

      logger.info('Transcript fetched', { videoId, segments: segments.length, lang });

      return {
        success: true,
        output,
        metadata: {
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
      const message = error instanceof Error ? error.message : String(error);
      logger.error('YouTube transcript failed', { error: message });
      return {
        success: false,
        error: `获取字幕失败: ${message}`,
      };
    }
  },
};
