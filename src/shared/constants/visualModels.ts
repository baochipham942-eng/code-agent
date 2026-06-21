// 视觉生成模型注册表（D1 单一真源）。只含「出图/出视频」模型，绝不含聊天模型（D7）。
// P1 仅 image 部分；video 部分在 P2 追加。

export type ImageCap = 't2i' | 'maskEdit' | 'expand';
export type ImageEngineId = 'wanx' | 'cogview' | 'flux' | 'gptimage';
export type VisualProviderId = 'dashscope' | 'zhipu' | 'openrouter' | 'gptimage';

export interface VisualImageModel {
  /** 切换器/持久化用的稳定选择键。 */
  id: string;
  /** UI 显示名（i18n 在 label 之外另给，本字段是中性名）。 */
  label: string;
  provider: VisualProviderId;
  /** 路由到 imageGenerationService.generateImage 的 engine。 */
  engine: ImageEngineId;
  caps: ImageCap[];
}

export const IMAGE_MODELS: readonly VisualImageModel[] = [
  { id: 'wanx-t2i', label: '通义万相', provider: 'dashscope', engine: 'wanx', caps: ['t2i', 'maskEdit', 'expand'] },
  { id: 'gpt-image-2', label: 'GPT-image-2', provider: 'gptimage', engine: 'gptimage', caps: ['t2i'] },
  { id: 'cogview-4', label: 'CogView-4', provider: 'zhipu', engine: 'cogview', caps: ['t2i'] },
  { id: 'flux-2', label: 'FLUX.2', provider: 'openrouter', engine: 'flux', caps: ['t2i'] },
];

export function imageModelById(id: string): VisualImageModel | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

export function imageEngineForModel(id: string): ImageEngineId {
  const m = imageModelById(id);
  if (!m) throw new Error(`未知生图模型 id: ${id}`);
  return m.engine;
}

/** 默认走 wanx——设计模式底座（mask/扩图都依赖它）。 */
export function defaultImageModelId(): string {
  return 'wanx-t2i';
}
