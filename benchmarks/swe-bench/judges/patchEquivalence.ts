/**
 * Patch 语义等价 Judge
 *
 * 用 DeepSeek 评 agent.diff 和 SWE-bench standard.patch 在实质语义上是否等价。
 * 区分"实质等价"（行号位移/上下文不同）和"实质不等价"（字符串值错/key 错/逻辑分支错）。
 *
 * 用 DeepSeek 而非 Claude/Mimo：① 避免跟被评 agent（mimo）同源造成自评偏差
 * ② 国内 API 免代理 ③ 在 code/patch 理解上够用 ④ 成本低
 */

export interface JudgeInput {
  problem_statement: string;
  agent_diff: string;
  standard_patch: string;
}

export interface JudgeResult {
  semantic_match: number; // 0-100
  matches_intent: boolean; // agent 改的方向对不对
  matches_implementation: boolean; // agent 改的细节（key/value/字符串）跟 standard 一致
  key_differences: string[]; // 列出 agent 跟 standard 实质不同的地方
  reasoning: string;
  judge_model: string;
  judge_raw: string; // 完整 raw 输出（debug 用）
}

const JUDGE_SYSTEM_PROMPT = `你是一个代码审查专家，专门评估 AI agent 修复 bug 的 patch 是否在语义上等价于人类标准答案。

你的任务：
- 输入: 一个 SWE-bench 任务（问题描述 + agent 产出的 patch + 人类标准 patch）
- 输出: 评估 agent patch 跟标准 patch 在【实质语义】上的等价度（0-100 分）

【实质等价】（不应扣分）:
- 行号、上下文行不同
- 变量名重命名但语义一致
- 等价的实现方式（如 list comprehension vs map）
- 注释/空行差异
- 多余但无害的改动（如多加了一个合理的辅助函数）

【实质不等价】（必须扣分）:
- 字符串字面量值不同（如 "br" vs "x-brotli"，"DISTINCT " vs "DISTINCT"）
- 字典 key 不同（修了不该修的 key，或加了 standard 里没有的 key）
- 加错或漏掉关键 case（如 standard 加了 "br" 和 "compress" 两个 key，agent 只加了 "compress"）
- 修改的逻辑分支错（standard 改 if 分支，agent 改 else 分支）
- 改了无关函数 / 误删代码

评分标准：
- 90-100: 实质完全等价
- 70-89: 实质等价但有小差异（如多加了无害分支）
- 50-69: 部分等价（修对了一半，或修对了大方向但细节错）
- 30-49: 大部分错（修错关键 key/value，但能看出试图修这个 bug）
- 0-29: 完全不等价 / 没修对

只返回 JSON，不要任何其他内容：
{
  "semantic_match": 0-100 整数,
  "matches_intent": true/false (agent 是否在试图修这个 bug),
  "matches_implementation": true/false (实质细节是否一致),
  "key_differences": ["差异1", "差异2", ...] (用一句话描述每个实质差异),
  "reasoning": "一两句话总结"
}`;

const JUDGE_MODEL = 'deepseek-chat';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export async function judgePatchEquivalence(input: JudgeInput): Promise<JudgeResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const userMsg = `# Problem Statement
${input.problem_statement}

# Agent Patch
\`\`\`diff
${input.agent_diff || '(empty)'}
\`\`\`

# Human Standard Patch
\`\`\`diff
${input.standard_patch}
\`\`\`

请评估 Agent Patch 跟 Standard Patch 的语义等价度。返回 JSON。`;

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.0, // judge 要稳定，零温度
      max_tokens: 1500,
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepSeek judge HTTP ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const raw = data.choices?.[0]?.message?.content ?? '';

  // 提取 JSON（DeepSeek 偶尔会包 ```json``` fence）
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      semantic_match: 0,
      matches_intent: false,
      matches_implementation: false,
      key_differences: ['JUDGE PARSE ERROR: no JSON in response'],
      reasoning: raw.slice(0, 200),
      judge_model: JUDGE_MODEL,
      judge_raw: raw,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<JudgeResult>;
    return {
      semantic_match: typeof parsed.semantic_match === 'number' ? parsed.semantic_match : 0,
      matches_intent: parsed.matches_intent ?? false,
      matches_implementation: parsed.matches_implementation ?? false,
      key_differences: Array.isArray(parsed.key_differences) ? parsed.key_differences : [],
      reasoning: parsed.reasoning ?? '',
      judge_model: JUDGE_MODEL,
      judge_raw: raw,
    };
  } catch (e) {
    return {
      semantic_match: 0,
      matches_intent: false,
      matches_implementation: false,
      key_differences: [`JUDGE JSON PARSE ERROR: ${(e as Error).message}`],
      reasoning: raw.slice(0, 200),
      judge_model: JUDGE_MODEL,
      judge_raw: raw,
    };
  }
}
