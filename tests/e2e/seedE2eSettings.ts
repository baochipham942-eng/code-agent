import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// e2e 运行前提：预置「已过引导」设置固件（爸 2026-08-18 拍板）
// ============================================================================
// 全新数据目录 = 全新机器：没有任何 provider key，App 启动 1.5s 后
// （UI.STARTUP_API_KEY_CHECK_DELAY）跑 openModelOnboardingIfNeeded：
//   checkApiKeyConfigured=false → 未登录 ⇒ 弹 AuthModal（登录/注册）
//                              → 已登录 ⇒ 弹 ModelOnboardingModal，点「跳过」
//                                        又 setShowSettings(true) 打开设置弹窗。
// 两条路都是盖住整个界面的弹层，剧本从此拿不到底下的 UI。
//
// 过门判据是 src/host/ipc/settings.ipc.ts:326 handleCheckApiKeyConfigured —
// settings.onboarding.completedAt 有值即过。所以固件只要在 webServer 起动**前**
// 往数据目录写一份 config.json 即可，不需要真 key、不需要登录态。
//
// 🔴 明确不采用（同一拍板）：从生产数据目录继承配置。CI 全新机器无源可继承，
//    那等于把「绿不绿取决于机器状态」制度化。本文件写的是固定字面量。
// 🔴 专测引导流程的剧本走反向开关 CODE_AGENT_E2E_FORCE_MODEL_ONBOARDING_AFTER
//    （同一函数里，completedAt < 该时间戳时强制判未配置），不要把固件摘掉。
//
// 落盘文件名是 config.json（不是 settings.json）：ConfigService 构造时
// `path.join(app.getPath('userData'), 'config.json')`，userData 在 web 模式解析到
// CODE_AGENT_DATA_DIR。settings.json 是另一套（hooks/权限）的路径，写它不过门。

/** 固定时间戳：只需要「有值」，用常量而非 Date.now() 让固件可复现。 */
const ONBOARDING_COMPLETED_AT = 1_700_000_000_000;

/**
 * 假 provider 条目。baseUrl 指向一个必然拒连的本地端口：
 * 万一某个剧本真发出一轮请求，也只会秒 ECONNREFUSED，不会带着假 key 打到真厂商。
 */
const E2E_FIXTURE_SETTINGS = {
  onboarding: { completedAt: ONBOARDING_COMPLETED_AT },
  models: {
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'sk-e2e-fixture-not-a-real-key',
        baseUrl: 'http://127.0.0.1:1/v1',
      },
    },
  },
};

/**
 * 往 e2e 数据目录写一次固件。已有 config.json 就原样不动——
 * playwright 的 config 模块每个 worker 都会重新求值一次，那时 webServer 早已起来并
 * 写回过自己的 config.json，覆盖它会把运行中的进程配置改掉。
 */
export function seedE2eSettings(dataDir: string): void {
  const configPath = path.join(dataDir, 'config.json');
  if (fs.existsSync(configPath)) return;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(E2E_FIXTURE_SETTINGS, null, 2), 'utf-8');
  // 走 stderr：config 会被 knip 等工具加载，stdout 打印会污染它们的 JSON 输出。
  console.error(`  E2E settings fixture seeded: ${configPath}`);
}
