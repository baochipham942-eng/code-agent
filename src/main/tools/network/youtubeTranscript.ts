// ============================================================================
// YouTube Transcript Tool - 获取 YouTube 视频字幕
// 使用公开 API 提取字幕，无需 API Key
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('YouTubeTranscript');

interface YouTubeTranscriptParams {
  url: string;
  language?: string;
}

interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

/**
 * 从 URL 提取视频 ID
 */
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/, // 直接是 video ID
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
 * 获取字幕
 * 使用多个备用方案
 */
async function fetchTranscript(videoId: string, language: string = 'en'): Promise<TranscriptSegment[]> {
  // 方案1: 使用第三方 API
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

        // 解析 lemnoslife API 响应
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
      logger.warn('API failed', { api: apiUrl, error: (e as Error).message });
    }
  }

  // 方案2: 直接从 YouTube 页面提取（备用）
  try {
    const pageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': `${language},en;q=0.9`,
      },
    });

    if (pageResponse.ok) {
      const html = await pageResponse.text();

      // 提取 captions 数据
      const captionMatch = html.match(/"captions":\s*(\{[^}]+\})/);
      if (captionMatch) {
        // 简单解析，实际需要更复杂的处理
        logger.info('Found captions data in page');
      }

      // 查找是否有字幕
      if (html.includes('"captionTracks"')) {
        throw new Error('视频有字幕，但无法通过公开 API 获取。请尝试使用 youtube-transcript-api Python 库');
      }
    }
  } catch (e) {
    if ((e as Error).message.includes('视频有字幕')) {
      throw e;
    }
  }

  throw new Error('无法获取字幕。可能原因：1) 视频没有字幕 2) 字幕被禁用 3) API 限制');
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
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
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
      const transcript = await fetchTranscript(videoId, language);

      if (transcript.length === 0) {
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
      output += `**语言**: ${language}\n`;
      output += `**链接**: https://www.youtube.com/watch?v=${videoId}\n`;
      output += `${'─'.repeat(50)}\n\n`;

      // 合并相邻字幕段落
      let currentParagraph = '';
      let paragraphStart = 0;

      for (let i = 0; i < transcript.length; i++) {
        const segment = transcript[i];

        if (currentParagraph === '') {
          paragraphStart = segment.start;
        }

        currentParagraph += segment.text + ' ';

        // 每 30 秒或句子结束时换段
        const isEndOfSentence = /[.!?。！？]$/.test(segment.text.trim());
        const timeSinceParagraphStart = segment.start - paragraphStart;

        if (isEndOfSentence || timeSinceParagraphStart > 30 || i === transcript.length - 1) {
          output += `[${formatTimestamp(paragraphStart)}] ${currentParagraph.trim()}\n\n`;
          currentParagraph = '';
        }
      }

      // 计算总时长
      const lastSegment = transcript[transcript.length - 1];
      const totalDuration = lastSegment.start + lastSegment.duration;

      logger.info('Transcript fetched', { videoId, segments: transcript.length });

      return {
        success: true,
        output,
        metadata: {
          videoId,
          title: videoInfo?.title,
          author: videoInfo?.author,
          language,
          segmentCount: transcript.length,
          duration: totalDuration,
          url: `https://www.youtube.com/watch?v=${videoId}`,
        },
      };
    } catch (error: any) {
      logger.error('YouTube transcript failed', { error: error.message });
      return {
        success: false,
        error: `获取字幕失败: ${error.message}`,
      };
    }
  },
};
