import type { AppSettings, BillingMode, ModelCapability, ModelProvider, ModelProviderProtocol, ModelProviderSettings } from './contract';
import {
  MODEL_FEATURES,
  PROVIDER_MODELS,
  PROVIDER_MODELS_MAP,
  getModelDisplayLabel,
  getProviderDisplayName,
  getProviderInfo,
  type ProviderInfo,
  type ProviderModelEntry,
} from './constants';

export type RuntimeModelFeature = 'tool' | 'vision' | 'reasoning';

export interface RuntimeProviderModel extends ProviderModelEntry {
  enabled: boolean;
  capabilities: ModelCapability[];
  supportsTool: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  maxTokens?: number;
  /** 输入上下文上限（context window），与 maxTokens（最大输出）区分 */
  contextWindow?: number;
  source: 'catalog' | 'discovered';
}

export interface RuntimeModelOption {
  provider: ModelProvider;
  model: string;
  label: string;
  providerLabel: string;
  providerIcon?: string;
  providerFavorite?: boolean;
  providerBillingMode?: BillingMode;
  providerGroup?: ModelProvider;
  providerGroupLabel?: string;
  providerSourceLabel?: string;
  providerProtocol?: ModelProviderProtocol;
  providerTransportLabel?: string;
  providerEndpoint?: string;
  features: RuntimeModelFeature[];
}

interface RuntimeProviderOptionSource {
  providerId: ModelProvider;
  providerLabel: string;
  providerIcon?: string;
  providerFavorite?: boolean;
  providerBillingMode?: BillingMode;
  providerGroup: ModelProvider;
  providerGroupLabel: string;
  providerSourceLabel?: string;
  providerProtocol?: ModelProviderProtocol;
  providerTransportLabel?: string;
  providerEndpoint?: string;
  providerConfig?: Partial<ModelProviderSettings>;
  models: RuntimeProviderModel[];
  order: number;
}

export interface RuntimeModelOptionGroup {
  provider: ModelProvider;
  providerLabel: string;
  providerIcon?: string;
  providerFavorite?: boolean;
  providerBillingMode?: BillingMode;
  providerSourceLabel?: string;
  providerProtocol?: ModelProviderProtocol;
  providerTransportLabel?: string;
  providerEndpoint?: string;
  options: RuntimeModelOption[];
}

export interface ProviderIconPreset {
  icon: string;
  label: string;
}

export type ProviderIconValidationReason = 'unsupported-data-url' | 'unsupported-asset-ref' | 'image-too-large';

export type ProviderIconValidationResult =
  | { valid: true; kind: 'empty'; normalized?: undefined }
  | { valid: true; kind: 'text'; normalized: string; truncated: boolean }
  | { valid: true; kind: 'image'; normalized: string; imageBytes: number }
  | { valid: true; kind: 'asset'; normalized: string; filename: string }
  | { valid: false; kind: 'invalid'; reason: ProviderIconValidationReason; imageBytes?: number };

export const PROVIDER_ICON_IMAGE_MAX_BYTES = 96 * 1024;
export const PROVIDER_ICON_TEXT_MAX_GRAPHEMES = 2;
export const PROVIDER_ICON_ASSET_URI_PREFIX = 'provider-icon://local/';
const PROVIDER_ICON_IMAGE_MAX_DATA_URL_LENGTH = Math.ceil(PROVIDER_ICON_IMAGE_MAX_BYTES * 4 / 3) + 128;
const PROVIDER_ICON_IMAGE_MIME_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,([a-z0-9+/=\s]+)$/i;
const PROVIDER_ICON_ASSET_URI_PATTERN = /^provider-icon:\/\/local\/([a-z0-9][a-z0-9._-]{0,127})$/i;

const COMMON_PROVIDER_ICON_PRESETS: ProviderIconPreset[] = [
  { icon: 'AI', label: 'AI' },
  { icon: 'API', label: 'API' },
];

const PROVIDER_ICON_PRESETS: Record<string, ProviderIconPreset[]> = {
  openai: [
    { icon: 'AI', label: 'AI' },
    { icon: 'GPT', label: 'GPT' },
    { icon: 'OA', label: 'OpenAI' },
  ],
  claude: [
    { icon: 'CL', label: 'Claude' },
    { icon: 'AN', label: 'Anthropic' },
  ],
  anthropic: [
    { icon: 'CL', label: 'Claude' },
    { icon: 'AN', label: 'Anthropic' },
  ],
  gemini: [
    { icon: 'GM', label: 'Gemini' },
    { icon: 'GG', label: 'Google' },
  ],
  deepseek: [
    { icon: 'DS', label: 'DeepSeek' },
  ],
  zhipu: [
    { icon: 'GL', label: 'GLM' },
    { icon: 'ZP', label: 'Zhipu' },
  ],
  moonshot: [
    { icon: 'KM', label: 'Kimi' },
    { icon: 'MS', label: 'Moonshot' },
  ],
  qwen: [
    { icon: 'QW', label: 'Qwen' },
    { icon: 'TY', label: 'Tongyi' },
  ],
  xiaomi: [
    { icon: 'MI', label: 'MiMo' },
    { icon: 'XM', label: 'Xiaomi' },
  ],
  longcat: [
    { icon: 'LC', label: 'LongCat' },
  ],
  openrouter: [
    { icon: 'OR', label: 'OpenRouter' },
    { icon: 'RT', label: 'Router' },
  ],
  minimax: [
    { icon: 'MM', label: 'MiniMax' },
  ],
  perplexity: [
    { icon: 'PX', label: 'Perplexity' },
    { icon: 'SR', label: 'Search' },
  ],
  grok: [
    { icon: 'GK', label: 'Grok' },
  ],
  groq: [
    { icon: 'GQ', label: 'Groq' },
  ],
  volcengine: [
    { icon: 'DB', label: 'Doubao' },
    { icon: 'VC', label: 'Volcengine' },
  ],
  local: [
    { icon: 'LO', label: 'Local' },
    { icon: 'OL', label: 'Ollama' },
  ],
  custom: [
    { icon: 'CU', label: 'Custom' },
    { icon: 'API', label: 'API' },
    { icon: 'AI', label: 'AI' },
  ],
};

export const MODEL_CAPABILITY_OPTIONS: Array<{ id: ModelCapability; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'code', label: '代码' },
  { id: 'reasoning', label: '推理' },
  { id: 'vision', label: '视觉' },
  { id: 'fast', label: '快速' },
  { id: 'longContext', label: '长上下文' },
  { id: 'search', label: '搜索' },
];

export function isRuntimeProviderConfigured(
  providerId: ModelProvider,
  providerConfig?: Partial<ModelProviderSettings> | null,
): boolean {
  if (providerId === 'local') return true;
  return Boolean(
    providerConfig?.managedByCloud
    || providerConfig?.apiKeyConfigured
    || providerConfig?.apiKey,
  );
}

const DEFAULT_SWITCHER_PROVIDERS: ModelProvider[] = [
  'moonshot',
  'xiaomi',
  'longcat',
  'deepseek',
  'zhipu',
  'openai',
  'claude',
  'gemini',
  'qwen',
  'minimax',
  'openrouter',
  'perplexity',
  'grok',
  'volcengine',
  'local',
  'custom',
];

export function isDynamicCustomProviderId(providerId: string): boolean {
  return /^custom-[a-z0-9][a-z0-9-]*$/i.test(providerId);
}

export function resolveRuntimeProviderBillingMode(
  providerId: ModelProvider,
  providerConfig?: Partial<ModelProviderSettings> | null,
): BillingMode {
  switch (providerConfig?.billingMode) {
    case 'free':
    case 'plan':
    case 'payg':
    case 'unknown':
      return providerConfig.billingMode;
    default:
      return isDynamicCustomProviderId(providerId) ? 'unknown' : 'payg';
  }
}

export function resolveProviderProtocol(
  providerId: string,
  providerConfig?: Partial<ModelProviderSettings>,
): ModelProviderProtocol {
  if (providerConfig?.protocol) return providerConfig.protocol;
  if (providerId === 'claude' || providerId === 'anthropic') return 'claude';
  return 'openai';
}

export function formatProviderProtocolLabel(protocol: ModelProviderProtocol): string {
  return protocol === 'claude' ? 'Claude-compatible' : 'OpenAI-compatible';
}

function normalizeProviderEndpoint(baseUrl?: string): string | undefined {
  const endpoint = baseUrl?.trim();
  return endpoint ? endpoint : undefined;
}

function shouldExposeProviderTransportIdentity(
  providerId: ModelProvider,
  providerConfig?: Partial<ModelProviderSettings>,
): boolean {
  return providerId === 'custom' || isDynamicCustomProviderId(providerId) || Boolean(normalizeProviderEndpoint(providerConfig?.baseUrl));
}

function estimateBase64ImageBytes(base64: string): number {
  const compact = base64.replace(/\s+/g, '');
  if (!compact) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(compact.length * 3 / 4) - padding);
}

export function parseProviderIconImageDataUrl(value?: string): {
  normalized: string;
  mimeType: string;
  base64: string;
  imageBytes: number;
} | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const match = /^data:(image\/(?:png|jpe?g|webp|gif|svg\+xml));base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
  if (!match) return null;
  const base64 = (match[2] ?? '').replace(/\s+/g, '');
  return {
    normalized: `data:${match[1]};base64,${base64}`,
    mimeType: match[1] ?? 'image/png',
    base64,
    imageBytes: estimateBase64ImageBytes(base64),
  };
}

export function getProviderIconAssetFilename(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const match = PROVIDER_ICON_ASSET_URI_PATTERN.exec(trimmed);
  return match?.[1];
}

export function isProviderIconAssetRef(value?: string): boolean {
  return Boolean(getProviderIconAssetFilename(value));
}

export function validateProviderIcon(value?: string): ProviderIconValidationResult {
  const trimmed = value?.trim();
  if (!trimmed) return { valid: true, kind: 'empty' };

  if (trimmed.startsWith(PROVIDER_ICON_ASSET_URI_PREFIX)) {
    const filename = getProviderIconAssetFilename(trimmed);
    if (!filename) {
      return { valid: false, kind: 'invalid', reason: 'unsupported-asset-ref' };
    }
    return { valid: true, kind: 'asset', normalized: `${PROVIDER_ICON_ASSET_URI_PREFIX}${filename}`, filename };
  }

  if (trimmed.startsWith('data:')) {
    const parsed = parseProviderIconImageDataUrl(trimmed);
    if (!parsed || !PROVIDER_ICON_IMAGE_MIME_PATTERN.test(trimmed)) {
      return { valid: false, kind: 'invalid', reason: 'unsupported-data-url' };
    }

    if (parsed.imageBytes > PROVIDER_ICON_IMAGE_MAX_BYTES || parsed.normalized.length > PROVIDER_ICON_IMAGE_MAX_DATA_URL_LENGTH) {
      return { valid: false, kind: 'invalid', reason: 'image-too-large', imageBytes: parsed.imageBytes };
    }

    return { valid: true, kind: 'image', normalized: parsed.normalized, imageBytes: parsed.imageBytes };
  }

  const iconChars = Array.from(trimmed);
  return {
    valid: true,
    kind: 'text',
    normalized: iconChars.slice(0, PROVIDER_ICON_TEXT_MAX_GRAPHEMES).join(''),
    truncated: iconChars.length > PROVIDER_ICON_TEXT_MAX_GRAPHEMES,
  };
}

export function estimateProviderIconImageBytes(value?: string): number | undefined {
  const result = validateProviderIcon(value);
  return result.valid && result.kind === 'image' ? result.imageBytes : undefined;
}

export function isProviderImageIcon(value?: string): boolean {
  const result = validateProviderIcon(value);
  return result.valid && (result.kind === 'image' || result.kind === 'asset');
}

export function normalizeProviderIcon(value?: string): string | undefined {
  const result = validateProviderIcon(value);
  return result.valid ? result.normalized : undefined;
}

export function getProviderIconPresets(providerId: string): ProviderIconPreset[] {
  const normalizedProvider = isDynamicCustomProviderId(providerId) ? 'custom' : providerId;
  const presets = PROVIDER_ICON_PRESETS[normalizedProvider] ?? COMMON_PROVIDER_ICON_PRESETS;
  const seen = new Set<string>();
  return presets
    .map((preset) => ({
      ...preset,
      icon: normalizeProviderIcon(preset.icon) ?? preset.icon,
    }))
    .filter((preset) => {
      if (!preset.icon || seen.has(preset.icon)) return false;
      seen.add(preset.icon);
      return true;
    });
}

function looksLikeClaudeModelId(modelId?: string): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.startsWith('claude-') || id.startsWith('anthropic/') || id.includes('/claude-');
}

const CUSTOM_PROVIDER_GROUP_PATTERNS: Array<{
  provider: ModelProvider;
  pattern: RegExp;
}> = [
  { provider: 'longcat', pattern: /longcat/ },
  { provider: 'xiaomi', pattern: /\b(mimo|xiaomi)\b/ },
  { provider: 'moonshot', pattern: /\b(kimi|moonshot)\b/ },
  { provider: 'claude', pattern: /\b(anthropic|claude)\b|anthropic\// },
  { provider: 'gemini', pattern: /\b(gemini|google)\b|google\// },
  { provider: 'openai', pattern: /\b(openai|chatgpt)\b|(^|[/\s-])gpt-[\w.-]+|(^|[/\s-])o[1345]([\s./-]|$)/ },
  { provider: 'deepseek', pattern: /deepseek/ },
  { provider: 'zhipu', pattern: /\b(zhipu|glm)\b|glm-/ },
  { provider: 'qwen', pattern: /\b(qwen|dashscope)\b/ },
  { provider: 'minimax', pattern: /minimax/ },
  { provider: 'perplexity', pattern: /\b(perplexity|sonar)\b/ },
  { provider: 'grok', pattern: /\b(grok|xai)\b/ },
  { provider: 'volcengine', pattern: /\b(volcengine|doubao)\b|doubao-/ },
];

function inferProviderGroupFromText(value: string): ModelProvider | undefined {
  const text = value.toLowerCase();
  return CUSTOM_PROVIDER_GROUP_PATTERNS.find((item) => item.pattern.test(text))?.provider;
}

function inferSingleModelProviderGroup(models: RuntimeProviderModel[]): ModelProvider | undefined {
  const groups = new Set<ModelProvider>();

  for (const model of models) {
    const group = inferProviderGroupFromText(model.id);
    if (!group) return undefined;
    groups.add(group);
    if (groups.size > 1) return undefined;
  }

  return groups.values().next().value;
}

function resolveProviderGroup(args: {
  providerId: ModelProvider;
  providerConfig?: Partial<ModelProviderSettings>;
  protocol: ModelProviderProtocol;
  models: RuntimeProviderModel[];
}): ModelProvider {
  const isCustomProvider = args.providerId === 'custom' || isDynamicCustomProviderId(args.providerId);
  if (!isCustomProvider) return args.providerId;

  const providerIdentityText = [
    args.providerId,
    args.providerConfig?.displayName,
  ].filter(Boolean).join(' ').toLowerCase();

  const matchedGroup = inferProviderGroupFromText(providerIdentityText);
  if (matchedGroup) return matchedGroup;

  if (args.protocol === 'claude') {
    return 'claude';
  }

  const singleModelGroup = inferSingleModelProviderGroup(args.models);
  if (singleModelGroup) return singleModelGroup;

  return args.providerId;
}

function modelBelongsToProviderGroup(modelId: string, providerGroup: ModelProvider): boolean {
  const id = modelId.toLowerCase();
  switch (providerGroup) {
    case 'claude':
      return looksLikeClaudeModelId(id);
    case 'openai':
      return /(^|[/\s-])gpt-[\w.-]+|(^|[/\s-])o[1345]([\s./-]|$)|openai/.test(id);
    case 'gemini':
      return /gemini|google\//.test(id);
    case 'xiaomi':
      return /mimo|xiaomi/.test(id);
    case 'moonshot':
      return /kimi|moonshot/.test(id);
    case 'longcat':
      return /longcat/.test(id);
    case 'deepseek':
      return /deepseek/.test(id);
    case 'zhipu':
      return /glm|zhipu/.test(id);
    case 'qwen':
      return /qwen|dashscope/.test(id);
    case 'minimax':
      return /minimax/.test(id);
    case 'perplexity':
      return /sonar|perplexity/.test(id);
    case 'grok':
      return /grok|xai/.test(id);
    case 'volcengine':
      return /doubao|volcengine/.test(id);
    default:
      return true;
  }
}

function buildProviderSourceLabel(
  providerLabel: string,
  canonicalGroupLabel: string,
  providerGroup: ModelProvider,
): string | undefined {
  if (providerLabel === canonicalGroupLabel) return undefined;

  const groupWords: Partial<Record<ModelProvider, RegExp>> = {
    claude: /\b(anthropic|claude)\b/gi,
    openai: /\b(openai|chatgpt|gpt)\b/gi,
    gemini: /\b(google|gemini)\b/gi,
    xiaomi: /\b(xiaomi|mimo|小米)\b/gi,
    moonshot: /\b(moonshot|kimi|月之暗面)\b/gi,
    longcat: /\b(longcat)\b/gi,
    deepseek: /\b(deepseek)\b/gi,
    zhipu: /\b(zhipu|glm|智谱)\b/gi,
    qwen: /\b(qwen|dashscope|通义)\b/gi,
    minimax: /\b(minimax)\b/gi,
    perplexity: /\b(perplexity|sonar)\b/gi,
    grok: /\b(grok|xai)\b/gi,
    volcengine: /\b(volcengine|doubao|豆包|火山)\b/gi,
  };

  const cleaned = providerLabel
    .replace(groupWords[providerGroup] ?? /$^/, '')
    .replace(/[·|/()[\]_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || providerLabel;
}

function uniqueCapabilities(values: Array<ModelCapability | undefined>): ModelCapability[] {
  return Array.from(new Set(values.filter(Boolean) as ModelCapability[]));
}

export const GEN_CAPABILITIES: ModelCapability[] = ['imageGen', 'videoGen', 'musicGen'];
const CHAT_CAPABILITIES: ModelCapability[] = ['general', 'code', 'reasoning', 'gui', 'search', 'vision'];

export function isPureGenerationModel(capabilities: ModelCapability[]): boolean {
  const hasGen = capabilities.some((c) => GEN_CAPABILITIES.includes(c));
  const hasChat = capabilities.some((c) => CHAT_CAPABILITIES.includes(c));
  return hasGen && !hasChat;
}

export function mediaTypeForGenCapability(cap: ModelCapability): 'image' | 'video' | 'music' | null {
  if (cap === 'imageGen') return 'image';
  if (cap === 'videoGen') return 'video';
  if (cap === 'musicGen') return 'music';
  return null;
}

export function inferModelCapabilities(modelId: string): ModelCapability[] {
  const id = modelId.toLowerCase();

  // 生成能力（输出）——先判，且与 vision（输入）互斥消歧。视频/音乐与图像同样边界锚定（对称）。
  const isImageGen = /(^|[/\s-])(image|t2i|text2image|draw|paint|imagen|wanx|gpt-image|cogview|flux)([\w.]*)?([\s./-]|$)/.test(id) && !/\b(4o|vl|omni|vision)\b/.test(id);
  const isVideoGen = /(^|[/\s-])(video|t2v|i2v|sora|veo|seedance|hailuo|happyhorse|kling|pika|runway)([\s./-]|$)|wan2(\.\d+)?-(t2v|i2v)/.test(id);
  const isMusicGen = /(^|[/\s-])(music|song|suno|audiogen|audio-gen|musicgen)([\s./-]|$)/.test(id);
  const isGen = isImageGen || isVideoGen || isMusicGen;

  // chat 域能力（决定是否"纯生成"）。fast/longContext 是修饰档，不算 chat 域。
  const hasCode = /code|coder|codex|dev/.test(id);
  const hasVision = /vision|vl|omni|4o|multimodal|mm/.test(id) && !isImageGen;
  const hasReasoning = /reason|thinking|think|r1|o1|o3|o4|k2\.6|glm-5/.test(id);
  const hasSearch = /sonar|search|perplexity/.test(id);
  const hasChatToken = hasCode || hasVision || hasReasoning || hasSearch;

  const capabilities: ModelCapability[] = [];
  // general：默认聊天能力。纯生成模型（匹配生成 token 且无任何 chat token）不种 general，
  // 否则 isPureGenerationModel 在推断路径永远为 false（U5 聊天过滤失效）。
  if (!isGen || hasChatToken) capabilities.push('general');
  if (isImageGen) capabilities.push('imageGen');
  if (isVideoGen) capabilities.push('videoGen');
  if (isMusicGen) capabilities.push('musicGen');
  if (hasCode) capabilities.push('code');
  if (hasVision) capabilities.push('vision');
  if (hasReasoning) capabilities.push('reasoning');
  if (/flash|fast|mini|nano|lite|turbo/.test(id)) capabilities.push('fast');
  if (/1m|128k|200k|256k|long/.test(id)) capabilities.push('longContext');
  if (hasSearch) capabilities.push('search');

  return uniqueCapabilities(capabilities);
}

export function inferSupportsTool(modelId: string, capabilities: ModelCapability[] = inferModelCapabilities(modelId)): boolean {
  const id = modelId.toLowerCase();
  if (/embed|embedding|rerank|tts|audio|whisper|speech|image|video/.test(id) && !/omni|vision|vl|4o/.test(id)) {
    return false;
  }
  return capabilities.includes('code') || capabilities.includes('general') || capabilities.includes('reasoning') || capabilities.includes('fast');
}

export function featuresFromModelMetadata(args: {
  modelId: string;
  capabilities?: ModelCapability[];
  supportsTool?: boolean;
  supportsVision?: boolean;
}): RuntimeModelFeature[] {
  const staticFeatures = MODEL_FEATURES[args.modelId] ?? [];
  const capabilities = args.capabilities ?? inferModelCapabilities(args.modelId);
  const supportsTool = args.supportsTool ?? inferSupportsTool(args.modelId, capabilities);
  const supportsVision = args.supportsVision ?? capabilities.includes('vision');
  const features: RuntimeModelFeature[] = [];

  if (supportsTool || staticFeatures.includes('tool')) features.push('tool');
  if (supportsVision || staticFeatures.includes('vision') || capabilities.includes('vision')) features.push('vision');
  if (staticFeatures.includes('reasoning') || capabilities.includes('reasoning')) features.push('reasoning');

  return Array.from(new Set(features));
}

export function buildProviderInfoFromSettings(
  providerId: ModelProvider,
  providerConfig?: Partial<ModelProviderSettings>,
  catalogProvider: ProviderInfo | undefined = PROVIDER_MODELS_MAP[providerId],
): ProviderInfo | undefined {
  if (catalogProvider) {
    return {
      ...catalogProvider,
      name: providerConfig?.displayName || catalogProvider.name,
    };
  }

  if (!providerConfig) return undefined;

  const models: ProviderModelEntry[] = Object.entries(providerConfig.models ?? {}).map(([modelId, settings]) => ({
    id: modelId,
    label: settings.label || modelId,
  }));

  if (providerConfig.model && !models.some((model) => model.id === providerConfig.model)) {
    models.unshift({
      id: providerConfig.model,
      label: providerConfig.models?.[providerConfig.model]?.label || providerConfig.model,
    });
  }

  const protocol = resolveProviderProtocol(providerId, providerConfig);

  return {
    id: providerId,
    name: providerConfig.displayName || providerId,
    description: providerConfig.baseUrl
      ? `${protocol === 'claude' ? 'Claude-compatible' : 'OpenAI-compatible'} · ${providerConfig.baseUrl}`
      : `${protocol === 'claude' ? 'Claude-compatible' : 'OpenAI-compatible'} custom provider`,
    models: models.length > 0 ? models : [{ id: 'custom-model', label: 'Custom Model' }],
  };
}

export function getProviderRuntimeModels(
  provider: ProviderInfo | undefined,
  providerConfig?: Partial<ModelProviderSettings>,
): RuntimeProviderModel[] {
  if (!provider) return [];

  const byId = new Map<string, RuntimeProviderModel>();
  for (const model of provider.models) {
    const override = providerConfig?.models?.[model.id];
    const capabilities = override?.capabilities ?? inferModelCapabilities(model.id);
    const supportsVision = override?.supportsVision ?? capabilities.includes('vision') ?? false;
    const supportsTool = override?.supportsTool ?? inferSupportsTool(model.id, capabilities);
    byId.set(model.id, {
      ...model,
      label: override?.label || model.label,
      enabled: override?.enabled ?? (provider.id === 'custom' ? false : true),
      capabilities,
      maxTokens: override?.maxTokens,
      contextWindow: override?.contextWindow,
      supportsTool,
      supportsVision,
      supportsStreaming: override?.supportsStreaming ?? true,
      source: 'catalog',
    });
  }

  for (const [modelId, override] of Object.entries(providerConfig?.models ?? {})) {
    if (byId.has(modelId)) continue;
    const capabilities = override.capabilities ?? inferModelCapabilities(modelId);
    byId.set(modelId, {
      id: modelId,
      label: override.label || modelId,
      enabled: override.enabled ?? false,
      capabilities,
      maxTokens: override.maxTokens,
      contextWindow: override.contextWindow,
      supportsTool: override.supportsTool ?? inferSupportsTool(modelId, capabilities),
      supportsVision: override.supportsVision ?? capabilities.includes('vision'),
      supportsStreaming: override.supportsStreaming ?? true,
      source: 'discovered',
    });
  }

  return Array.from(byId.values());
}

export function getEnabledProviderModels(
  provider: ProviderInfo | undefined,
  providerConfig?: Partial<ModelProviderSettings>,
): RuntimeProviderModel[] {
  return getProviderRuntimeModels(provider, providerConfig).filter((model) => model.enabled);
}

export function getRuntimeModelLabel(
  modelId: string,
  provider?: ModelProvider,
  settings?: AppSettings | null,
): string {
  if (provider && settings?.models?.providers?.[provider]?.models?.[modelId]?.label) {
    return settings.models.providers[provider].models?.[modelId]?.label || modelId;
  }
  return getModelDisplayLabel(modelId);
}

export function buildRuntimeModelOptions(
  settings?: AppSettings | null,
  providerIds: readonly ModelProvider[] = DEFAULT_SWITCHER_PROVIDERS,
  runtimeOptions: {
    includeDisabledProviders?: readonly ModelProvider[];
  } = {},
): RuntimeModelOption[] {
  const options: RuntimeModelOption[] = [];
  const sources: RuntimeProviderOptionSource[] = [];
  const includedDisabledProviders = new Set(runtimeOptions.includeDisabledProviders ?? []);
  const dynamicProviderIds = settings
    ? (Object.keys(settings.models?.providers ?? {}) as ModelProvider[]).filter(isDynamicCustomProviderId)
    : [];
  const sourceProviderIds = settings
    ? Array.from(new Set<ModelProvider>([
      ...providerIds,
      ...dynamicProviderIds,
    ]))
    : [...providerIds];

  sourceProviderIds.forEach((providerId, order) => {
    const providerConfig = settings?.models?.providers?.[providerId];
    const provider = buildProviderInfoFromSettings(providerId, providerConfig);
    if (!provider) return;

    if (settings && providerConfig?.enabled === false && !includedDisabledProviders.has(providerId)) return;

    // 没配置 API Key 的 provider 不进聊天切换面板（local/Ollama 无需 key 除外）。
    // apiKeyConfigured 由 configService.getSettings() 动态注入：SecureStorage / env 任一有 key 即 true，
    // 因此老配置（key 存在但 settings 文件里没该字段）也能被正确识别。
    // 当前会话 / 默认 provider 走 includeDisabledProviders 豁免，避免选中项凭空消失。
    const missingApiKey = !isRuntimeProviderConfigured(providerId, providerConfig);
    if (settings && missingApiKey && !includedDisabledProviders.has(providerId)) return;

    const providerLabel = providerConfig?.displayName || getProviderDisplayName(providerId) || provider.name;
    const protocol = resolveProviderProtocol(providerId, providerConfig);
    const runtimeModels = getProviderRuntimeModels(provider, providerConfig);
    const enabledModels = runtimeModels.filter((model) => model.enabled);
    const providerGroup = resolveProviderGroup({
      providerId,
      providerConfig,
      protocol,
      models: runtimeModels,
    });
    const isCustomProvider = providerId === 'custom' || isDynamicCustomProviderId(providerId);
    const models = isCustomProvider && providerGroup !== providerId
      ? runtimeModels.filter((model) => modelBelongsToProviderGroup(model.id, providerGroup))
      : enabledModels;
    if (models.length === 0) return;
    const canonicalGroupLabel = getProviderDisplayName(providerGroup) || providerGroup;
    const providerGroupLabel = providerGroup !== providerId
      ? canonicalGroupLabel
      : providerLabel;
    const providerSourceLabel = providerGroup !== providerId
      ? buildProviderSourceLabel(providerLabel, canonicalGroupLabel, providerGroup)
      : undefined;
    const providerEndpoint = normalizeProviderEndpoint(providerConfig?.baseUrl);
    const exposeProviderTransportIdentity = shouldExposeProviderTransportIdentity(providerId, providerConfig);
    const providerTransportLabel = exposeProviderTransportIdentity
      ? formatProviderProtocolLabel(protocol)
      : undefined;

    sources.push({
      providerId,
      providerLabel,
      ...(normalizeProviderIcon(providerConfig?.icon) ? { providerIcon: normalizeProviderIcon(providerConfig?.icon) } : {}),
      ...(providerConfig?.favorite ? { providerFavorite: true } : {}),
      providerBillingMode: resolveRuntimeProviderBillingMode(providerId, providerConfig),
      providerGroup,
      providerGroupLabel,
      ...(providerSourceLabel ? { providerSourceLabel } : {}),
      ...(exposeProviderTransportIdentity ? { providerProtocol: protocol } : {}),
      ...(providerTransportLabel ? { providerTransportLabel } : {}),
      ...(providerEndpoint ? { providerEndpoint } : {}),
      providerConfig,
      models,
      order,
    });
  });

  const latestSourceByGroup = new Map<ModelProvider, RuntimeProviderOptionSource>();
  for (const source of sources) {
    const current = latestSourceByGroup.get(source.providerGroup);
    if (!current || compareProviderOptionSource(source, current) > 0) {
      latestSourceByGroup.set(source.providerGroup, source);
    }
  }

  for (const source of sources) {
    if (latestSourceByGroup.get(source.providerGroup) !== source) continue;

    for (const model of source.models) {
      if (isPureGenerationModel(model.capabilities)) continue; // U5：纯生成模型不进对话选择器
      options.push({
        provider: source.providerId,
        model: model.id,
	        label: model.label || getModelDisplayLabel(model.id),
	        providerLabel: source.providerLabel,
	        ...(source.providerIcon ? { providerIcon: source.providerIcon } : {}),
	        ...(source.providerFavorite ? { providerFavorite: true } : {}),
	        providerBillingMode: source.providerBillingMode,
	        providerGroup: source.providerGroup,
	        providerGroupLabel: source.providerGroupLabel,
	        ...(source.providerSourceLabel ? { providerSourceLabel: source.providerSourceLabel } : {}),
	        ...(source.providerProtocol ? { providerProtocol: source.providerProtocol } : {}),
	        ...(source.providerTransportLabel ? { providerTransportLabel: source.providerTransportLabel } : {}),
	        ...(source.providerEndpoint ? { providerEndpoint: source.providerEndpoint } : {}),
	        features: featuresFromModelMetadata({
	          modelId: model.id,
	          capabilities: model.capabilities,
	          supportsTool: model.supportsTool,
	          supportsVision: model.supportsVision,
	        }),
      });
    }
  }

  if (options.length > 0 || settings) return options;

  return PROVIDER_MODELS.flatMap((provider) =>
    provider.models.map((model) => ({
      provider: provider.id,
      model: model.id,
      label: getModelDisplayLabel(model.id),
      providerLabel: getProviderInfo(provider.id)?.displayName || provider.name,
      providerBillingMode: resolveRuntimeProviderBillingMode(provider.id),
      features: featuresFromModelMetadata({ modelId: model.id }),
    }))
  );
}

export function hasConfiguredRuntimeModels(settings?: AppSettings | null): boolean {
  if (!settings) return false;
  return buildRuntimeModelOptions(settings).length > 0;
}

export function hasConfiguredDefaultRuntimeModel(settings?: AppSettings | null): boolean {
  if (!settings?.models) return false;
  const providerId = settings.models.defaultProvider || settings.models.default;
  if (!providerId) return false;
  const providerConfig = settings.models.providers?.[providerId];
  if (!providerConfig || providerConfig.enabled === false) return false;
  return isRuntimeProviderConfigured(providerId, providerConfig);
}

function compareProviderOptionSource(
  left: RuntimeProviderOptionSource,
  right: RuntimeProviderOptionSource,
): number {
  const leftUpdatedAt = left.providerConfig?.updatedAt;
  const rightUpdatedAt = right.providerConfig?.updatedAt;
  const leftHasUpdatedAt = typeof leftUpdatedAt === 'number' && Number.isFinite(leftUpdatedAt);
  const rightHasUpdatedAt = typeof rightUpdatedAt === 'number' && Number.isFinite(rightUpdatedAt);

  if (leftHasUpdatedAt || rightHasUpdatedAt) {
    return (leftHasUpdatedAt ? leftUpdatedAt : 0) - (rightHasUpdatedAt ? rightUpdatedAt : 0);
  }

  return left.order - right.order;
}

export function groupRuntimeModelOptionsByProvider(options: RuntimeModelOption[]): RuntimeModelOptionGroup[] {
  const groups: RuntimeModelOptionGroup[] = [];
  const byProvider = new Map<ModelProvider, RuntimeModelOptionGroup>();

  for (const option of options) {
    const provider = option.providerGroup ?? option.provider;
    let group = byProvider.get(provider);
    if (!group) {
      group = {
        provider,
        providerLabel: option.providerGroupLabel ?? option.providerLabel,
	        ...(option.providerIcon ? { providerIcon: option.providerIcon } : {}),
	        ...(option.providerFavorite ? { providerFavorite: true } : {}),
	        ...(option.providerBillingMode ? { providerBillingMode: option.providerBillingMode } : {}),
	        ...(option.providerSourceLabel ? { providerSourceLabel: option.providerSourceLabel } : {}),
	        ...(option.providerProtocol ? { providerProtocol: option.providerProtocol } : {}),
	        ...(option.providerTransportLabel ? { providerTransportLabel: option.providerTransportLabel } : {}),
	        ...(option.providerEndpoint ? { providerEndpoint: option.providerEndpoint } : {}),
	        options: [],
	      };
      byProvider.set(provider, group);
      groups.push(group);
    }
    group.options.push(option);
  }

  return groups.sort((a, b) => Number(b.providerFavorite === true) - Number(a.providerFavorite === true));
}
