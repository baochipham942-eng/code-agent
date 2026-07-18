'use strict';

const { enableCompileCache } = require('node:module');
const { homedir } = require('node:os');
const path = require('node:path');

const WEB_SERVER_PAYLOAD = 'webServer.bundle.cjs';

function resolveCompileCacheDir(env = process.env, homeDir = homedir()) {
  // 显式覆写：compile-warmup（C1）用隔离临时数据目录跑副作用，但要把 cache 写到
  // 真实 <data>/cache/v8-compile-cache，供 restart 后真启动命中。故 cache 目录与
  // 数据目录解耦——override 优先。
  const overrideCacheDir = env.CODE_AGENT_COMPILE_CACHE_DIR?.trim();
  if (overrideCacheDir) return path.resolve(overrideCacheDir);
  const configuredDataDir = env.CODE_AGENT_DATA_DIR?.trim();
  const dataDir = configuredDataDir
    ? path.resolve(configuredDataDir)
    : path.join(homeDir, '.code-agent');
  return path.join(dataDir, 'cache', 'v8-compile-cache');
}

function enableWebServerCompileCache(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const enable = options.enable ?? enableCompileCache;
  const cacheDir = resolveCompileCacheDir(env, homeDir);

  try {
    enable(cacheDir);
    return { enabled: true, cacheDir };
  } catch {
    // Compile cache is an optimization. Unsupported runtimes or unwritable
    // cache directories must never stop the backend from starting.
    return { enabled: false, cacheDir };
  }
}

if (require.main === module) {
  enableWebServerCompileCache();
  require(path.join(__dirname, WEB_SERVER_PAYLOAD));
}

module.exports = {
  enableWebServerCompileCache,
  resolveCompileCacheDir,
};
