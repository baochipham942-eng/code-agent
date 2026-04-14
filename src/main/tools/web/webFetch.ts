// ============================================================================
// Web Fetch Tool - Fetch content from URLs with AI-powered extraction
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import {
  smartHtmlToText,
  smartTruncate,
  buildExtractionPrompt,
} from './htmlUtils';
import { fetchDocument } from './fetchDocument';
import { createLogger } from '../../services/infra/logger';
import { WEB_FETCH } from '../../../shared/constants';

const logger = createLogger('WebFetch');

const DEFAULT_MAX_CHARS = 8000;

// ============================================================================
// High-Risk Domains (frequently block crawlers with 403/anti-scraping)
// Fetch is still attempted, but failures get a more helpful error message.
// ============================================================================

const HIGH_RISK_DOMAINS = [
  'zhuanlan.zhihu.com',
  'www.zhihu.com',
  'mp.weixin.qq.com',
  'www.jianshu.com',
  'juejin.cn',
];

/**
 * Check if a URL belongs to a high-risk domain that frequently blocks crawlers.
 */
function isHighRiskDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return HIGH_RISK_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}


/** Max learned domains to prevent unbounded growth */
const MAX_LEARNED_DOMAINS = 200;

// ============================================================================
// Trusted Documentation Domains
// These sites return high-quality content — when they respond with text/markdown,
// skip AI extraction and return content directly (saves a model call).
// ============================================================================

const TRUSTED_DOCS = new Set([
  // Claude / Anthropic
  'platform.claude.com', 'code.claude.com', 'modelcontextprotocol.io',
  // Language docs
  'docs.python.org', 'en.cppreference.com', 'docs.oracle.com',
  'learn.microsoft.com', 'developer.mozilla.org',
  'go.dev', 'pkg.go.dev', 'doc.rust-lang.org',
  'www.typescriptlang.org', 'kotlinlang.org', 'ruby-doc.org',
  'docs.swift.org', 'www.php.net',
  // Frontend
  'react.dev', 'vuejs.org', 'angular.io', 'nextjs.org',
  'tailwindcss.com', 'redux.js.org', 'webpack.js.org', 'jestjs.io',
  'reactrouter.com', 'reactnative.dev',
  // Backend
  'nodejs.org', 'bun.sh', 'expressjs.com',
  'docs.djangoproject.com', 'flask.palletsprojects.com', 'fastapi.tiangolo.com',
  'laravel.com', 'docs.spring.io', 'asp.net', 'dotnet.microsoft.com',
  // Data / ML
  'pandas.pydata.org', 'numpy.org', 'pytorch.org', 'www.tensorflow.org',
  'scikit-learn.org', 'keras.io', 'huggingface.co', 'matplotlib.org',
  // Cloud / DevOps
  'docs.aws.amazon.com', 'cloud.google.com', 'kubernetes.io',
  'www.docker.com', 'www.terraform.io', 'vercel.com/docs',
  'docs.netlify.com',
  // Database
  'www.mongodb.com', 'redis.io', 'www.postgresql.org', 'dev.mysql.com',
  'www.sqlite.org', 'graphql.org', 'prisma.io',
  // Other
  'git-scm.com', 'nginx.org', 'httpd.apache.org',
  'cypress.io', 'selenium.dev',
]);

/** Domains auto-learned at runtime as markdown-capable (session-persistent) */
const learnedMarkdownDomains = new Set<string>();

/**
 * Check if a URL belongs to a trusted documentation site
 * (hardcoded list OR auto-learned markdown-capable domain).
 */
function isTrustedDocs(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    if (TRUSTED_DOCS.has(hostname)) return true;
    if (learnedMarkdownDomains.has(hostname)) return true;
    // Support path-prefix entries like "github.com/anthropics"
    for (const entry of TRUSTED_DOCS) {
      if (entry.includes('/')) {
        const slashIdx = entry.indexOf('/');
        const domain = entry.substring(0, slashIdx);
        const pathPrefix = entry.substring(slashIdx);
        if (hostname === domain && pathname.startsWith(pathPrefix)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: `Fetch a single URL and extract information from its content.

IMPORTANT: This tool WILL FAIL for authenticated or private URLs (Google Docs, Confluence, Jira, etc.).
For GitHub URLs, prefer using bash with gh CLI (e.g., gh pr view, gh issue view, gh api).

Workflow: fetches URL → converts HTML to markdown → AI extraction based on your prompt → returns extracted content.

Use for: reading a specific webpage, calling an API endpoint, extracting data from a known URL.
For searching the web (when you don't have a specific URL), use web_search instead.

Notes:
- URL must be fully-formed (e.g., "https://example.com", not "example.com"). HTTP auto-upgrades to HTTPS.
- Results may be summarized if the content is very large.
- Includes a 15-minute cache — repeated requests to the same URL are fast.
- Cross-domain redirects are reported; you may need to re-fetch the redirect URL.
- This tool is read-only and does not modify any files.`,
  requiresPermission: true,
  permissionLevel: 'network',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from',
      },
      prompt: {
        type: 'string',
        description: 'What information to extract from the page',
      },
      max_chars: {
        type: 'number',
        description: 'Maximum characters in the extracted output (default: 8000)',
      },
    },
    required: ['url', 'prompt'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const url = params.url as string;
    const prompt = params.prompt as string;
    const maxChars = (params.max_chars as number) || DEFAULT_MAX_CHARS;

    // Validate URL
    try {
      new URL(url);
    } catch {
      return {
        success: false,
        error: `Invalid URL: ${url}`,
      };
    }

    // Warn about high-risk domains (still attempt fetch)
    const highRisk = isHighRiskDomain(url);
    if (highRisk) {
      logger.warn('High-risk domain detected, fetch may fail due to anti-scraping', { url });
    }

    try {
      // Fetch via shared utility (handles caching, timeout, retry, redirects)
      const result = await fetchDocument(url);

      // Use finalUrl for trust/domain decisions (handles redirects correctly)
      const effectiveUrl = result.finalUrl;
      const contentType = result.contentType;
      let content: string;

      // Cross-domain redirect: warn and disable trusted docs fast path
      if (result.crossDomainRedirect) {
        logger.info(`Cross-domain redirect detected: ${url} → ${effectiveUrl}`);
      }

      if (contentType.includes('application/json')) {
        // ── JSON fast path ──
        try {
          const json = JSON.parse(result.content);
          content = JSON.stringify(json, null, 2);
        } catch {
          content = result.content;
        }
        if (content.length > maxChars) {
          content = smartTruncate(content, maxChars);
        }
      } else if (contentType.includes('text/markdown')) {
        // ── Markdown fast path ──
        content = result.content;

        // Auto-learn: remember this domain serves markdown (capped)
        try {
          const hostname = new URL(effectiveUrl).hostname;
          if (!TRUSTED_DOCS.has(hostname) && !learnedMarkdownDomains.has(hostname)) {
            if (learnedMarkdownDomains.size < MAX_LEARNED_DOMAINS) {
              learnedMarkdownDomains.add(hostname);
            }
          }
        } catch { /* ignore parse errors */ }

        // Trusted docs + within size limit + no cross-domain redirect → skip AI
        if (isTrustedDocs(effectiveUrl) && !result.crossDomainRedirect && content.length < WEB_FETCH.TRUSTED_DOCS_MAX_CHARS) {
          if (content.length > maxChars) {
            content = smartTruncate(content, maxChars);
          }
        } else {
          content = await extractOrTruncate(content, prompt, maxChars, context);
        }
      } else {
        // ── HTML path ──
        content = smartHtmlToText(result.content, effectiveUrl);
        content = await extractOrTruncate(content, prompt, maxChars, context);
      }

      const cacheNote = result.fromCache ? ' (cached)' : '';
      return {
        success: true,
        output: `Fetched content from: ${effectiveUrl}${cacheNote}\n` +
          `Prompt: ${prompt}\n\n` +
          `Content:\n${content}`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(`Failed to fetch ${url}: ${message}`);
      const hint = highRisk
        ? '\n\nNote: This site frequently blocks crawlers. Consider using web_search to get summary information instead of direct fetching.'
        : '';
      return {
        success: false,
        error: `Failed to fetch URL: ${message}${hint}`,
      };
    }
  },
};

/**
 * AI extraction with graceful fallback to smart truncation.
 * Shared by markdown and HTML paths.
 */
async function extractOrTruncate(
  content: string,
  prompt: string,
  maxChars: number,
  context: ToolContext
): Promise<string> {
  if (context.modelCallback && content.length > 0) {
    try {
      const extractionPrompt = buildExtractionPrompt(prompt, content, maxChars);
      const extracted = await context.modelCallback(extractionPrompt);
      if (extracted && extracted.trim().length > 50) {
        return extracted.trim();
      }
    } catch { /* fall through to truncation */ }
  }
  return smartTruncate(content, maxChars);
}
