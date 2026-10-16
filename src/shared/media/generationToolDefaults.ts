// 付费生成工具（image_generate / video_generate / music_generate）的默认模型 id——单一真源。
// host 服务端选默认模型与审批卡参考价（renderer 查价）共用，禁止再散落字面量。
// 这里只收「工具缺省时的内置 id」；运行时覆盖（如 ZHIPU_IMAGE_MODEL env / config 槽位）
// 是 host 服务自己的分层，不进这份共享。
import { videoModelById } from '../constants/visualModels';

export const GENERATION_TOOL_DEFAULT_MODELS = {
  /** image_generate 默认引擎 CogView-4 的内置版本 id（getZhipuImageModelId 的兜底值）。 */
  image: 'cogview-4-250304',
  /** video_generate 默认文生视频模型（MiniMax 海螺，与 visualModels 注册表同 id）。 */
  video: 'MiniMax-Hailuo-02',
  /** music_generate 内置 MiniMax 模型映射的真实 model 名（MUSIC_PRICING_CNY 的 key）。 */
  music: 'music-2.6',
} as const;

/**
 * video_generate 默认路径（MiniMax 海螺）的固定时长/秒——取视觉模型注册表该模型的
 * defaultDurationSec；注册表条目被移除时冻结为 6，保证审批卡参考价不塌。
 */
export const GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC: number =
  videoModelById(GENERATION_TOOL_DEFAULT_MODELS.video)?.defaultDurationSec ?? 6;

/**
 * cogvideox-*（智谱旧路径）的缺省时长/秒——host submitZhipuVideoTask 传
 * params.duration || 5、schema duration default 5，审批卡 cogvideox 缺 duration 时同按 5 估。
 */
export const GENERATION_TOOL_ZHIPU_VIDEO_DEFAULT_DURATION_SEC = 5;
