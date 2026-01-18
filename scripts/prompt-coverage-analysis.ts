#!/usr/bin/env npx ts-node

/**
 * 提示词覆盖率分析脚本
 *
 * 对比 Code Agent 提示词与 Claude Code v2.0 的覆盖率
 *
 * 运行: npx ts-node scripts/prompt-coverage-analysis.ts
 */

import { buildAllPrompts } from '../src/main/generation/prompts/builder';
import {
  OUTPUT_FORMAT_RULES,
  HTML_GENERATION_RULES,
  PROFESSIONAL_OBJECTIVITY_RULES,
  CODE_REFERENCE_RULES,
  PARALLEL_TOOLS_RULES,
  PLAN_MODE_RULES,
  GIT_SAFETY_RULES,
  INJECTION_DEFENSE_RULES,
} from '../src/main/generation/prompts/rules';

// ============================================================================
// Claude Code v2.0 特性清单
// ============================================================================

interface Feature {
  name: string;
  category: string;
  implemented: boolean;
  ruleModule?: string;
  notes?: string;
}

const CLAUDE_CODE_FEATURES: Feature[] = [
  // === 核心行为 ===
  {
    name: '专业客观性',
    category: '核心行为',
    implemented: true,
    ruleModule: 'professionalObjectivity',
  },
  {
    name: '简洁输出',
    category: '核心行为',
    implemented: true,
    ruleModule: 'outputFormat',
  },
  {
    name: '代码引用格式 (file:line)',
    category: '核心行为',
    implemented: true,
    ruleModule: 'codeReference',
  },
  {
    name: '任务管理 (TodoWrite)',
    category: '核心行为',
    implemented: true,
    notes: '通过 Gen3 todo_write 工具实现',
  },

  // === 工具使用 ===
  {
    name: '并行工具调用',
    category: '工具使用',
    implemented: true,
    ruleModule: 'parallelTools',
  },
  {
    name: 'Plan Mode (EnterPlanMode/ExitPlanMode)',
    category: '工具使用',
    implemented: true,
    ruleModule: 'planMode',
  },
  {
    name: '专用工具优先于 Bash',
    category: '工具使用',
    implemented: true,
    notes: '在各工具 description 中说明',
  },
  {
    name: 'Task Agent (子代理)',
    category: '工具使用',
    implemented: false,
    notes: 'Gen7 计划实现 spawn_agent',
  },

  // === Git 操作 ===
  {
    name: 'Git 安全协议',
    category: 'Git',
    implemented: true,
    ruleModule: 'gitSafety',
  },
  {
    name: 'Git 提交格式 (HEREDOC)',
    category: 'Git',
    implemented: true,
    ruleModule: 'gitSafety',
  },
  {
    name: 'PR 创建流程',
    category: 'Git',
    implemented: true,
    ruleModule: 'gitSafety',
  },
  {
    name: '禁止 force push 到 main/master',
    category: 'Git',
    implemented: true,
    ruleModule: 'gitSafety',
  },

  // === 安全 ===
  {
    name: '注入防护',
    category: '安全',
    implemented: true,
    ruleModule: 'injectionDefense',
  },
  {
    name: '敏感信息保护',
    category: '安全',
    implemented: true,
    ruleModule: 'injectionDefense',
  },
  {
    name: '权限系统',
    category: '安全',
    implemented: true,
    notes: '通过 requiresPermission 工具属性实现',
  },

  // === Web/网络 ===
  {
    name: 'WebFetch 工具',
    category: 'Web',
    implemented: true,
    notes: 'Gen4 web_fetch',
  },
  {
    name: 'WebSearch 工具',
    category: 'Web',
    implemented: false,
    notes: '未实现',
  },

  // === 高级特性 ===
  {
    name: '会话总结',
    category: '高级',
    implemented: false,
    notes: 'Claude Code 有无限上下文总结',
  },
  {
    name: 'Hook 系统',
    category: '高级',
    implemented: true,
    notes: '通过 HooksEngine 实现',
  },
  {
    name: 'MCP 支持',
    category: '高级',
    implemented: true,
    notes: '已有 MCP server 实现',
  },
];

// ============================================================================
// 分析函数
// ============================================================================

function analyzeFeatures(): void {
  console.log('# Code Agent 提示词覆盖率分析');
  console.log('');
  console.log('> 对比 Claude Code v2.0 特性实现情况');
  console.log('');

  const categories = [...new Set(CLAUDE_CODE_FEATURES.map((f) => f.category))];

  let totalImplemented = 0;
  let totalFeatures = CLAUDE_CODE_FEATURES.length;

  for (const category of categories) {
    const features = CLAUDE_CODE_FEATURES.filter((f) => f.category === category);
    const implemented = features.filter((f) => f.implemented).length;

    console.log(`## ${category} (${implemented}/${features.length})`);
    console.log('');
    console.log('| 特性 | 状态 | 说明 |');
    console.log('|------|------|------|');

    for (const feature of features) {
      const status = feature.implemented ? '✅' : '❌';
      const note = feature.ruleModule
        ? `\`${feature.ruleModule}.ts\``
        : feature.notes || '';
      console.log(`| ${feature.name} | ${status} | ${note} |`);

      if (feature.implemented) totalImplemented++;
    }

    console.log('');
  }

  const percentage = ((totalImplemented / totalFeatures) * 100).toFixed(1);
  console.log('---');
  console.log('');
  console.log(`## 总体覆盖率: ${totalImplemented}/${totalFeatures} (${percentage}%)`);
  console.log('');
}

function analyzeRuleModules(): void {
  console.log('## 规则模块统计');
  console.log('');

  const modules = [
    { name: 'outputFormat', content: OUTPUT_FORMAT_RULES },
    { name: 'professionalObjectivity', content: PROFESSIONAL_OBJECTIVITY_RULES },
    { name: 'codeReference', content: CODE_REFERENCE_RULES },
    { name: 'parallelTools', content: PARALLEL_TOOLS_RULES },
    { name: 'planMode', content: PLAN_MODE_RULES },
    { name: 'gitSafety', content: GIT_SAFETY_RULES },
    { name: 'injectionDefense', content: INJECTION_DEFENSE_RULES },
    { name: 'htmlGeneration', content: HTML_GENERATION_RULES },
  ];

  console.log('| 模块 | 行数 | 字符数 |');
  console.log('|------|------|--------|');

  let totalLines = 0;
  let totalChars = 0;

  for (const mod of modules) {
    const lines = mod.content.split('\n').length;
    const chars = mod.content.length;
    totalLines += lines;
    totalChars += chars;
    console.log(`| ${mod.name} | ${lines} | ${chars} |`);
  }

  console.log(`| **总计** | **${totalLines}** | **${totalChars}** |`);
  console.log('');
}

function analyzePromptSizes(): void {
  console.log('## 各代际提示词大小');
  console.log('');

  const prompts = buildAllPrompts();

  console.log('| 代际 | 字符数 | 行数 |');
  console.log('|------|--------|------|');

  for (const [gen, prompt] of Object.entries(prompts)) {
    const chars = prompt.length;
    const lines = prompt.split('\n').length;
    console.log(`| ${gen} | ${chars} | ${lines} |`);
  }

  console.log('');
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  analyzeFeatures();
  analyzeRuleModules();
  analyzePromptSizes();

  console.log('## 未实现的 Claude Code v2.0 特性');
  console.log('');

  const notImplemented = CLAUDE_CODE_FEATURES.filter((f) => !f.implemented);
  for (const feature of notImplemented) {
    console.log(`- **${feature.name}** (${feature.category}): ${feature.notes || '待规划'}`);
  }

  console.log('');
  console.log('---');
  console.log('');
  console.log('*生成时间:', new Date().toISOString(), '*');
}

main();
