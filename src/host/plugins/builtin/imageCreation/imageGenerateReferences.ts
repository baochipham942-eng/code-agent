// ============================================================================
// imageGenerateReferences — image_generate 参考图读取与多参考图文案辅助
// （N-IMAGE-MULTI-REF-IMPL，从 imageGenerate.ts 拆出以守 1000 行上限）
//
// 多参考图（2-3 张）路径上，出图比例由百炼多图端点钦定「以最后一张图为准」
// （doc-quoted，全引见 docs/research/2026-10-image-multi-ref-probe.md），复述句
// 必须按真实规则说，不拿调用方的 aspect_ratio 骗人。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { IMAGE_MULTI_REF } from '../../../../shared/constants/visualModels';

/** 参考图/落盘路径扩展名 → mime（读参考图 dataURL 与落盘 artifact 的 mime 兜底共用）。 */
export function referenceMimeType(referencePath: string): string {
  switch (path.extname(referencePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

/** 按数组顺序把参考图读成 dataURL（多参考图的顺序即「图1/图2/图3」，不重排）。 */
export function readReferencesAsDataUrls(referencePaths: string[]): string[] {
  return referencePaths.map(
    (referencePath) =>
      `data:${referenceMimeType(referencePath)};base64,${fs.readFileSync(referencePath).toString('base64')}`,
  );
}

/** 多参考图（≥2 张）时复述句里的出图模型标签。 */
export function multiRefEngineLabel(): string {
  return `${IMAGE_MULTI_REF.MODEL}（百炼多图编辑）`;
}
