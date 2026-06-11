import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import path from 'path';
import fs from 'fs';
import express from 'express';
import {
  activeBundleDir,
  readActiveBundleMeta,
  resolveRendererServeDir,
} from '../../main/services/renderer/rendererBundleCache';
import { createLogger } from '../../main/services/infra/logger';

const logger = createLogger('StaticRouter');

interface StaticDeps {
  serverAuthToken: string;
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
      return resolveRendererServeDir(deps.dataDir, builtinDir, process.env, {
        currentShellVersion: deps.currentShellVersion,
      });
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

    const serveDir = resolveServeDir();
    const indexPath = path.join(serveDir, 'index.html');

    try {
      const stat = fs.statSync(indexPath);
      if (!cachedIndexHtml || cachedIndexDir !== serveDir || stat.mtimeMs !== cachedIndexMtimeMs) {
        cachedIndexHtml = fs.readFileSync(indexPath, 'utf-8');
        cachedIndexDir = serveDir;
        cachedIndexMtimeMs = stat.mtimeMs;
      }
      // Inject auth token into HTML so httpTransport can attach it to API requests.
      const loadedRendererBundle = getLoadedRendererBundleMeta(serveDir);
      const injectedHtml = cachedIndexHtml.replace(
        /<head(\s[^>]*)?>/i,
        (headTag) => (
          `${headTag}<script>` +
          `window.__CODE_AGENT_TOKEN__=${toInlineScriptJson(serverAuthToken)};` +
          `window.__CODE_AGENT_RENDERER_BUNDLE__=${toInlineScriptJson(loadedRendererBundle)};` +
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

function toInlineScriptJson(value: unknown): string {
  return (JSON.stringify(value) ?? 'null').replace(/</g, '\\u003c');
}
