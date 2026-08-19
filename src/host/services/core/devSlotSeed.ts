// ============================================================================
// Dev 槽首启动：从生产数据目录一次性导入模型配置（N-DEVSLOT-SEED）
// ============================================================================
// 治的病：换一个 Dev 槽 = 一个全新的空数据目录 = 一台新机器，所有 provider key
// 都要重配一遍（凭据存在 <数据目录>/secure-storage.json，按数据目录隔离）。
// 本机人工验版时每轮重配的成本远大于收益。
//
// 🔴 正当范围只有一个：**本机人工验版时的便利**。
//    爸 2026-08-18 在 N-E2E-CONTRACT 的拍板里**明确不采用**「从生产目录继承配置」
//    去解 e2e / CI 的环境问题——CI 全新机器无源可继承，且那会把
//    「绿不绿取决于机器状态」制度化。
//    ⇒ 任何自动化门都不得依赖本机制。谁想拿这里解 e2e，那是同一个坑，别踩。
//      （e2e 曾有一份写死字面量的「已过引导」固件 seedE2eSettings，2026-08-19 因
//       拿不出承重证据被撤；退役标注在 tests/e2e/playwright.e2e.config.ts。
//       即便将来它被加回来，也仍然是写死的字面量，不是从生产目录继承。）
//
// 边界（U-1238 立的口径，方向相反同样成立）：只导模型 / provider 配置。
// 会话历史、审批策略、exec-policy 必须按数据目录隔离，一律不带。

import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR_NEW } from '../../../shared/constants/configDir';
import { devSlotFromDataDirName } from '../../../shared/devSlot';
import { getHomeDir } from '../../config/configPaths';
import { createLogger } from '../infra/logger';
import { getSecureStorage, readModelCredentialsFromDataDir } from './secureStorage';

const logger = createLogger('DevSlotSeed');

/** 导入留痕：一次性、可读、可删。日志在 host 里人看不见，这个文件在数据目录里一眼可见。 */
const BREADCRUMB = 'SEEDED-FROM-PRODUCTION.txt';

export interface DevSlotSeedResult {
  seeded: boolean;
  /** 没做的原因，供日志与测试断言 */
  reason?: 'not-a-dev-slot' | 'slot-already-initialized' | 'no-production-config';
  providers?: string[];
  credentialKeys?: number;
}

/**
 * 判据是「目标 dev 槽数据目录**没有 config.json**」= 首次启动。
 * 不用「目录不存在」：webServer 在解析完 dataDir 后就会 mkdir 它，判据必须比那更靠里。
 * 非首启动一律零改动，也不做任何持续同步。
 */
export function seedDevSlotFromProduction(
  dataDir: string,
  now: () => number = Date.now,
): DevSlotSeedResult {
  if (devSlotFromDataDirName(path.basename(dataDir)) === null) {
    return { seeded: false, reason: 'not-a-dev-slot' };
  }

  const devConfigPath = path.join(dataDir, 'config.json');
  if (fs.existsSync(devConfigPath)) {
    return { seeded: false, reason: 'slot-already-initialized' };
  }

  const prodDir = path.join(getHomeDir(), CONFIG_DIR_NEW);
  const prodConfigPath = path.join(prodDir, 'config.json');
  if (path.resolve(prodDir) === path.resolve(dataDir) || !fs.existsSync(prodConfigPath)) {
    return { seeded: false, reason: 'no-production-config' };
  }

  let models: unknown;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(prodConfigPath, 'utf-8'));
    models = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).models : undefined;
  } catch (error) {
    logger.warn('Production config.json unreadable, dev slot starts empty', { error: String(error) });
    return { seeded: false, reason: 'no-production-config' };
  }
  if (!models || typeof models !== 'object') {
    return { seeded: false, reason: 'no-production-config' };
  }

  // 只写 models 一个子树：ConfigService 会把它 merge 进 DEFAULT_SETTINGS，
  // 权限 / exec-policy / 会话相关的一切保持这个槽自己的出厂值。
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(devConfigPath, JSON.stringify({ models }, null, 2), 'utf-8');

  // 凭据本体在 secure store 里，config.json 只有 provider 开关/模型名。
  const credentials = readModelCredentialsFromDataDir(prodDir);
  const secure = getSecureStorage();
  for (const [key, value] of Object.entries(credentials)) {
    secure.set(key as Parameters<typeof secure.set>[0], value);
  }

  const providers = Object.keys((models as { providers?: Record<string, unknown> }).providers ?? {});
  const credentialKeys = Object.keys(credentials).length;

  // 显式可见：日志 + 数据目录里的留痕文件。不许静默拷贝凭据。
  const stamp = new Date(now()).toISOString();
  fs.writeFileSync(
    path.join(dataDir, BREADCRUMB),
    [
      `${stamp} 首次启动，从生产数据目录一次性导入了模型配置。`,
      `来源: ${prodConfigPath}`,
      `导入: models 配置（${providers.length} 个 provider）+ ${credentialKeys} 条模型凭据（apikey.* / serviceBaseUrl.*）。`,
      '未导入: 会话历史、审批策略、exec-policy、登录态 —— 这些按数据目录隔离。',
      '只在首次启动做一次，之后不再同步。删掉本文件不影响任何行为。',
      '',
    ].join('\n'),
    'utf-8',
  );
  logger.info('Dev slot seeded from production model config', {
    dataDir,
    prodConfigPath,
    providers,
    credentialKeys,
  });

  return { seeded: true, providers, credentialKeys };
}
