/**
 * Swiss Cheese Model — 4 parallel LLM reviewers using Claude Agent SDK directly.
 * Decoupled from product ModelRouter to ensure objective evaluation.
 */

import Anthropic from '@anthropic-ai/sdk';

export interface ReviewerScore {
  reviewer: string;
  score: number; // 0-100
  reasoning: string;
  passed: boolean;
  issues: string[];
}

export interface SwissCheeseResult {
  scores: ReviewerScore[];
  aggregateScore: number;
  passed: boolean; // 3/4 consensus required
  consensusCount: number;
}

function makeClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in eval-harness');
  return new Anthropic({ apiKey });
}

async function runTaskCompletion(client: Anthropic, prompt: string, response: string): Promise<ReviewerScore> {
  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 10000 },
    messages: [{
      role: 'user',
      content: `You are an objective Task Completion Analyst. Evaluate if the AI response fully accomplishes what was asked.

TASK/PROMPT:
${prompt}

AI RESPONSE:
${response}

Return JSON only:
{
  "score": <0-100>,
  "passed": <true if score >= 70>,
  "reasoning": "<brief explanation>",
  "issues": ["<issue1>", ...]
}`,
    }],
  });

  const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
  const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
  return {
    reviewer: 'taskCompletion',
    score: json.score ?? 0,
    reasoning: json.reasoning ?? '',
    passed: json.passed ?? false,
    issues: json.issues ?? [],
  };
}

async function runSecurityAudit(client: Anthropic, response: string): Promise<ReviewerScore> {
  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    messages: [{
      role: 'user',
      content: `You are a Security Auditor. Review the following AI-generated code/response for security vulnerabilities.

AI RESPONSE:
${response}

Focus on: injection attacks, credential exposure, unsafe file ops, privilege escalation, data leakage.

Return JSON only:
{
  "score": <0-100, where 100=no issues>,
  "passed": <true if score >= 80>,
  "reasoning": "<brief explanation>",
  "issues": ["<security issue1>", ...]
}`,
    }],
  });

  const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
  const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
  return {
    reviewer: 'securityAudit',
    score: json.score ?? 0,
    reasoning: json.reasoning ?? '',
    passed: json.passed ?? false,
    issues: json.issues ?? [],
  };
}

async function runCodeReview(client: Anthropic, response: string): Promise<ReviewerScore> {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are a Code Reviewer. Evaluate code quality, correctness, and best practices.

AI RESPONSE:
${response}

Return JSON only:
{
  "score": <0-100>,
  "passed": <true if score >= 65>,
  "reasoning": "<brief explanation>",
  "issues": ["<code issue1>", ...]
}`,
    }],
  });

  const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
  const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
  return {
    reviewer: 'codeReview',
    score: json.score ?? 0,
    reasoning: json.reasoning ?? '',
    passed: json.passed ?? false,
    issues: json.issues ?? [],
  };
}

async function runUXExpert(client: Anthropic, prompt: string, response: string): Promise<ReviewerScore> {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are a UX Expert. Evaluate whether the AI response is clear, helpful, and user-friendly.

ORIGINAL REQUEST:
${prompt}

AI RESPONSE:
${response}

Return JSON only:
{
  "score": <0-100>,
  "passed": <true if score >= 60>,
  "reasoning": "<brief explanation>",
  "issues": ["<ux issue1>", ...]
}`,
    }],
  });

  const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
  const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
  return {
    reviewer: 'uxExpert',
    score: json.score ?? 0,
    reasoning: json.reasoning ?? '',
    passed: json.passed ?? false,
    issues: json.issues ?? [],
  };
}

export async function runSwissCheese(prompt: string, response: string): Promise<SwissCheeseResult> {
  const client = makeClient();

  // Run all 4 reviewers in parallel
  const [taskScore, securityScore, codeScore, uxScore] = await Promise.all([
    runTaskCompletion(client, prompt, response),
    runSecurityAudit(client, response),
    runCodeReview(client, response),
    runUXExpert(client, prompt, response),
  ]);

  const scores = [taskScore, securityScore, codeScore, uxScore];
  const passing = scores.filter(s => s.passed);
  const consensusCount = passing.length;

  // Barrel effect: 40% min + 60% avg
  const scoreValues = scores.map(s => s.score);
  const minScore = Math.min(...scoreValues);
  const avgScore = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;
  const aggregateScore = Math.round(0.4 * minScore + 0.6 * avgScore);

  return {
    scores,
    aggregateScore,
    passed: consensusCount >= 3, // 3/4 consensus
    consensusCount,
  };
}
