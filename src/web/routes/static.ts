import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import path from 'path';
import fs from 'fs';
import express from 'express';
import {
  activeBundleDir,
  readActiveBundleMeta,
  resolveRendererServeDecision,
} from '../../host/services/renderer/rendererBundleCache';
import { createLogger } from '../../host/services/infra/logger';
import { TELEMETRY_ENV_WINDOW_KEY, telemetryPageEnv } from '../../shared/observability/privacyFlags';

const logger = createLogger('StaticRouter');

interface StaticDeps {
  /** null in service mode: remote HTML must never receive the server bearer secret. */
  serverAuthToken: string | null;
  /** 固定 serve 目录（显式覆盖，测试/特殊场景用）。提供则忽略 dataDir/builtinDir 运行时解析。 */
  staticDir?: string;
  /** 数据目录（~/.code-agent），用于解析云端 active bundle。 */
  dataDir?: string;
  /** 包内基线 renderer 目录（兜底）。 */
  builtinDir?: string;
  /** 当前 shell 版本；active renderer 低于它时回包内基线，避免旧前端压过新壳修复。 */
  currentShellVersion?: string;
}

export function createStaticRouter(deps: StaticDeps): Router {
  const router = Router();
  const { serverAuthToken } = deps;

  // ── serve 目录运行时解析 ─────────────────────────────────────────
  // 用 __dirname 解析包内基线，不靠 process.cwd()——cargo tauri dev 启动 main process 时
  // cwd 是 src-tauri/，导致 join(cwd, 'dist/renderer') 解析到不存在的 src-tauri/dist/renderer。
  // bundled webServer.cjs 在 dist/web/，dist/renderer 在 ../renderer (dev/prod 一致)。
  const builtinDir = deps.builtinDir ?? path.resolve(__dirname, '..', 'renderer');

  // 每次请求解析当前 serve 目录：
  // - staticDir 显式覆盖 → 固定
  // - 否则按 dataDir 解析 active（健康则云端版，否则回包内 builtin）
  // 兜底铁律：active 不健康 → resolveRendererServeDir 自动回 builtin，绝不 serve 损坏前端。
  function resolveServeDir(): string {
    if (deps.staticDir) return deps.staticDir;
    if (deps.dataDir) {
      return resolveRendererServeDecision(deps.dataDir, builtinDir, process.env, {
        currentShellVersion: deps.currentShellVersion,
      }).serveDir;
    }
    return builtinDir;
  }

  function getLoadedRendererBundleMeta(serveDir: string) {
    if (!deps.dataDir || deps.staticDir) return null;
    if (path.resolve(serveDir) !== path.resolve(activeBundleDir(deps.dataDir))) return null;
    return readActiveBundleMeta(deps.dataDir);
  }

  // ── Static file serving ──────────────────────────────────────────
  // express.static 绑定目录在创建时固定，故按 serve 目录缓存 handler，切换时复用对应实例。
  const staticHandlers = new Map<string, RequestHandler>();
  function staticHandlerFor(serveDir: string): RequestHandler {
    let handler = staticHandlers.get(serveDir);
    if (!handler) {
      handler = express.static(serveDir, {
        // Don't serve index.html via static middleware — we inject the auth token below
        index: false,
      });
      staticHandlers.set(serveDir, handler);
    }
    return handler;
  }

  router.use((req, res, next) => {
    staticHandlerFor(resolveServeDir())(req, res, next);
  });

  // SPA fallback — serve index.html with injected auth token
  // This ensures only clients that load the page from this server can call APIs.
  // 缓存按 (serve 目录 + mtime) 失效：切换 serve 目录或 index.html 变更都会重新读取。
  let cachedIndexHtml: string | null = null;
  let cachedIndexDir: string | null = null;
  let cachedIndexMtimeMs = 0;

  router.get('/{*path}', (req: Request, res: Response) => {
    const requestPath = req.path || '';
    if (requestPath.startsWith('/assets/') || path.extname(requestPath)) {
      res.status(404).type('text').send('Static asset not found');
      return;
    }

    // FB-430：token 只给本机直接打开的页面。外部域名经 DNS 重绑定指到 127.0.0.1 时 Host 是对方域名；
    // 外部网页跳转/嵌入过来是 cross-site——两种都不注入 token，也不给页面（防 __neoDraft 这类 URL 参数被外站借用）。
    if (serverAuthToken) {
      const refusal = refuseTokenPage(req);
      if (refusal) {
        logger.warn(`index.html refused (${refusal.status}): host=${req.headers.host ?? ''} site=${req.get('sec-fetch-site') ?? ''}`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
        res.setHeader('X-Frame-Options', 'DENY');
        res.status(refusal.status).type('html').send(refusal.html);
        return;
      }
    }

    const serveDir = resolveServeDir();
    const indexPath = path.join(serveDir, 'index.html');

    try {
      const stat = fs.statSync(indexPath);
      if (!cachedIndexHtml || cachedIndexDir !== serveDir || stat.mtimeMs !== cachedIndexMtimeMs) {
        cachedIndexHtml = fs.readFileSync(indexPath, 'utf-8');
        cachedIndexDir = serveDir;
        cachedIndexMtimeMs = stat.mtimeMs;
      }
      // Desktop/dev inject auth into the local WebView. Service mode passes null so a
      // public GET / can never disclose the bearer secret supplied by the orchestrator.
      const loadedRendererBundle = getLoadedRendererBundleMeta(serveDir);
      const injectedHtml = cachedIndexHtml.replace(
        /<head(\s[^>]*)?>/i,
        (headTag) => (
          `${headTag}<script>` +
          `window.__CODE_AGENT_TOKEN__=${toInlineScriptJson(serverAuthToken)};` +
          `window.__CODE_AGENT_RENDERER_BUNDLE__=${toInlineScriptJson(loadedRendererBundle)};` +
          `window.${TELEMETRY_ENV_WINDOW_KEY}=${toInlineScriptJson(telemetryPageEnv(process.env))};` +
          '</script>'
        )
      );
      // no-store：启动文档注入了 auth token 与 bundle 元数据，被 WebView 缓存复用
      // 会让旧页带旧 token/旧资源引用启动，触发前端各类自愈 reload（启动连刷）。
      // hashed assets 不受影响仍可长缓存。配合 Tauri 侧每次启动唯一的 ?boot= 参数，
      // 历史缓存条目（含 no-store 之前存入的）也永远不会再命中。
      res.setHeader('Cache-Control', 'no-store');
      // 启动连刷排查锚点：同一次启动该日志出现 >1 次 = 页面被重载了
      logger.info(`index.html served: ${req.originalUrl}`);
      res.type('html').send(injectedHtml);
    } catch {
      res.status(404).send('index.html not found');
    }
  });

  return router;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

const GUARD_PAGE_COPY = {
  title: 'Agent Neo',
  heading: '请在新标签页中打开 Agent Neo',
  crossSiteReason: '出于本机安全保护，Agent Neo 不直接响应从其他网页或聊天链接发起的跳转。',
  hostReason: '出于本机安全保护，Agent Neo 仅支持通过本机地址（127.0.0.1 或 localhost）直接访问。',
  guidance: '请复制下面的地址，粘贴到浏览器的新标签页中打开：',
  openButton: '在新标签页中打开 Agent Neo',
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatLoopbackRootUrl(hostname: string, port: string | number | undefined): string {
  const hostBracketed = hostname.includes(':') ? `[${hostname}]` : hostname;
  const portSuffix = port ? `:${port}` : '';
  return `http://${hostBracketed}${portSuffix}/`;
}

function renderGuardPageHtml(reason: string, rootAddress: string): string {
  const safeTitle = escapeHtml(GUARD_PAGE_COPY.title);
  const safeHeading = escapeHtml(GUARD_PAGE_COPY.heading);
  const safeReason = escapeHtml(reason);
  const safeGuidance = escapeHtml(GUARD_PAGE_COPY.guidance);
  const safeAddress = escapeHtml(rootAddress);
  const safeButton = escapeHtml(GUARD_PAGE_COPY.openButton);

  return [
    '<!doctype html><html lang="zh-CN"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safeTitle}</title>`,
    '<style>',
    ':root{color-scheme:light dark;--bg:#f8fafc;--card:#ffffff;--text:#0f172a;--muted:#475569;--border:#e2e8f0;--code-bg:#f1f5f9;--btn-bg:#0f172a;--btn-text:#ffffff;}',
    '@media (prefers-color-scheme:dark){:root{--bg:#0b0f19;--card:#111827;--text:#f8fafc;--muted:#94a3b8;--border:#1e293b;--code-bg:#1e293b;--btn-bg:#f8fafc;--btn-text:#0f172a;}}',
    '*{box-sizing:border-box;}',
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;line-height:1.6;}',
    'main{max-width:520px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px 24px;box-shadow:0 4px 12px rgba(0,0,0,0.06);}',
    'h1{margin:0 0 12px;font-size:20px;font-weight:600;}',
    'p{margin:0 0 12px;font-size:14px;color:var(--muted);}',
    'code{display:block;padding:10px 12px;margin:0 0 18px;background:var(--code-bg);border:1px solid var(--border);border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:14px;color:var(--text);user-select:all;word-break:break-all;}',
    'a.btn{display:inline-block;padding:10px 16px;background:var(--btn-bg);color:var(--btn-text);text-decoration:none;border-radius:8px;font-size:14px;font-weight:500;}',
    '</style>',
    '</head><body><main>',
    `<h1>${safeHeading}</h1>`,
    `<p>${safeReason}</p>`,
    `<p>${safeGuidance}</p>`,
    `<code>${safeAddress}</code>`,
    `<a class="btn" href="${safeAddress}" target="_blank" rel="noopener">${safeButton}</a>`,
    '</main></body></html>',
  ].join('');
}

function refuseTokenPage(req: Pick<Request, 'headers' | 'get' | 'socket'>): { status: number; html: string } | null {
  const rawHost = req.headers.host ?? '';
  const portMatch = rawHost.match(/:(\d+)$/);
  const hostname = rawHost.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    const localPort = req.socket?.localPort;
    const address = formatLoopbackRootUrl('127.0.0.1', localPort);
    return { status: 421, html: renderGuardPageHtml(GUARD_PAGE_COPY.hostReason, address) };
  }
  if (req.get('sec-fetch-site') === 'cross-site') {
    const port = portMatch ? portMatch[1] : req.socket?.localPort;
    const address = formatLoopbackRootUrl(hostname, port);
    return { status: 403, html: renderGuardPageHtml(GUARD_PAGE_COPY.crossSiteReason, address) };
  }
  return null;
}

function toInlineScriptJson(value: unknown): string {
  return (JSON.stringify(value) ?? 'null').replace(/</g, '\\u003c');
}
