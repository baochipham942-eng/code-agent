// ============================================================================
// Workspace 设计媒介生成 handlers - 从 workspace.ipc god-file 抽出
//
// 设计画布的图像/视频生成与编辑链路（出图 / 参考图垫图 / 标注重绘 / 导入 /
// 局部重绘 inpaint / 扩图 / 去水印 / 文生·图生视频）。纯 handler 逻辑，行为零改动：
// 每个导出函数等价于原 workspace.ipc 上的同名 handler，只是搬到本模块。
// workspace.ipc 通过 import 把它们接回 registerWorkspaceHandlers 的 switch。
// ============================================================================

import path from 'path';
import { promises as fsp } from 'fs';
import { assertWithinDesignDir } from './workspaceDesignPaths';
import { estimateImageCostCny } from '../../shared/media/imageCost';
import { estimateVideoCostCny } from '../../shared/media/videoCost';
import { estimateMusicCostCny } from '../../shared/media/musicCost';
import { DESIGN_IMAGE_MODELS } from '../../shared/constants';
import { imageEngineForModel, imageModelById, videoModelById } from '../../shared/constants/visualModels';
import { DESIGN_FLUX_MODEL } from '../../shared/constants/pricing';
import type { ExpandDirection } from '../services/media/imageGenerationService';
import {
  getCustomImageModel,
  getCustomModelApiKey,
  type CustomImageModel,
} from '../services/media/customImageModelRegistry';
import {
  getCustomVideoModel,
  getCustomVideoModelApiKey,
} from '../services/media/customVideoModelRegistry';
import {
  resolveHealthyImageModelId,
  nextHealthyImageModelId,
  isImageBalanceError,
} from '../services/media/imageModelHealth';
import { assertSafeCustomBaseUrl } from '../security/ssrfGuard';
import { getUserConfigDir } from '../config/configPaths';
import { REGION_LOCK } from '../../shared/constants/designWorkspace';
import {
  runRegionLockGate,
  ensureRegionLockEnforceable,
  onRegionLockGateError,
} from '../services/media/imageConsistency';
import { loadSharp } from '../runtime/sharpRuntime';
import { readDesignSettings } from '../services/design/designSettings';
import type { RegionLockReport } from '../../shared/contract/imageConsistency';
import { deriveBridgedVisualModels } from '../../shared/visualModelBridge';
import { resolveBridgedEndpoint } from '../services/media/bridgedEndpoint';
import { designGenerationIdempotency } from '../services/media/generationIdempotency';
import type { AppSettings } from '../../shared/contract';

// 幂等缓存命中校验：缓存产物文件已被删则视为失效重新生成，不返回死路径。
const artifactExists = (p: string): Promise<boolean> => fsp.access(p).then(() => true, () => false);

// 解析设计草稿目录（Kun 借鉴：设计 tab 自动落盘，免去手动选工作目录）。
// 设计产物是预览导向的草稿，统一放 app 托管目录 <home>/.code-agent/design，
// 用户无需选目录；需收进项目时再走显式「保存到项目」（后续）。
export async function handleResolveDesignDir(): Promise<{ dir: string }> {
  const dir = path.join(getUserConfigDir(), 'design');
  await fsp.mkdir(dir, { recursive: true });
  return { dir };
}

// 设计画布直连出图（Cowart 式 P1）：按 model 在视觉模型注册表间路由 engine（默认 wanx），
// renderer 不经 agent 直接出图——纯文生图无需 agent 推理，直连更确定。
// 生成 → 下载 OSS URL 转 base64 → 写盘到 outputPath → 返回路径，由 renderer 回灌画布。
export async function handleGenerateDesignImage(
  payload: {
    prompt: string;
    aspectRatio?: string;
    outputPath: string;
    model?: string;
    /** 参考图（base64 dataURL）：存在时走 wanx description_edit 垫图，而非纯文生图。 */
    referenceImageDataUrl?: string;
    /** 付费命令幂等键（WP3-1）：同 commandId 的自动重放返回缓存产物不再计费；缺省保持既有行为。 */
    commandId?: string;
  },
  // 多模态桥接（Spec 1）：注入源聊天 provider 的 settings，供桥接图像模型解析端点。
  // 带默认值（() => null）保证既有调用点零破坏；IPC 注册处传真 settings。
  getSettings: () => AppSettings | null = () => null,
): Promise<{ path: string; actualModel: string; costCny: number }> {
  return designGenerationIdempotency.run(
    payload?.commandId,
    () => generateDesignImageOnce(payload, getSettings),
    (cached) => artifactExists(cached.path),
  );
}

async function generateDesignImageOnce(
  payload: {
    prompt: string;
    aspectRatio?: string;
    outputPath: string;
    model?: string;
    referenceImageDataUrl?: string;
  },
  getSettings: () => AppSettings | null,
): Promise<{ path: string; actualModel: string; costCny: number }> {
  // prompt 须为非空白（trim 后非空）：空白 prompt 是 paid no-op（尤其 wanx/gptimage 用 raw prompt），
  // 直连 IPC/未来调用方可能绕过 renderer 的 trim 守卫，在主进程兜底拦住付费空调用。
  if (!payload?.prompt?.trim() || !payload?.outputPath) {
    throw new Error('generateDesignImage 需要 prompt 与 outputPath');
  }
  assertWithinDesignDir(payload.outputPath, 'outputPath');

  // 桥接模型（多模态桥接 Spec 1）：`provider:model` id（唯一含冒号的来源）→ 复用 openai-compat，
  // 端点取自源聊天 provider 的 baseUrl+key（key 在 host 内解析，不出 host）。内置/custom id 不含
  // 冒号，故此判定不误伤它们；必须在 custom/内置注册表查询之前拦下（二者都查不到桥接 id）。
  if (payload.model?.includes(':')) {
    // host 侧能力闸（终审 M1）：deriveBridgedVisualModels 只派生 gen-capable 模型，天然挡住
    // 聊天桥接 id（chat-model 不在派生表）。含冒号但不在派生表/媒介不符 → 显式抛错，不 fall
    // through 到 custom/内置（冒号 id 不可能是它们），杜绝拿 key 打错端点的付费调用。
    const settings = getSettings();
    const entry = deriveBridgedVisualModels(settings).find((m) => m.id === payload.model && m.mediaType === 'image');
    if (!entry) throw new Error(`未知或不支持的桥接图像模型 ${payload.model}`);
    // 参考图垫图是 wanx description_edit 专属能力；桥接走纯文生图，撞进来显式拒绝（与 custom 一致）。
    if (payload.referenceImageDataUrl) {
      throw new Error('桥接图像模型暂不支持参考图垫图（仅文生图）');
    }
    const { baseUrl, apiKey } = resolveBridgedEndpoint(entry.sourceProvider, settings);
    const { generateImageOpenAICompat, downloadImageAsBase64, isImageUrl } = await import(
      '../services/media/imageGenerationService'
    );
    const { imageData, actualModel } = await generateImageOpenAICompat({
      baseUrl,
      apiKey,
      modelName: entry.modelName,
      prompt: payload.prompt,
      aspectRatio: payload.aspectRatio || '1:1',
    });
    const dataUrl = isImageUrl(imageData) ? await downloadImageAsBase64(imageData) : imageData;
    const buf = Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
    await fsp.writeFile(payload.outputPath, buf);
    return { path: payload.outputPath, actualModel, costCny: estimateImageCostCny(actualModel) };
  }

  // 自定义模型（借鉴项①）：查注册表命中则走 openai-compat 独立分支（绝不进 imageEngineForModel）。
  const custom = payload.model ? await getCustomImageModel(payload.model) : null;

  // 参考图垫图：以用户贴入的参考图为底走 wanx description_edit（万相专属能力，故固定 wanx 引擎）。
  // 路径守卫/空 prompt 已上拦，编排（key 校验 + 出图 + 下载）下沉到 service，handler 只负责落盘。
  if (payload.referenceImageDataUrl) {
    // 审计修订1：参考图垫图绕过 model 路由固定走 wanx——自定义模型只声明 t2i，撞进来显式拦。
    if (custom) {
      throw new Error(`自定义模型 ${custom.label} 不支持参考图垫图（仅文生图）`);
    }
    const { generateImageFromReference } = await import('../services/media/imageGenerationService');
    const { imageData, actualModel } = await generateImageFromReference({
      prompt: payload.prompt,
      referenceImageDataUrl: payload.referenceImageDataUrl,
    });
    const refBuf = Buffer.from(imageData.replace(/^data:[^;]+;base64,/, ''), 'base64');
    await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
    await fsp.writeFile(payload.outputPath, refBuf);
    return { path: payload.outputPath, actualModel, costCny: estimateImageCostCny(actualModel) };
  }

  if (custom) {
    return generateDesignImageViaCustom(custom, payload);
  }

  // registry 守门：显式传了非自定义、又不在视觉模型注册表里的 model id 视为非法，直接抛错
  // （防 typo 被健康解析静默替换成别的模型）；已知但未配 key 的模型走下面健康回退，不在此拦。
  if (payload.model && !imageModelById(payload.model)) {
    throw new Error(`未知图像模型 ${payload.model}`);
  }

  // 健康优先选型（2a #3）：只在已配 key 的内置模型里挑——payload.model 未设/未配 key
  // 退到健康默认；一个都没配则回退静态 default 让"需要 key"原错浮现。
  const primaryModelId = resolveHealthyImageModelId(payload.model);
  const { generateImage, downloadImageAsBase64, isImageUrl } = await import(
    '../services/media/imageGenerationService'
  );

  // flux engine 需要具体模型串作 generateImage 的 fluxModel 入参；其余 engine 忽略此参。
  const runOnce = (modelId: string) => {
    const engine = imageEngineForModel(modelId);
    const fluxModelArg = engine === 'flux' ? DESIGN_FLUX_MODEL : '';
    return generateImage(engine, fluxModelArg, payload.prompt, payload.aspectRatio || '1:1');
  };

  // 单步兜底（2a #3）：chosen 模型遇「余额/欠费」类错误 → 换下一个健康模型重试一次（非循环）。
  // billing 口径（审计 MED-2，诚实标注）：余额类错误在 submit 阶段被端点拒绝时（没出图=没扣费），
  // 「A 失败→B 重试」净扣 1 次；wanx 异步任务若在轮询阶段才返回余额失败，则「不双扣」**依赖
  // DashScope 对失败任务不计费**这一上游语义（本 PR 未独立验证，不宣称已证）。auth/network/timeout
  // 等非余额错误不换模型，原样抛出，自然不重复付费。触发条件用图像专用窄白名单（非通用 quota 分类）。
  let imageData: string;
  let actualModel: string;
  try {
    ({ imageData, actualModel } = await runOnce(primaryModelId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallbackModelId = isImageBalanceError(message) ? nextHealthyImageModelId(primaryModelId) : null;
    if (!fallbackModelId) throw err;
    ({ imageData, actualModel } = await runOnce(fallbackModelId));
  }

  const dataUrl = isImageUrl(imageData) ? await downloadImageAsBase64(imageData) : imageData;
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, buf);
  // 实际花费权威源在 main：按真正落地的模型查价表（T2 BYOK 成本可见）。
  return { path: payload.outputPath, actualModel, costCny: estimateImageCostCny(actualModel) };
}

// 自定义 OpenAI 兼容端点出图（借鉴项①）：key 校验 → 出图前再过一道 SSRF 守卫（防落盘后被篡改）
// → 调 service → url 走 isSafeImageUrl 下载 / b64 直接落盘。成本：用户填的 costCnyPerImage 优先，
// 否则按 modelName 查价表（未知模型回退 default 0.14）。actualModel = 用户填的 modelName。
async function generateDesignImageViaCustom(
  custom: CustomImageModel,
  payload: { prompt: string; aspectRatio?: string; outputPath: string },
): Promise<{ path: string; actualModel: string; costCny: number }> {
  const apiKey = getCustomModelApiKey(custom.id);
  if (!apiKey) {
    throw new Error(`自定义模型 ${custom.label} 未配置 API Key，请在设置中补填。`);
  }
  // 出图前再守一道：注册表存的是已校验 baseUrl，但磁盘文件可能被外部篡改，发请求前必须再判。
  const baseUrl = assertSafeCustomBaseUrl(custom.baseUrl);
  const { generateImageOpenAICompat, downloadImageAsBase64, isImageUrl } = await import(
    '../services/media/imageGenerationService'
  );
  const { imageData, actualModel } = await generateImageOpenAICompat({
    baseUrl,
    apiKey,
    modelName: custom.modelName,
    prompt: payload.prompt,
    aspectRatio: payload.aspectRatio || '1:1',
  });
  const dataUrl = isImageUrl(imageData) ? await downloadImageAsBase64(imageData) : imageData;
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, Buffer.from(base64, 'base64'));
  const costCny = custom.costCnyPerImage ?? estimateImageCostCny(custom.modelName);
  return { path: payload.outputPath, actualModel, costCny };
}

// 设计画布标注重绘（Cowart 式 A3）：renderer 把圈选标注烧进图（annotatedImageDataUrl）+
// 自然语言指令 → 模型按标注重绘 → 写盘到 outputPath → 返回路径与成本。
// 守门顺序：必填校验 → 指令非空 → 路径守卫 → cap 守门（模型须声明 annotEdit），
// 全部在发起付费 service 调用之前，杜绝 paid no-op 与越界写盘。
export async function handleEditImageByAnnotation(
  payload: { model: string; annotatedImageDataUrl: string; instruction: string; outputPath: string },
): Promise<{ path: string; actualModel: string; costCny: number }> {
  if (!payload?.annotatedImageDataUrl || !payload?.outputPath) {
    throw new Error('editImageByAnnotation 需要 annotatedImageDataUrl 与 outputPath');
  }
  if (!payload?.instruction?.trim()) {
    throw new Error('editImageByAnnotation 需要非空 instruction 指令');
  }
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  // cap 守门：模型必须声明 annotEdit，否则不发起付费调用。
  const model = imageModelById(payload.model);
  if (!model?.caps.includes('annotEdit')) {
    throw new Error(`模型 ${payload.model} 不支持标注重绘`);
  }
  const engine = imageEngineForModel(payload.model);
  const { editImageByAnnotation } = await import('../services/media/imageGenerationService');
  const { imageData, actualModel } = await editImageByAnnotation({
    engine, annotatedImageDataUrl: payload.annotatedImageDataUrl, instruction: payload.instruction,
  });
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, Buffer.from(base64, 'base64'));
  return { path: payload.outputPath, actualModel, costCny: estimateImageCostCny(actualModel) };
}

// 设计画布导入用户自有图片（自由画布）：renderer 传 base64 dataURL → 写盘到 run 的 assets，
// 之后它就是普通画布节点，可被选中/圈选局部重绘（与生成图同构）。
export async function handleImportDesignImage(
  payload: { dataUrl: string; outputPath: string },
): Promise<{ path: string }> {
  if (!payload?.dataUrl || !payload?.outputPath) {
    throw new Error('importDesignImage 需要 dataUrl 与 outputPath');
  }
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  const base64 = payload.dataUrl.replace(/^data:[^;]+;base64,/, '');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, Buffer.from(base64, 'base64'));
  return { path: payload.outputPath };
}

// 设计画布圈选局部重绘（Cowart 式 P2）：底图(磁盘路径)读成 base64 + renderer 传来的 mask
// (白=改/黑=留) → 通义万相 wanx2.1-imageedit 真 inpaint → 下载结果。
//
// T4 一致性锁定：模型输出落盘前先过 region-lock 闸——diff-gate 校验未选区域（mask 黑）逐
// 像素是否在 ε 内不变；越界则把原图未选区贴回（保证"其余不变"）并同目录落 diff 证据图。
// 返回 consistency 报告供 renderer 挂到画布节点（随 canvas.json 落 T1 spine）+ UI 徽章。
export async function handleEditDesignImage(
  payload: { prompt: string; baseImagePath: string; maskDataUrl: string; outputPath: string },
): Promise<{ path: string; actualModel: string; costCny: number; consistency?: RegionLockReport }> {
  if (!payload?.prompt || !payload?.baseImagePath || !payload?.maskDataUrl || !payload?.outputPath) {
    throw new Error('editDesignImage 需要 prompt / baseImagePath / maskDataUrl / outputPath');
  }
  assertWithinDesignDir(payload.baseImagePath, 'baseImagePath');
  assertWithinDesignDir(payload.outputPath, 'outputPath');

  // 一致性严格模式预检（付费生成前）：strict 开 + sharp 不可用 → 立刻抛错，
  // 拒绝产出未经一致性保证的图，且不浪费一次付费模型调用（best-effort 默认仍降级）。
  const { regionLockStrict } = await readDesignSettings();
  const sharpLoaded = loadSharp();
  const sharpAvailable = sharpLoaded.ok && !!sharpLoaded.sharp;
  ensureRegionLockEnforceable({ strict: regionLockStrict, sharpAvailable });

  const { editImageWithMask, downloadImageAsBase64, isImageUrl, getDashscopeApiKey } = await import(
    '../services/media/imageGenerationService'
  );
  const apiKey = getDashscopeApiKey();
  if (!apiKey) throw new Error('局部重绘需要百炼（DashScope）API Key。');
  const baseBuf = await fsp.readFile(payload.baseImagePath);
  const baseDataUrl = `data:image/png;base64,${baseBuf.toString('base64')}`;
  const { url } = await editImageWithMask({
    apiKey,
    prompt: payload.prompt,
    baseImageDataUrl: baseDataUrl,
    maskImageDataUrl: payload.maskDataUrl,
  });
  const resultDataUrl = isImageUrl(url) ? await downloadImageAsBase64(url) : url;
  // data URI 前缀用宽松匹配（与 handleImportDesignImage 一致），兼容任意 image MIME 子类型。
  const resultBuf = Buffer.from(resultDataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });

  // mask dataURL → buffer（renderer 已按 白=改/黑=留 栅格化）。
  const maskBuf = Buffer.from(payload.maskDataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64');
  // 局部重绘固定走 wanx imageedit；实际花费按该模型查价表（T2 BYOK 成本可见）。
  const actualModel = DESIGN_IMAGE_MODELS.edit;
  const costCny = estimateImageCostCny(actualModel);

  // 一致性闸。sharp 可用时跑闸；不可用时（已过严格预检）非严格降级写原模型输出，
  // 不返回 consistency（renderer 退回 legacy 无徽章行为）。
  if (sharpAvailable && sharpLoaded.sharp) {
    try {
      const gate = await runRegionLockGate({
        originalBuf: baseBuf,
        editedBuf: resultBuf,
        maskBuf,
        epsilon: REGION_LOCK.EPSILON,
        sharp: sharpLoaded.sharp,
      });
      await fsp.writeFile(payload.outputPath, gate.finalPng);
      const consistency: RegionLockReport = { ...gate.report };
      if (gate.diffPng) {
        const diffPath = `${payload.outputPath}${REGION_LOCK.DIFF_SUFFIX}`;
        await fsp.writeFile(diffPath, gate.diffPng);
        consistency.diffPath = diffPath;
      }
      return { path: payload.outputPath, actualModel, costCny, consistency };
    } catch (err) {
      // 闸内部异常：留可观测日志。严格模式下 onRegionLockGateError 抛错——拒绝写未保证产物
      // （模型原图不落盘）；非严格则保底写模型原始输出，不阻断编辑。
      console.warn('[editDesignImage] region-lock gate failed, falling back to raw output:', err);
      onRegionLockGateError({ strict: regionLockStrict, cause: err });
    }
  }
  await fsp.writeFile(payload.outputPath, resultBuf);
  return { path: payload.outputPath, actualModel, costCny };
}

// 设计画布扩图（T3：wanx function=expand）：底图(磁盘)读成 base64 + 方向/比例 → 四向单边 scale
// → 通义万相外扩补绘 → 下载结果写盘 → 返回路径，由 renderer 回灌为新 variant（挂 T1 spine）。
export async function handleExpandDesignImage(
  payload: { baseImagePath: string; outputPath: string; direction: ExpandDirection; ratio: number; prompt?: string },
): Promise<{ path: string; actualModel: string; costCny: number }> {
  if (!payload?.baseImagePath || !payload?.outputPath) {
    throw new Error('expandDesignImage 需要 baseImagePath / outputPath');
  }
  assertWithinDesignDir(payload.baseImagePath, 'baseImagePath');
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  // 校验 direction 在合法集合内：非法值会让 expandScalesForDirection 落 default(四向 1.0)，
  // 即一次"扩了个寂寞"的付费空调用。在边界先拦掉（codex-audit M2）。
  const VALID_EXPAND_DIRECTIONS: readonly ExpandDirection[] = ['up', 'down', 'left', 'right', 'all'];
  if (!VALID_EXPAND_DIRECTIONS.includes(payload.direction)) {
    throw new Error(`expandDesignImage: 非法 direction「${String(payload.direction)}」，须为 up/down/left/right/all`);
  }
  // ratio 须为有限数且在 [1,2]（NaN/越界否则被 service 静默 clamp 成空操作付费调用）。
  if (!Number.isFinite(payload.ratio) || payload.ratio < 1 || payload.ratio > 2) {
    throw new Error('expandDesignImage: ratio 须为 [1,2] 区间内的有限数值');
  }
  const { expandImage, expandScalesForDirection, downloadImageAsBase64, isImageUrl, getDashscopeApiKey } = await import(
    '../services/media/imageGenerationService'
  );
  const apiKey = getDashscopeApiKey();
  if (!apiKey) throw new Error('扩图需要百炼（DashScope）API Key。');
  const baseBuf = await fsp.readFile(payload.baseImagePath);
  const baseDataUrl = `data:image/png;base64,${baseBuf.toString('base64')}`;
  const scales = expandScalesForDirection(payload.direction, payload.ratio);
  const { url, actualModel } = await expandImage({
    apiKey,
    prompt: payload.prompt?.trim() ? payload.prompt : '自然延伸画面背景，与原图风格一致',
    baseImageDataUrl: baseDataUrl,
    topScale: scales.top,
    bottomScale: scales.bottom,
    leftScale: scales.left,
    rightScale: scales.right,
  });
  const resultDataUrl = isImageUrl(url) ? await downloadImageAsBase64(url) : url;
  const base64 = resultDataUrl.replace(/^data:image\/\w+;base64,/, '');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, Buffer.from(base64, 'base64'));
  // 成本透明补全：扩图是真实付费调用，回传实际模型 + 查价表成本，供 renderer 记一笔（与出图/编辑对称）。
  return { path: payload.outputPath, actualModel, costCny: estimateImageCostCny(actualModel) };
}

// 设计画布去水印（T3：wanx function=remove_watermark）：底图(磁盘)读成 base64 → 消除中英文文字水印
// → 下载结果写盘 → 返回路径，由 renderer 回灌为新 variant（挂 T1 spine）。
export async function handleRemoveWatermarkDesignImage(
  payload: { baseImagePath: string; outputPath: string; prompt?: string },
): Promise<{ path: string; actualModel: string; costCny: number }> {
  if (!payload?.baseImagePath || !payload?.outputPath) {
    throw new Error('removeWatermarkDesignImage 需要 baseImagePath / outputPath');
  }
  assertWithinDesignDir(payload.baseImagePath, 'baseImagePath');
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  const { removeWatermark, downloadImageAsBase64, isImageUrl, getDashscopeApiKey } = await import(
    '../services/media/imageGenerationService'
  );
  const apiKey = getDashscopeApiKey();
  if (!apiKey) throw new Error('去水印需要百炼（DashScope）API Key。');
  const baseBuf = await fsp.readFile(payload.baseImagePath);
  const baseDataUrl = `data:image/png;base64,${baseBuf.toString('base64')}`;
  const { url, actualModel } = await removeWatermark({
    apiKey,
    baseImageDataUrl: baseDataUrl,
    prompt: payload.prompt,
  });
  const resultDataUrl = isImageUrl(url) ? await downloadImageAsBase64(url) : url;
  const base64 = resultDataUrl.replace(/^data:image\/\w+;base64,/, '');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, Buffer.from(base64, 'base64'));
  // 成本透明补全：去水印是真实付费调用，回传实际模型 + 查价表成本，供 renderer 记一笔（与出图/编辑对称）。
  return { path: payload.outputPath, actualModel, costCny: estimateImageCostCny(actualModel) };
}

// 设计画布视频生成（P2）：t2v 直连 / i2v 用画布图节点作底图。通义万相视频异步任务。
// 守门顺序（全在付费 service 调用之前，杜绝 paid no-op 与越界）：
// 必填校验（t2v 需 prompt / i2v 需 baseImagePath）→ 路径守卫 → 模型存在 → cap 命中 mode。
// 成本权威源在 main：按真实回传时长 × 模型单价查表（T2 成本可见）。
export async function handleGenerateDesignVideo(
  payload: {
    mode: 't2v' | 'i2v';
    prompt?: string;
    baseImagePath?: string;
    outputPath: string;
    model: string;
    durationSec?: number;
    /** 付费命令幂等键（WP3-1）：同 commandId 的自动重放返回缓存产物不再计费；缺省保持既有行为。 */
    commandId?: string;
  },
  // 多模态桥接（Spec 1）：注入源聊天 provider 的 settings，供桥接视频模型解析端点。
  // 带默认值（() => null）保证既有调用点零破坏；IPC 注册处传真 settings。
  getSettings: () => AppSettings | null = () => null,
): Promise<{ path: string; actualModel: string; costCny: number; durationSec: number }> {
  // 幂等收口在 provider 分派之前：桥接/custom/veo/内置（wanx/minimax/ark）四路对称覆盖。
  return designGenerationIdempotency.run(
    payload?.commandId,
    () => generateDesignVideoOnce(payload, getSettings),
    (cached) => artifactExists(cached.path),
  );
}

async function generateDesignVideoOnce(
  payload: {
    mode: 't2v' | 'i2v';
    prompt?: string;
    baseImagePath?: string;
    outputPath: string;
    model: string;
    durationSec?: number;
  },
  getSettings: () => AppSettings | null,
): Promise<{ path: string; actualModel: string; costCny: number; durationSec: number }> {
  if (!payload?.outputPath) throw new Error('generateDesignVideo 需要 outputPath');
  if (payload.mode === 't2v' && !payload.prompt?.trim()) throw new Error('文生视频需要非空 prompt');
  if (payload.mode === 'i2v' && !payload.baseImagePath) throw new Error('图生视频需要 baseImagePath');
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  if (payload.baseImagePath) assertWithinDesignDir(payload.baseImagePath, 'baseImagePath');

  // i2v 底图读成 dataURL（桥接/custom 共用）：路径已过 assertWithinDesignDir，缺底图已在上方拦。
  const readBaseImageDataUrl = async (): Promise<string | undefined> => {
    if (payload.mode === 'i2v' && payload.baseImagePath) {
      const baseBuf = await fsp.readFile(payload.baseImagePath);
      return `data:image/png;base64,${baseBuf.toString('base64')}`;
    }
    return undefined;
  };
  const durationSecOut = payload.durationSec ?? 5;

  // 桥接视频模型（多模态桥接 Spec 1）：`provider:model` id（唯一含冒号的来源）→ openai-compat 视频引擎，
  // 端点取自源聊天 provider 的 baseUrl+key（key 在 host 内解析，不出 host）。内置 videoModelById id
  // （wan2.7-t2v 等）与 custom id 均不含冒号，故此判定不误伤；必须在内置/custom 解析之前拦下。
  if (payload.model?.includes(':')) {
    // host 侧能力闸（终审 M1）：deriveBridgedVisualModels 只派生 gen-capable 模型，天然挡住
    // 聊天桥接 id。含冒号但不在派生视频表 → 显式抛错，不 fall through 到 custom/内置，杜绝
    // 拿 key 打错端点的付费调用。
    const settings = getSettings();
    const entry = deriveBridgedVisualModels(settings).find((m) => m.id === payload.model && m.mediaType === 'video');
    if (!entry) throw new Error(`未知或不支持的桥接视频模型 ${payload.model}`);
    // 端点（含 key）由 resolveBridgedEndpoint 校验，缺则抛——不进付费路径。
    const { baseUrl, apiKey } = resolveBridgedEndpoint(entry.sourceProvider, settings);
    const { generateVideoOpenAICompat, downloadVideoAsBuffer } = await import(
      '../services/media/videoGenerationService'
    );
    const imageDataUrl = await readBaseImageDataUrl();
    const { url, actualModel } = await generateVideoOpenAICompat({
      baseUrl, apiKey, modelName: entry.modelName, mode: payload.mode, prompt: payload.prompt, imageDataUrl,
    });
    const buf = await downloadVideoAsBuffer(url);
    await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
    await fsp.writeFile(payload.outputPath, buf);
    return { path: payload.outputPath, actualModel, costCny: estimateVideoCostCny(actualModel, durationSecOut), durationSec: durationSecOut };
  }

  // 自定义视频模型（补完断链）：注册表命中 → 同走 openai-compat。key 缺失/baseUrl 不安全先拦，不付费。
  const customVideo = payload.model ? await getCustomVideoModel(payload.model) : null;
  if (customVideo) {
    const apiKey = getCustomVideoModelApiKey(customVideo.id);
    if (!apiKey) throw new Error(`自定义视频模型 ${customVideo.label} 未配置 API Key，请在设置中补填。`);
    // 出片前再守一道 SSRF：注册表存的是已校验 baseUrl，磁盘文件可能被外部篡改，发请求前必须再判。
    const baseUrl = assertSafeCustomBaseUrl(customVideo.baseUrl);
    const { generateVideoOpenAICompat, downloadVideoAsBuffer } = await import(
      '../services/media/videoGenerationService'
    );
    const imageDataUrl = await readBaseImageDataUrl();
    const { url, actualModel } = await generateVideoOpenAICompat({
      baseUrl, apiKey, modelName: customVideo.modelName, mode: payload.mode, prompt: payload.prompt, imageDataUrl,
    });
    const buf = await downloadVideoAsBuffer(url);
    await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
    await fsp.writeFile(payload.outputPath, buf);
    const costCny = customVideo.costCnyPerVideo ?? estimateVideoCostCny(actualModel, durationSecOut);
    return { path: payload.outputPath, actualModel, costCny, durationSec: durationSecOut };
  }

  const model = videoModelById(payload.model);
  if (!model) throw new Error(`未知视频模型 id: ${payload.model}`);
  if (!model.caps.includes(payload.mode)) throw new Error(`模型 ${payload.model} 不支持 ${payload.mode}`);

  // Veo 原生（Spec 3）：google provider 走专用 generateVeoVideo（代理 + x-goog-api-key 鉴权下载，
  // 直接返回 Buffer）。不复用 generateVideo/downloadVideoAsBuffer（那是 url 返回 + 无鉴权下载，
  // 不适配 Veo 的 Files API 鉴权 URI）。守门（cap/prompt/底图/key）已全在 generateVeoVideo 内付费前完成。
  if (model.provider === 'google') {
    const { generateVeoVideo } = await import('../services/media/videoGenerationService');
    const imageDataUrl = await readBaseImageDataUrl();
    const { buffer, actualModel, durationSec } = await generateVeoVideo({
      model: payload.model, mode: payload.mode, prompt: payload.prompt, imageDataUrl, durationSec: payload.durationSec,
    });
    await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
    await fsp.writeFile(payload.outputPath, buffer);
    return { path: payload.outputPath, actualModel, costCny: estimateVideoCostCny(actualModel, durationSec), durationSec };
  }

  const { generateVideo, downloadVideoAsBuffer } = await import('../services/media/videoGenerationService');

  let imageDataUrl: string | undefined;
  if (payload.mode === 'i2v' && payload.baseImagePath) {
    // key 守卫前置于磁盘读取：按 provider 选对应 key（dashscope/minimax/ark），缺 key 立刻报错，不读文件、不走付费路径。
    const svc = await import('../services/media/imageGenerationService');
    const keyOk =
      model.provider === 'minimax' ? !!svc.getMinimaxApiKey()
      : model.provider === 'ark' ? !!svc.getArkApiKey()
      : !!svc.getDashscopeApiKey();
    if (!keyOk) throw new Error(`图生视频需要对应 provider（${model.provider}）的 API Key。`);
    const baseBuf = await fsp.readFile(payload.baseImagePath);
    imageDataUrl = `data:image/png;base64,${baseBuf.toString('base64')}`;
  }

  const { url, actualModel, durationSec } = await generateVideo({
    model: payload.model,
    mode: payload.mode,
    prompt: payload.prompt,
    imageDataUrl,
    durationSec: payload.durationSec,
  });

  const buf = await downloadVideoAsBuffer(url);
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, buf);
  return { path: payload.outputPath, actualModel, costCny: estimateVideoCostCny(actualModel, durationSec), durationSec };
}

// 设计画布音乐生成（P4）：内置 MiniMax 音乐直连 / `provider:model` 桥接走源聊天 provider 端点。
// 与图像/视频不同——generateMusic 同步返回 audioBuffer（Buffer，非 url），直接写盘，无下载步。
// 守门顺序（全在付费 service 调用之前，杜绝 paid no-op 与越界写盘）：
// outputPath 必填 → prompt/lyrics 至少一项非空 → 路径守卫。成本按真实模型查价表（待价表补全）。
export async function handleGenerateDesignMusic(
  payload: {
    prompt?: string;
    lyrics?: string;
    outputPath: string;
    model: string;
    /** 付费命令幂等键（WP3-1）：同 commandId 的自动重放返回缓存产物不再计费；缺省保持既有行为。 */
    commandId?: string;
  },
  // 多模态桥接（Spec 1）：注入源聊天 provider 的 settings，供桥接音乐模型解析端点。
  // 带默认值（() => null）保证既有调用点零破坏；IPC 注册处传真 settings。
  getSettings: () => AppSettings | null = () => null,
): Promise<{ path: string; actualModel: string; costCny: number }> {
  return designGenerationIdempotency.run(
    payload?.commandId,
    () => generateDesignMusicOnce(payload, getSettings),
    (cached) => artifactExists(cached.path),
  );
}

async function generateDesignMusicOnce(
  payload: { prompt?: string; lyrics?: string; outputPath: string; model: string },
  getSettings: () => AppSettings | null,
): Promise<{ path: string; actualModel: string; costCny: number }> {
  if (!payload?.outputPath) throw new Error('generateDesignMusic 需要 outputPath');
  // prompt 与 lyrics 至少一项非空白：双空是 paid no-op，主进程兜底拦住付费空调用（与 service 守卫同口径）。
  if (!payload.prompt?.trim() && !payload.lyrics?.trim()) {
    throw new Error('音乐生成需要 prompt 或 lyrics');
  }
  assertWithinDesignDir(payload.outputPath, 'outputPath');

  const { generateMusic, resolveMusicModelEndpoint } = await import('../services/media/musicGenerationService');

  // 端点解析消重到共享 resolver（Spec 1 M1 能力闸对称）：内置 minimax-music-2.6 / 桥接 `provider:model`
  // / 未知 id 与缺 key 全在付费 service 调用前抛错，杜绝 paid no-op 与打错端点付费。
  const { baseUrl, apiKey, modelName } = resolveMusicModelEndpoint(payload.model, getSettings());

  const { audioBuffer, actualModel } = await generateMusic({
    baseUrl, apiKey, modelName, prompt: payload.prompt, lyrics: payload.lyrics,
  });
  // 直接落 audioBuffer：MiniMax 音乐同步返回二进制，无 OSS url 下载步（与图像/视频不同）。
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, audioBuffer);
  return { path: payload.outputPath, actualModel, costCny: estimateMusicCostCny(actualModel) };
}
