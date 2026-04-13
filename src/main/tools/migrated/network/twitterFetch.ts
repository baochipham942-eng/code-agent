// ============================================================================
// twitter_fetch (P0-6.3 Batch 9 — network: native ToolModule rewrite)
//
// 获取 Twitter/X 推文内容。FxTwitter / VxTwitter / Nitter 三重降级。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { TWITTER_API_ENDPOINTS } from '../../../../shared/constants';
import { twitterFetchSchema as schema } from './twitterFetch.schema';

const { FXTWITTER: FXTWITTER_API, VXTWITTER: VXTWITTER_API, NITTER_INSTANCES } = TWITTER_API_ENDPOINTS;

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

async function fetchViaFxTwitter(
  username: string,
  tweetId: string,
  ctx: ToolContext,
): Promise<TweetData | null> {
  try {
    const response = await fetch(`${FXTWITTER_API}/${username}/status/${tweetId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CodeAgent/1.0)' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const tweet = data.tweet;
    if (!tweet) return null;

    return {
      id: tweetId,
      author: tweet.author?.name || username,
      handle: `@${tweet.author?.screen_name || username}`,
      text: tweet.text || '',
      date: tweet.created_at,
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      media: tweet.media?.all?.map((m: any) => m.url) || [],
    };
  } catch (e) {
    ctx.logger.warn('FxTwitter API failed', { error: (e as Error).message });
    return null;
  }
}

async function fetchViaVxTwitter(
  username: string,
  tweetId: string,
  ctx: ToolContext,
): Promise<TweetData | null> {
  try {
    const response = await fetch(`${VXTWITTER_API}/${username}/status/${tweetId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CodeAgent/1.0)' },
    });
    if (!response.ok) return null;
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
    ctx.logger.warn('VxTwitter API failed', { error: (e as Error).message });
    return null;
  }
}

async function fetchViaNitter(
  username: string,
  tweetId: string,
  ctx: ToolContext,
): Promise<TweetData | null> {
  for (const instance of NITTER_INSTANCES) {
    try {
      const response = await fetch(`https://${instance}/${username}/status/${tweetId}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });
      if (!response.ok) continue;
      const html = await response.text();

      const textMatch = html.match(/<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      const authorMatch = html.match(/<a class="fullname"[^>]*>([^<]+)<\/a>/);

      if (textMatch) {
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
      ctx.logger.warn('Nitter failed', { instance, error: (e as Error).message });
    }
  }
  return null;
}

export async function executeTwitterFetch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const url = args.url;
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

  onProgress?.({ stage: 'starting', detail: 'twitter_fetch' });

  const tweetInfo = extractTweetInfo(url);
  if (!tweetInfo) {
    return { ok: false, error: `无效的 Twitter/X URL: ${url}`, code: 'INVALID_ARGS' };
  }

  const { username, tweetId } = tweetInfo;
  onProgress?.({ stage: 'running', detail: `获取推文: @${username}/${tweetId}` });

  try {
    let tweet: TweetData | null = null;

    tweet = await fetchViaFxTwitter(username, tweetId, ctx);
    if (!tweet) {
      tweet = await fetchViaVxTwitter(username, tweetId, ctx);
    }
    if (!tweet) {
      tweet = await fetchViaNitter(username, tweetId, ctx);
    }

    if (!tweet) {
      return {
        ok: false,
        error: '无法获取推文。可能原因：1) 推文已删除 2) 账号私密 3) API 限制',
        code: 'NETWORK_ERROR',
      };
    }

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

    ctx.logger.info('Tweet fetched', { username, tweetId });
    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output,
      meta: {
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
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error('Twitter fetch failed', { error: message });
    return { ok: false, error: `获取推文失败: ${message}`, code: 'NETWORK_ERROR' };
  }
}

class TwitterFetchHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTwitterFetch(args, ctx, canUseTool, onProgress);
  }
}

export const twitterFetchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TwitterFetchHandler();
  },
};
