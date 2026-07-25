#!/usr/bin/env node
// ============================================================================
// LiteLLM 价目快照生成器（手动刷新，产物提交进仓库）
//
// 用法: HTTPS_PROXY=http://127.0.0.1:7897 node scripts/generate-litellm-snapshot.mjs
// 产物: src/shared/pricing/litellmSnapshot.json（仅含 model-catalog 内模型，
//       别名映射维护在 src/shared/pricing/pricingAliases.json）
// 失败: 网络失败不覆盖旧快照（保留旧缓存，符合设计稿缓存策略）。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/shared/model-catalog.json'), 'utf-8'));
const aliases = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/shared/pricing/pricingAliases.json'), 'utf-8'));

const res = await fetch(SRC);
if (!res.ok) {
  console.error(`fetch failed: ${res.status} — 保留旧快照不覆盖`);
  process.exit(1);
}
const lite = await res.json();

function priced(entry) {
  return entry && entry.input_cost_per_token != null && entry.output_cost_per_token != null;
}

function lookup(providerId, modelId) {
  const full = `${providerId}/${modelId}`;
  const cands = [aliases[full], modelId, full, providerId === 'claude' ? `anthropic/${modelId}` : null].filter(Boolean);
  for (const key of cands) {
    if (priced(lite[key])) return [key, lite[key]];
  }
  return [null, null];
}

const entries = {};
const unknown = [];
for (const provider of catalog.providers) {
  for (const model of provider.models ?? []) {
    const full = `${provider.id}/${model.id}`;
    const [key, entry] = lookup(provider.id, model.id);
    if (entry) {
      entries[full] = {
        litellmKey: key,
        inputPerMTok: Number((entry.input_cost_per_token * 1e6).toFixed(4)),
        outputPerMTok: Number((entry.output_cost_per_token * 1e6).toFixed(4)),
      };
    } else {
      unknown.push(full);
    }
  }
}

const out = {
  source: 'litellm model_prices_and_context_window.json',
  fetchedAt: new Date().toISOString().slice(0, 10),
  entries,
};
fs.writeFileSync(
  path.join(repoRoot, 'src/shared/pricing/litellmSnapshot.json'),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(`snapshot: ${Object.keys(entries).length} 条；无刊例（走 catalog/unknown）: ${unknown.length} 条`);
for (const u of unknown) console.log(`  - ${u}`);
