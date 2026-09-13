#!/usr/bin/env npx tsx
// harness-profile — 生成 / 对比 harness 旋钮 profile（N-HARNESS-PROFILE-SURFACE 试点）
//
//   npx tsx scripts/rsi-pilot/harness-profile.ts emit <out.json>            # 写出生产默认全表
//   npx tsx scripts/rsi-pilot/harness-profile.ts diff <a.json> <b.json>     # 人读 diff，只列不同项
//   npx tsx scripts/rsi-pilot/harness-profile.ts check <profile.json>       # 只校验（未知键/越界即非零退出）
//
// profile 形状：{ "knobs": { "<key>": number } }，键集 = HARNESS_KNOB_DEFAULTS。
// 回滚 = 不带 --profile 跑 runner；run 记录里 harness.knobs 与 emit 出的全表逐字一致。
import fs from 'fs/promises';
import path from 'path';
import {
  HARNESS_KNOB_DEFAULTS,
  validateHarnessKnobs,
  type HarnessKnobKey,
  type HarnessKnobs,
} from '../../src/host/agent/runtime/harnessKnobs.ts';

/** 两份旋钮表的人读 diff：只列不同项，缺省键按默认值比。 */
function diffHarnessKnobs(before: HarnessKnobs, after: HarnessKnobs): string[] {
  return (Object.keys(HARNESS_KNOB_DEFAULTS) as HarnessKnobKey[]).flatMap((key) => {
    const a = before[key] ?? HARNESS_KNOB_DEFAULTS[key];
    const b = after[key] ?? HARNESS_KNOB_DEFAULTS[key];
    return a === b ? [] : [`${key}: ${a} → ${b}`];
  });
}

async function readProfile(file: string): Promise<HarnessKnobs> {
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const raw = JSON.parse(await fs.readFile(abs, 'utf-8')) as { knobs?: unknown };
  return validateHarnessKnobs(raw.knobs ?? {});
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'emit' && a) {
    const out = path.isAbsolute(a) ? a : path.join(process.cwd(), a);
    await fs.writeFile(out, `${JSON.stringify({ knobs: HARNESS_KNOB_DEFAULTS }, null, 2)}\n`, 'utf-8');
    console.log(`wrote ${out}`);
    return;
  }
  if (cmd === 'diff' && a && b) {
    const lines = diffHarnessKnobs(await readProfile(a), await readProfile(b));
    console.log(lines.length === 0 ? '(no differences)' : lines.join('\n'));
    return;
  }
  if (cmd === 'check' && a) {
    const knobs = await readProfile(a);
    console.log(`ok: ${Object.keys(knobs).length} knob(s) — ${diffHarnessKnobs({}, knobs).join('; ') || 'all defaults'}`);
    return;
  }
  console.error('Usage: harness-profile.ts emit <out.json> | diff <a.json> <b.json> | check <profile.json>');
  process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
