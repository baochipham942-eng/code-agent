#!/usr/bin/env tsx
// ============================================================================
// 固定上下文开销棘轮（only-decrease）—— N-EVAL-TWO-LAYER-METRICS Layer 1
// ----------------------------------------------------------------------------
// 与 attention-budget-ratchet（注入文案）和 coreToolSchemaBudget（CORE schema
// 上限 4628，带 5% 措辞余量）互补，本门把「默认配置下模型每轮必付的固定上下文」
// 作为一个整体钉在实测真值上，只降不升、零余量：
//   1. systemPromptDefaultTokens —— 默认 agent 配置的系统提示词（buildPrompt() 实跑）
//   2. deferredToolsBlockTokens —— <deferred-tools> 折叠索引块（messageBuild 组装路径）
//   3. toolDefinitionTokensDefault —— 默认下发的工具表 = CORE schema + 折叠索引块
//   4. expertModeTokens.<mode> —— 每个专家/专项子代理模式的固定提示词开销
// deferred 全展开总量只作诊断打印（反事实口径：不折叠时工具表有多大），不进门——
// 新增 deferred 工具不增加每轮固定开销，把它锁进棘轮只会制造无意义的基线维护。
//
// 确定性口径（同配置两次运行必须逐字节同数）：
//   - CODE_AGENT_DATA_DIR 指向脚本自建的空临时目录 → 无 SOUL.md / prompts-overrides /
//     config.json，全部走内置默认文本（probe 实测 buildPrompt() 两次调用逐字节相同）
//   - Date 钉死在 FIXED_MEASURE_CLOCK（today anchor / WebSearch dynamicDescription
//     都是日期函数，不钉会出现跨日漂移）
//   - 诊断值 deferred 展开/折叠对比同样受上述口径约束
// 每轮按会话变化的内容（working directory 注入、memory index、plugins、skills、MCP
// 名册）不属于「固定开销」，刻意排除在本门外。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const baselinePath = path.join(scriptDir, 'context-overhead-ratchet-baseline.json');

interface RatchetBaseline {
  schemaVersion: number;
  /** 默认配置系统提示词 token（buildPrompt 实跑，钉死时钟） */
  systemPromptDefaultTokens: number;
  /** 防空构建假绿的下限：buildPrompt 链路坏了会返回空/极短文本而非「变省」 */
  systemPromptMinTokens: number;
  /** <deferred-tools> 折叠索引块 token（含包裹文案，builtin-only、无 MCP） */
  deferredToolsBlockTokens: number;
  /** 默认下发工具表 = CORE schema + 折叠索引块 */
  toolDefinitionTokensDefault: number;
  /** 每个专家/专项模式的固定提示词（coreAgent.<id> = prompt+suffix；builtin.<role> = systemPrompt） */
  expertModeTokens: Record<string, number>;
  reason: string;
}

function fail(message: string): never {
  console.error(`[context-overhead-ratchet] ✗ ${message}`);
  process.exit(1);
}

function readBaseline(): RatchetBaseline {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    fail(`无法读取基线 ${path.relative(repoRoot, baselinePath)}：${error instanceof Error ? error.message : String(error)}`);
  }
  const baseline = raw as Partial<RatchetBaseline>;
  const numberKeys: Array<keyof RatchetBaseline> = [
    'systemPromptDefaultTokens', 'systemPromptMinTokens', 'deferredToolsBlockTokens', 'toolDefinitionTokensDefault',
  ];
  if (baseline.schemaVersion !== 1
    || numberKeys.some((key) => !Number.isFinite(baseline[key] as number))
    || !baseline.expertModeTokens
    || Object.values(baseline.expertModeTokens).some((value) => !Number.isFinite(value))
    || typeof baseline.reason !== 'string' || !baseline.reason.trim()) {
    fail('基线格式无效：提额必须保留全部数值字段、expertModeTokens 映射和非空理由');
  }
  return baseline as RatchetBaseline;
}

// —— 确定性环境：先建空数据目录 + 钉死时钟，再动态加载 host 代码 ——————————————

const FIXED_MEASURE_CLOCK_MS = new Date('2026-08-14T04:00:00Z').getTime();

const measureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-overhead-ratchet-'));
process.env.CODE_AGENT_DATA_DIR = measureDir;

const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED_MEASURE_CLOCK_MS);
    else super(args[0] as string | number | Date);
  }
  static now(): number { return FIXED_MEASURE_CLOCK_MS; }
}
(globalThis as { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor;

function cleanup(): void {
  try { fs.rmSync(measureDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响门结论 */ }
}
process.on('exit', cleanup);

// —— AST：从 messageBuild.ts 抽 <deferred-tools> 块的固定包裹文案 ————————————
// 与 attention-budget-ratchet 的 voiceStaticText 同款手法：块模板是内联的
// TemplateExpression（head + ${deferredToolsSummary} + tail），量代码不量文档，
// 模板被挪走/删除时这里 fail loud，不会静默变成 0 假绿。
function extractDeferredToolsWrapperParts(): { head: string; tail: string } {
  const file = path.join(repoRoot, 'src/host/agent/runtime/contextAssembly/messageBuild.ts');
  if (!fs.existsSync(file)) fail(`测量路径失效：${path.relative(repoRoot, file)} 不存在`);
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let result: { head: string; tail: string } | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node) && node.head.text.includes('<deferred-tools>')) {
      const tail = node.templateSpans.map((span) => span.literal.text).join('');
      result = { head: node.head.text, tail };
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  // 闭包内赋值不参与控制流收窄，读出时显式还原声明类型
  const wrapperParts = result as { head: string; tail: string } | null;
  if (!wrapperParts || !wrapperParts.tail.includes('</deferred-tools>')) {
    fail('未在 messageBuild.ts 找到 <deferred-tools> 块模板，测量路径已失效，请先修脚本再过门');
  }
  return wrapperParts;
}

async function main(): Promise<void> {
  const baseline = readBaseline();

  // 动态 import：必须晚于 env/时钟固化（buildPrompt 链读取 CODE_AGENT_DATA_DIR 与当前时间）
  const { buildPrompt } = await import('../../src/host/prompts/builder');
  const { estimateTokens } = await import('../../src/host/context/tokenEstimator');
  const { getDeferredToolsSummary } = await import('../../src/host/tools/dispatch/toolDefinitions');
  const { CORE_TOOLS } = await import('../../src/host/services/toolSearch/deferredTools');
  const { CORE_AGENTS, SUBAGENT_SUFFIXES } = await import('../../src/host/agent/hybrid/coreAgents');
  const { BUILT_IN_AGENTS } = await import('../../src/shared/contract/builtInAgents');

  // 1) 默认配置系统提示词
  const systemPrompt = buildPrompt();
  if (systemPrompt.length < 1000) fail(`buildPrompt() 只返回 ${systemPrompt.length} 字符，构建链路坏了，不是变省了`);
  const systemPromptTokens = estimateTokens(systemPrompt);

  // 2) <deferred-tools> 折叠索引块（默认参数 = builtin-only、无 MCP、无 denied/allowlist）
  const summary = getDeferredToolsSummary([], undefined);
  if (!summary.trim()) fail('getDeferredToolsSummary 返回空，折叠索引测量已失效');
  const wrapper = extractDeferredToolsWrapperParts();
  const deferredBlockTokens = estimateTokens(`${wrapper.head}${summary}${wrapper.tail}`);

  // 3) 默认下发工具表：CORE schema（与 coreToolSchemaBudget 同一刀口——扫 modules 下
  //    .schema.ts、dynamicDescription 优先、按 {name, description, parameters} 序列化）
  const modulesDir = path.join(repoRoot, 'src/host/tools/modules');
  const coreNames = new Set(CORE_TOOLS);
  const found: Array<{ name: string; tokens: number }> = [];
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(file));
      else if (entry.name.endsWith('.schema.ts')) out.push(file);
    }
    return out;
  };
  for (const file of walk(modulesDir)) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      const schema = value as { name?: unknown; description?: unknown; inputSchema?: unknown; dynamicDescription?: () => unknown };
      if (!schema || typeof schema !== 'object' || typeof schema.name !== 'string' || !schema.inputSchema) continue;
      const description = (typeof schema.dynamicDescription === 'function'
        ? schema.dynamicDescription()
        : undefined) ?? schema.description;
      if (typeof description !== 'string') continue;
      found.push({
        name: schema.name,
        tokens: estimateTokens(JSON.stringify({ name: schema.name, description, parameters: schema.inputSchema })),
      });
    }
  }
  if (found.length <= 10) fail(`schema 扫描只命中 ${found.length} 个工具，扫描路径疑似失效，禁止假绿`);
  const coreFound = found.filter((tool) => coreNames.has(tool.name));
  const missingCore = CORE_TOOLS.filter((name) => !coreFound.some((tool) => tool.name === name));
  if (missingCore.length > 0) fail(`CORE 工具在 modules 下找不到 schema：${missingCore.join(', ')}`);
  const coreSchemaTokens = coreFound.reduce((sum, tool) => sum + tool.tokens, 0);
  const toolDefinitionDefaultTokens = coreSchemaTokens + deferredBlockTokens;

  // 诊断（不进门）：deferred 不折叠时的反事实工具表总量
  const expandedTokens = found.reduce((sum, tool) => sum + tool.tokens, 0);

  // 4) 专家/专项模式固定开销
  const expertModeTokens: Record<string, number> = {};
  for (const [id, config] of Object.entries(CORE_AGENTS)) {
    const prompt = String(config.prompt);
    const suffix = SUBAGENT_SUFFIXES[id as keyof typeof SUBAGENT_SUFFIXES] ?? '';
    expertModeTokens[`coreAgent.${id}`] = estimateTokens(prompt + suffix);
  }
  for (const [role, config] of Object.entries(BUILT_IN_AGENTS)) {
    expertModeTokens[`builtin.${role}`] = estimateTokens(config.systemPrompt);
  }
  if (Object.keys(expertModeTokens).length === 0) fail('专家模式清单为空，测量路径已失效');

  // —— 报告 ——————————————————————————————————————————————————————————————
  console.log(`[context-overhead-ratchet] 系统提示词（默认配置） current=${systemPromptTokens} baseline=${baseline.systemPromptDefaultTokens}`);
  console.log(`[context-overhead-ratchet] <deferred-tools> 折叠索引块 current=${deferredBlockTokens} baseline=${baseline.deferredToolsBlockTokens}`);
  console.log(`[context-overhead-ratchet] 工具表默认下发总量 current=${toolDefinitionDefaultTokens} baseline=${baseline.toolDefinitionTokensDefault}（CORE schema ${coreSchemaTokens} + 折叠索引 ${deferredBlockTokens}）`);
  const modeDetail = Object.entries(expertModeTokens).sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key}=${value}`).join(' ');
  console.log(`[context-overhead-ratchet] 专家/专项模式固定开销 ${Object.keys(expertModeTokens).length} 项：${modeDetail}`);
  console.log(`[context-overhead-ratchet] 诊断：deferred 全展开 ${expandedTokens} token/轮，折叠后省 ${expandedTokens - toolDefinitionDefaultTokens} token/轮（不进门）`);

  // —— 棘轮判定（only-decrease）———————————————————————————————————————————
  let failed = false;
  if (systemPromptTokens < baseline.systemPromptMinTokens) {
    failed = true;
    console.error(`[context-overhead-ratchet] ✗ 系统提示词 ${systemPromptTokens} 低于下限 ${baseline.systemPromptMinTokens}——疑似构建链路损坏（soul/工具描述缺失），不是变省了`);
  }
  const ratchetNumbers: Array<[string, number, number]> = [
    ['系统提示词（默认配置）', systemPromptTokens, baseline.systemPromptDefaultTokens],
    ['<deferred-tools> 折叠索引块', deferredBlockTokens, baseline.deferredToolsBlockTokens],
    ['工具表默认下发总量', toolDefinitionDefaultTokens, baseline.toolDefinitionTokensDefault],
  ];
  for (const [label, current, baselineValue] of ratchetNumbers) {
    if (current > baselineValue) {
      failed = true;
      console.error(`[context-overhead-ratchet] ✗ ${label}超基线 +${current - baselineValue} token。每涨 1 token = 每一轮请求都多付 1 token；确属产品有意提额时，在基线文件显式提额并写理由（context-overhead-ratchet-baseline.json）`);
    }
  }
  const unregistered = Object.keys(expertModeTokens).filter((key) => !(key in baseline.expertModeTokens));
  if (unregistered.length > 0) {
    failed = true;
    console.error(`[context-overhead-ratchet] ✗ 出现未登记的专家/专项模式：${unregistered.join(', ')}——新模式的固定开销必须显式登记进基线并写理由，不许悄悄上线`);
  }
  for (const [key, current] of Object.entries(expertModeTokens)) {
    if (key in baseline.expertModeTokens && current > baseline.expertModeTokens[key]) {
      failed = true;
      console.error(`[context-overhead-ratchet] ✗ 专家模式 ${key} 超基线 +${current - baseline.expertModeTokens[key]} token；确属有意扩充时在基线提额并写理由`);
    }
  }
  if (failed) process.exit(1);
  console.log('[context-overhead-ratchet] ✓ 系统提示词、折叠索引块、默认工具表与全部专家模式固定开销均未超基线');
}

await main();
