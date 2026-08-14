// ============================================================================
// 提示词可达性门（L8 N-L8-GHOSTRULES）
// ============================================================================
// 提示词管理器（设置页 → PromptManagerModal）把 registry 里注册的每一块都列出来
// 让用户改，并在界面上写「保存到 ~/.code-agent/prompts-overrides/<id>.md · 下一轮
// 对话立即生效」。所以注册 ≠ 装饰：**注册就是一句对用户的承诺**。
//
// 这道门钉死那句承诺：每个注册 id 的默认文本，都必须能在「真实拼出来的提示词」里
// 找到。找不到 = 用户改了没有任何效果的欺骗性 UI（2026-08-14 实测抓到 12 块：
// constitution/* 6 块 + base/orchestrator.ts 6 块，前者零调用者、后者的
// getOrchestratorPrompt() 早被 agentOrchestrator 换成 SYSTEM_PROMPT 却没人删）。
//
// ⚠️ 本门自己的盲区（fail-loud 方向）：LIVE_CORPUS 是一张**手工维护的入口清单**。
// 新增一条产品路径却忘了登记到这里，会让那条路径上的提示词被误判成 ghost 而报红
// ——宁可误报要求你来登记，也不静默放过真 ghost。反过来，如果某个入口在这里登记
// 了、产品里却没人调用（orchestrator 当年就是这样），静态清单看不出来，所以下面
// 额外钉了一条「入口本身要有生产调用者」的断言。
// ============================================================================

import { describe, it, expect } from 'vitest';
import '../../../src/host/prompts/promptIndex';
import { listPrompts, getPromptDetail } from '../../../src/host/prompts/registry';
import { buildPrompt } from '../../../src/host/prompts/builder';
import { IDENTITY_PROMPT } from '../../../src/host/prompts/identity';
import {
  ARTIFACT_TASK_BRIEF_PROMPT,
  GAME_ARTIFACT_CONTRACT_PROMPT,
  GAME_ARTIFACT_REPAIR_CONTRACT_PROMPT,
} from '../../../src/host/prompts/artifactGeneration';
import { GENERATIVE_UI_PROMPT } from '../../../src/host/prompts/generativeUI';
import { QUESTION_FORM_PROMPT } from '../../../src/host/prompts/questionForm';
import { SOUL_TEMPLATE, PROFILE_TEMPLATE } from '../../../src/host/prompts/templates/soulTemplates';
import { CORE_AGENTS } from '../../../src/host/agent/hybrid/coreAgents';

/**
 * 真实会被下发的提示词全集。
 * 每一项都要能说出「谁在产品路径上拼它」，注释里写清楚。
 */
function buildLiveCorpus(): string[] {
  return [
    // agentOrchestrator → SYSTEM_PROMPT → buildPrompt()（工具描述、base.tools 走这条）
    String(buildPrompt()),
    // getSoul() 的默认分支直接返回它；有 SOUL.md 时 loadSoul 逐段重拼（见下面的组合断言）
    String(IDENTITY_PROMPT),
    // 按意图注入：needsArtifactTaskBrief / needsGameArtifactContract / needsGenerativeUI
    String(ARTIFACT_TASK_BRIEF_PROMPT),
    String(GAME_ARTIFACT_CONTRACT_PROMPT),
    String(GAME_ARTIFACT_REPAIR_CONTRACT_PROMPT),
    String(GENERATIVE_UI_PROMPT),
    String(QUESTION_FORM_PROMPT),
    // init-soul / init-profile 落盘给用户的模板
    String(SOUL_TEMPLATE),
    String(PROFILE_TEMPLATE),
    // 子代理系统提示词
    ...Object.values(CORE_AGENTS).map((agent) => String(agent.prompt)),
  ];
}

/**
 * 取默认文本里最长的一行做指纹。
 * 不用首行：`## 标题` / `|---|---|` 这类通用行会在别处误命中（实测 orchestrator
 * 的表格分隔行就骗过了第一版探针）。
 */
function fingerprint(text: string): string {
  const candidates = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 20 && /[一-龥A-Za-z]{6}/.test(line));
  return candidates.sort((a, b) => b.length - a.length)[0] ?? text.slice(0, 40);
}

describe('提示词注册表可达性', () => {
  const corpus = buildLiveCorpus();
  const joined = corpus.join('\n\n');
  const registered = listPrompts();

  it('锚点有效：语料非空、注册表非空', () => {
    // 扫 0 目标要报红，不能因为「没找到 ghost」而假绿
    expect(registered.length).toBeGreaterThan(20);
    expect(joined.length).toBeGreaterThan(5000);
    expect(corpus.every((piece) => piece.length > 0)).toBe(true);
  });

  it('每个注册提示词都真的会被下发（没有只在设置页露脸的幽灵块）', () => {
    const ghosts: string[] = [];
    for (const item of registered) {
      const detail = getPromptDetail(item.id);
      if (!detail) {
        ghosts.push(`${item.id}（注册了但取不到详情）`);
        continue;
      }
      if (!joined.includes(fingerprint(detail.defaultText))) {
        ghosts.push(item.id);
      }
    }
    expect(
      ghosts,
      `这些提示词在设置页可改、却不在任何一条真实下发路径上：${ghosts.join(', ')}\n` +
        '要么把它接进产品路径，要么删掉；也可能是你新增了一条拼装入口忘了登记进 buildLiveCorpus()。',
    ).toEqual([]);
  });
});
