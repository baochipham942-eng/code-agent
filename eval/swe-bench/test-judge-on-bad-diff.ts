/**
 * 临时脚本：单独验证 judge 是否能识破假阳性（不重新让 agent 跑）
 * 把上次错的 agent.diff（x-brotli/x-br/sbcs 错误那版）喂给 DeepSeek judge，看打多少分
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

import { judgePatchEquivalence } from './judges/patchEquivalence';

async function main() {
  const dir = path.join(REPO_ROOT, 'eval/swe-bench/runs/2026-04-28-django__django-16642-single');
  const badDiff = fs.readFileSync(path.join(dir, 'agent.diff'), 'utf8');
  const standard = fs.readFileSync(path.join(dir, 'standard.patch'), 'utf8');

  const lines = fs
    .readFileSync(path.join(REPO_ROOT, 'eval-datasets/swe-bench/verified.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);
  const ps = lines
    .map((l) => JSON.parse(l))
    .find((c) => c.instance_id === 'django__django-16642').problem_statement;

  console.log('=== 验证 judge 杀假阳性能力 ===');
  console.log('输入：上次 agent.diff（错版本，"x-brotli"/"x-br" key 错 + "-sbcs" 后缀编造）');
  console.log('对照：standard.patch（正确："br" + "compress" 两个 key）\n');

  const judge = await judgePatchEquivalence({
    problem_statement: ps,
    agent_diff: badDiff,
    standard_patch: standard,
  });
  console.log('semantic_match:', judge.semantic_match);
  console.log('matches_intent:', judge.matches_intent);
  console.log('matches_implementation:', judge.matches_implementation);
  console.log('key_differences:');
  for (const d of judge.key_differences) console.log('  -', d);
  console.log('\nreasoning:', judge.reasoning);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
