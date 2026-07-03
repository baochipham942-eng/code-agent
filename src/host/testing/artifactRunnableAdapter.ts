// artifact_runnable 断言家族的纯函数 adapter（批 3 · B3① 产物终态判据）。
// 把产品运行时验证器（preview health / 游戏 runtime smoke）包成 eval-runner
// 可直接调用的形态：无 IPC、无 App 运行时依赖，headless 可跑。
// 路由说明：HTML 检查走 runSelfStartedArtifactPreviewHealth（自启动 Chrome 路径），
// 刻意绕开 runArtifactPreviewHealth 的默认 in-app 路由（那条路依赖 webServer+IPC）。
// 判定口径（校准依据 2026-07-03 坏游戏标本地面真值）：
// - html_renders 只把硬信号 finding（page_error/console_error/blank_body_text）计为
//   not_runnable；布局质量类（missing_main_element/horizontal_overflow/broken_image/
//   responsive_breakpoint_failure）记 informational check——canvas 游戏没有 <main>，
//   照搬 preview health 整体 passed 会误杀所有游戏产物。
// - game_smoke 默认 light 契约（启动+首帧+无未捕获异常+canvas 非全程空白）；
//   full 契约=goal 模式验收级严格度（要求产物实现 __GAME_TEST__ 机制证据），
//   对非 goal 产物几乎必红，仅供回归标本类 case 显式选用。
// - 环境（Playwright/浏览器不可用）→ verdict='skipped'，不冒充 pass/fail。
import { promises as fs } from 'fs';
import os from 'os';
import {
  runSelfStartedArtifactPreviewHealth,
  type ArtifactPreviewHealthFindingCode,
} from '../agent/runtime/browser/artifactPreviewHealth';
import { runLightPlayabilitySmoke } from '../agent/runtime/browser/lightPlayabilitySmoke';
import { runRuntimeSmoke, type RuntimeSmokeSummary } from '../agent/runtime/gameArtifactRuntimeSmoke';
import { requireOptionalNodeModule } from '../runtime/nodeModuleLoader';
import { resolveBrowserProvider } from '../services/infra/browserProvider';
import { GAME_VALIDATION_TIMEOUTS } from '../../shared/constants/game';
import { ARTIFACT_PREVIEW_HEALTH } from '../../shared/constants/previewHealth';

export type ArtifactRunnableVerdict = 'runnable' | 'not_runnable' | 'skipped';

export interface ArtifactRunnableCheckResult {
  verdict: ArtifactRunnableVerdict;
  failures: string[];
  checks: string[];
  /** 环境指纹：headless 断言结果的平台差异登记（规划风险项，先 mac 本机口径） */
  environment: string;
}

export interface GameSmokeOptions {
  timeoutMs?: number;
  /** light（默认）=启动+首帧+无未捕获异常；full=goal 验收级机制证据契约 */
  contract?: 'light' | 'full';
}

export interface HtmlRendersOptions {
  timeoutMs?: number;
}

/** html_renders 判 not_runnable 的硬信号 finding；其余 finding 记 informational */
const HTML_RENDERS_HARD_FINDING_CODES: ReadonlySet<ArtifactPreviewHealthFindingCode> = new Set([
  'page_error',
  'console_error',
  'blank_body_text',
]);

function environmentFingerprint(kind: 'browser' | 'zip-parse'): string {
  const browser = kind === 'browser' ? resolveBrowserProvider().provider : 'none';
  return `${process.platform}-${os.arch()} node=${process.versions.node} browser=${browser} headless=true`;
}

async function missingFileResult(filePath: string, environment: string): Promise<ArtifactRunnableCheckResult | null> {
  try {
    await fs.access(filePath);
    return null;
  } catch {
    return {
      verdict: 'not_runnable',
      failures: [`artifact file not found: ${filePath}`],
      checks: [],
      environment,
    };
  }
}

function fromRuntimeSmokeSummary(summary: RuntimeSmokeSummary, environment: string): ArtifactRunnableCheckResult {
  if (summary.skipped) {
    return { verdict: 'skipped', failures: [], checks: summary.checks, environment };
  }
  return {
    verdict: summary.passed ? 'runnable' : 'not_runnable',
    failures: summary.failures,
    checks: summary.checks,
    environment,
  };
}

/**
 * game_smoke：游戏产物运行时冒烟（真浏览器）。
 * light 契约包 runLightPlayabilitySmoke，full 契约包 runRuntimeSmoke。
 */
export async function checkGameSmoke(
  filePath: string,
  options: GameSmokeOptions = {},
): Promise<ArtifactRunnableCheckResult> {
  const environment = environmentFingerprint('browser');
  const missing = await missingFileResult(filePath, environment);
  if (missing) return missing;

  const contract = options.contract ?? 'light';
  const summary = contract === 'full'
    ? await runRuntimeSmoke(filePath, options.timeoutMs ?? GAME_VALIDATION_TIMEOUTS.RUNTIME_SMOKE_MS)
    : await runLightPlayabilitySmoke(filePath, options.timeoutMs ?? GAME_VALIDATION_TIMEOUTS.LIGHT_PLAYABILITY_SMOKE_MS);
  return fromRuntimeSmokeSummary(summary, environment);
}

/**
 * html_renders：headless 渲染 HTML 产物，硬信号（未捕获异常/console error/空白正文）
 * 判 not_runnable，布局质量 finding 只记 informational check。
 */
export async function checkHtmlRenders(
  filePath: string,
  options: HtmlRendersOptions = {},
): Promise<ArtifactRunnableCheckResult> {
  const environment = environmentFingerprint('browser');
  const missing = await missingFileResult(filePath, environment);
  if (missing) return missing;

  const summary = await runSelfStartedArtifactPreviewHealth(filePath, {
    timeoutMs: options.timeoutMs ?? ARTIFACT_PREVIEW_HEALTH.TIMEOUT_MS,
  });
  if (summary.skipped) {
    return { verdict: 'skipped', failures: [], checks: summary.checks, environment };
  }

  const hardFindings = summary.findings.filter((finding) => HTML_RENDERS_HARD_FINDING_CODES.has(finding.code));
  const informationalFindings = summary.findings.filter(
    (finding) => !HTML_RENDERS_HARD_FINDING_CODES.has(finding.code),
  );
  const checks = [
    ...summary.checks,
    ...informationalFindings.map((finding) => `informational finding [${finding.code}]: ${finding.message}`),
  ];
  return {
    verdict: hardFindings.length === 0 ? 'runnable' : 'not_runnable',
    failures: hardFindings.map((finding) => `page error/hard finding [${finding.code}]: ${finding.message}`),
    checks,
    environment,
  };
}

interface JsZipEntry {
  async(type: 'string'): Promise<string>;
}

interface JsZipInstance {
  files: Record<string, JsZipEntry>;
}

/**
 * pptx_opens：pptx 产物可解析打开（zip 结构 + [Content_Types].xml +
 * presentation.xml + ≥1 张 slide）。无浏览器依赖，永不 skipped。
 */
export async function checkPptxOpens(filePath: string): Promise<ArtifactRunnableCheckResult> {
  const environment = environmentFingerprint('zip-parse');
  const missing = await missingFileResult(filePath, environment);
  if (missing) return missing;

  const failures: string[] = [];
  const checks: string[] = [];
  try {
    const data = await fs.readFile(filePath);
    // jszip 是 CJS；eval-runner 走 tsx/ESM 时裸 require 不存在（dogfood 实锤
    // "require is not defined" 让 corrupt 标本假绿），统一走跨运行时加载器。
    const loaded = requireOptionalNodeModule<{ loadAsync(data: Buffer): Promise<JsZipInstance> }>('jszip');
    if (!loaded.ok || !loaded.module) {
      return {
        verdict: 'skipped',
        failures: [],
        checks: [`pptx check skipped: ${loaded.error ?? 'jszip unavailable in this runtime'}`],
        environment,
      };
    }
    const zip = await loaded.module.loadAsync(data);
    checks.push('pptx zip container parsed');

    if (!zip.files['[Content_Types].xml']) {
      failures.push('pptx is missing [Content_Types].xml — not a valid OOXML package');
    }
    const presentation = zip.files['ppt/presentation.xml'];
    if (!presentation) {
      failures.push('pptx is missing ppt/presentation.xml');
    } else {
      const presentationXml = await presentation.async('string');
      if (!presentationXml.includes('presentation')) {
        failures.push('ppt/presentation.xml does not look like a presentation document');
      } else {
        checks.push('ppt/presentation.xml parsed');
      }
    }
    const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    if (slideNames.length === 0) {
      failures.push('pptx contains no slide (ppt/slides/slide*.xml)');
    } else {
      checks.push(`pptx contains ${slideNames.length} slide(s)`);
    }
  } catch (error) {
    failures.push(`pptx failed to open: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    verdict: failures.length === 0 ? 'runnable' : 'not_runnable',
    failures,
    checks,
    environment,
  };
}
