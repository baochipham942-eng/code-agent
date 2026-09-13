// profile 文件级校验（runner --profile 与 harness-profile.ts 共用；只有脚本消费，故不进 src）。
// 顶层必须是带 `knobs` 键的对象（`[]`、`{}`、缺键都拒），再走共享的 validateHarnessKnobs。
// 不许「文件非法但按默认跑」——run 记录会盖上 profile 路径，结果会被错误归因（PR#1769 ai-review R3）。
import { validateHarnessKnobs, type HarnessKnobs } from '../../src/shared/constants/harnessKnobs.ts';

export function validateHarnessProfile(value: unknown): HarnessKnobs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('harness profile 顶层必须是对象：{ "knobs": { … } }');
  }
  if (!('knobs' in value)) {
    throw new Error('harness profile 缺少 knobs 键：{ "knobs": { … } }');
  }
  return validateHarnessKnobs((value as { knobs: unknown }).knobs);
}
