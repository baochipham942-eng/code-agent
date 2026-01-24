// ============================================================================
// Twitter/X Fetch Tool - 获取推文内容
// 使用 Nitter 镜像站或 FxTwitter API 获取推文
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('TwitterFetch');

interface TwitterFetchParams {
  url: string;
}

interface TweetData {
  id: string;
  author: string;
  handle: string;
  text: string;
  date?: string;
  likes?: number;
  retweets?: number;
  replies?: number;
  media?: string[];
}

/**
 * 从 URL 提取推文 ID 和用户名
 */
function extractTweetInfo(url: string): { username: string; tweetId: string } | null {
  const patterns = [
    /(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/,
    /(?:twitter\.com|x\.com)\/(\w+)\/statuses\/(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return { username: match[1], tweetId: match[2] };
    }
  }
  return null;
}

/**
 * 使用 FxTwitter API 获取推文
 * FxTwitter 是一个开源的 Twitter 嵌入修复服务
 */
async function fetchViaFxTwitter(username: string, tweetId: string): Promise<TweetData | null> {
  try {
    const response = await fetch(`https://api.fxtwitter.com/${username}/status/${tweetId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CodeAgent/1.0)',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const tweet = data.tweet;

    if (!tweet) {
      return null;
    }

    return {
      id: tweetId,
      author: tweet.author?.name || username,
      handle: `@${tweet.author?.screen_name || username}`,
      text: tweet.text || '',
      date: tweet.created_at,
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
      media: tweet.media?.all?.map((m: any) => m.url) || [],
    };
  } catch (e) {
    logger.warn('FxTwitter API failed', { error: (e as Error).message });
    return null;
  }
}

/**
 * 使用 VxTwitter API 获取推文（备用）
 */
async function fetchViaVxTwitter(username: string, tweetId: string): Promise<TweetData | null> {
  try {
    const response = await fetch(`https://api.vxtwitter.com/${username}/status/${tweetId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CodeAgent/1.0)',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    return {
      id: tweetId,
      author: data.user_name || username,
      handle: `@${data.user_screen_name || username}`,
      text: data.text || '',
      date: data.date,
      likes: data.likes,
      retweets: data.retweets,
      replies: data.replies,
      media: data.media_urls || [],
    };
  } catch (e) {
    logger.warn('VxTwitter API failed', { error: (e as Error).message });
    return null;
  }
}

/**
 * 使用 Nitter 镜像站获取推文（备用）
 */
async function fetchViaNitter(username: string, tweetId: string): Promise<TweetData | null> {
  const nitterInstances = [
    'nitter.net',
    'nitter.it',
    'nitter.privacydev.net',
  ];

  for (const instance of nitterInstances) {
    try {
      const response = await fetch(`https://${instance}/${username}/status/${tweetId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      if (!response.ok) continue;

      const html = await response.text();

      // 简单解析 Nitter HTML
      const textMatch = html.match(/<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      const authorMatch = html.match(/<a class="fullname"[^>]*>([^<]+)<\/a>/);

      if (textMatch) {
        // 移除 HTML 标签
        const text = textMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .trim();

        return {
          id: tweetId,
          author: authorMatch?.[1] || username,
          handle: `@${username}`,
          text,
        };
      }
    } catch (e) {
      logger.warn('Nitter failed', { instance, error: (e as Error).message });
    }
  }

  return null;
}

export const twitterFetchTool: Tool = {
  name: 'twitter_fetch',
  description: `获取 Twitter/X 推文内容。

使用公开 API 获取推文文本、作者、互动数据等。

**使用示例：**
\`\`\`
twitter_fetch { "url": "https://twitter.com/elonmusk/status/1234567890" }
twitter_fetch { "url": "https://x.com/OpenAI/status/1234567890" }
\`\`\`

**注意**：
- 支持 twitter.com 和 x.com 链接
- 部分推文可能因隐私设置无法获取
- 图片/视频链接会一并返回`,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'network',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Twitter/X 推文 URL',
      },
    },
    required: ['url'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const { url } = params as unknown as TwitterFetchParams;

    try {
      // 提取推文信息
      const tweetInfo = extractTweetInfo(url);
      if (!tweetInfo) {
        return {
          success: false,
          error: `无效的 Twitter/X URL: ${url}`,
        };
      }

      const { username, tweetId } = tweetInfo;

      context.emit?.('tool_output', {
        tool: 'twitter_fetch',
        message: `🐦 正在获取推文: @${username}/${tweetId}`,
      });

      // 尝试多个 API
      let tweet: TweetData | null = null;

      // 方案1: FxTwitter
      tweet = await fetchViaFxTwitter(username, tweetId);

      // 方案2: VxTwitter
      if (!tweet) {
        tweet = await fetchViaVxTwitter(username, tweetId);
      }

      // 方案3: Nitter
      if (!tweet) {
        tweet = await fetchViaNitter(username, tweetId);
      }

      if (!tweet) {
        return {
          success: false,
          error: '无法获取推文。可能原因：1) 推文已删除 2) 账号私密 3) API 限制',
        };
      }

      // 格式化输出
      let output = `🐦 Twitter 推文\n\n`;
      output += `**作者**: ${tweet.author} (${tweet.handle})\n`;
      if (tweet.date) {
        output += `**时间**: ${tweet.date}\n`;
      }
      output += `**链接**: ${url}\n`;
      output += `${'─'.repeat(50)}\n\n`;
      output += `${tweet.text}\n`;

      if (tweet.likes !== undefined || tweet.retweets !== undefined) {
        output += `\n${'─'.repeat(50)}\n`;
        if (tweet.likes !== undefined) output += `❤️ ${tweet.likes.toLocaleString()} `;
        if (tweet.retweets !== undefined) output += `🔁 ${tweet.retweets.toLocaleString()} `;
        if (tweet.replies !== undefined) output += `💬 ${tweet.replies.toLocaleString()}`;
        output += '\n';
      }

      if (tweet.media && tweet.media.length > 0) {
        output += `\n📎 媒体附件:\n`;
        tweet.media.forEach((m, i) => {
          output += `${i + 1}. ${m}\n`;
        });
      }

      logger.info('Tweet fetched', { username, tweetId });

      return {
        success: true,
        output,
        metadata: {
          tweetId: tweet.id,
          author: tweet.author,
          handle: tweet.handle,
          text: tweet.text,
          date: tweet.date,
          likes: tweet.likes,
          retweets: tweet.retweets,
          replies: tweet.replies,
          media: tweet.media,
          url,
        },
      };
    } catch (error: any) {
      logger.error('Twitter fetch failed', { error: error.message });
      return {
        success: false,
        error: `获取推文失败: ${error.message}`,
      };
    }
  },
};
