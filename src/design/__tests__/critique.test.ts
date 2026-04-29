import { describe, expect, it, vi } from 'vitest';
import {
  CRITIQUE_DIMENSIONS,
  CritiqueParseError,
  buildCritiquePrompt,
  parseCritiqueResponse,
  runCritique,
} from '../critique';
import type { CritiqueCaller, CritiqueInput } from '../critique';
import { directionTokens } from '../direction-tokens';

function makeInput(overrides: Partial<CritiqueInput> = {}): CritiqueInput {
  return {
    brief: {
      intent: '给设计师作品集做一个 hero',
      surface: 'landing_page',
      direction: 'editorial',
      directionTokens: directionTokens.editorial,
      constraints: ['必须有暗色模式'],
      ...overrides.brief,
    },
    artifact: {
      kind: 'html',
      content: '<section><h1>Portfolio</h1><p>...</p></section>',
      ...overrides.artifact,
    },
  };
}

const FULL_RESPONSE = JSON.stringify({
  scores: [
    { dimension: 'palette', score: 4, reason: '主色和 accent 色调对，但 muted 偏冷' },
    { dimension: 'typography', score: 5, reason: 'serif 标题 + sans 正文层级清晰' },
    { dimension: 'posture', score: 4, reason: '编辑感够，但小标题节奏略平' },
    { dimension: 'surface', score: 5, reason: 'landing 节奏正确' },
    { dimension: 'constraint', score: 3, reason: '暗色模式仅声明未实现' },
  ],
  summary: '整体兑现 editorial direction，留两处可打磨',
});

describe('buildCritiquePrompt', () => {
  it('embeds directionTokens palette + posture + 5 dimensions in the prompt', () => {
    const prompt = buildCritiquePrompt(makeInput());
    for (const dim of CRITIQUE_DIMENSIONS) {
      expect(prompt).toContain(dim);
    }
    expect(prompt).toContain(directionTokens.editorial.posture);
    expect(prompt).toContain(directionTokens.editorial.palette.primary);
    expect(prompt).toContain('landing_page');
    expect(prompt).toContain('必须有暗色模式');
    expect(prompt).toContain('"scores"');
  });

  it('handles brief with no directionTokens / no constraints gracefully', () => {
    const prompt = buildCritiquePrompt({
      brief: { intent: 'minimal' },
      artifact: { kind: 'text', content: 'hello' },
    });
    expect(prompt).toContain('intent: minimal');
    expect(prompt).not.toContain('directionTokens:');
    expect(prompt).not.toContain('constraints:');
  });
});

describe('parseCritiqueResponse', () => {
  it('parses a complete JSON response', () => {
    const result = parseCritiqueResponse(FULL_RESPONSE);
    expect(result.scores).toHaveLength(5);
    expect(result.scores.map((s) => s.dimension).sort()).toEqual([...CRITIQUE_DIMENSIONS].sort());
    expect(result.overall).toBeCloseTo(4.2, 2);
    expect(result.summary).toContain('editorial');
  });

  it('extracts JSON from a fenced code block', () => {
    const fenced = '```json\n' + FULL_RESPONSE + '\n```';
    const result = parseCritiqueResponse(fenced);
    expect(result.scores).toHaveLength(5);
  });

  it('extracts JSON from surrounding chat text', () => {
    const noisy = 'Sure, here it is:\n' + FULL_RESPONSE + '\nlet me know if you need more.';
    const result = parseCritiqueResponse(noisy);
    expect(result.scores).toHaveLength(5);
  });

  it('clamps out-of-range scores to [1,5] and rounds', () => {
    const raw = JSON.stringify({
      scores: [
        { dimension: 'palette', score: 0, reason: 'too low' },
        { dimension: 'typography', score: 9.6, reason: 'too high' },
        { dimension: 'posture', score: '4', reason: 'string score' },
      ],
      summary: 'partial',
    });
    const result = parseCritiqueResponse(raw);
    const byDim = new Map(result.scores.map((s) => [s.dimension, s]));
    expect(byDim.get('palette')!.score).toBe(1);
    expect(byDim.get('typography')!.score).toBe(5);
    expect(byDim.get('posture')!.score).toBe(4);
  });

  it('fills missing dimensions with default 1 and a marker reason', () => {
    const raw = JSON.stringify({
      scores: [{ dimension: 'palette', score: 4, reason: 'ok' }],
      summary: 'partial',
    });
    const result = parseCritiqueResponse(raw);
    expect(result.scores).toHaveLength(5);
    const byDim = new Map(result.scores.map((s) => [s.dimension, s]));
    expect(byDim.get('typography')!.score).toBe(1);
    expect(byDim.get('typography')!.reason).toContain('默认 1');
  });

  it('throws CritiqueParseError on invalid JSON', () => {
    expect(() => parseCritiqueResponse('not json at all {{{')).toThrow(CritiqueParseError);
  });

  it('throws CritiqueParseError when no valid dimension is present', () => {
    const raw = JSON.stringify({ scores: [{ dimension: 'unknown', score: 3 }], summary: 'x' });
    expect(() => parseCritiqueResponse(raw)).toThrow(CritiqueParseError);
  });
});

describe('runCritique', () => {
  it('calls the injected caller with the built prompt and returns parsed result', async () => {
    const caller: CritiqueCaller = vi.fn().mockResolvedValue(FULL_RESPONSE);
    const input = makeInput();
    const result = await runCritique(input, { caller });
    expect(caller).toHaveBeenCalledOnce();
    const passedPrompt = (caller as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(passedPrompt).toContain(directionTokens.editorial.posture);
    expect(result.scores).toHaveLength(5);
    expect(result.overall).toBeGreaterThan(0);
    expect(result.raw).toBe(FULL_RESPONSE);
  });

  it('propagates caller errors', async () => {
    const caller: CritiqueCaller = vi.fn().mockRejectedValue(new Error('network'));
    await expect(runCritique(makeInput(), { caller })).rejects.toThrow('network');
  });
});
