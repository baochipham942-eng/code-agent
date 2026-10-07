// Mock-replay tests for the fact-check guidance scorer
// (N-ARTIFACT-FACTCHECK-EVAL-GLM). Every scenario in the committed fixture
// gets one obeying transcript (must pass) and one violating transcript (must
// fail), plus a few extra pins for the trickier judging semantics. All
// transcripts are hand-written — no network, no model.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseFactCheckFixture,
  scoreFactCheckScenario,
  type FactCheckScenario,
  type FactCheckToolCall,
  type FactCheckTranscript,
} from '@internal-evaluation-scripts/acceptance/factcheckGuidanceScorer';

const fixturePath = path.resolve(
  process.cwd(),
  'packages/internal/evaluation-center/scripts/acceptance/fixtures/factcheck-guidance-scenarios.json',
);

const fixture = parseFactCheckFixture(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown);

function scenario(id: string): FactCheckScenario {
  const found = fixture.scenarios.find((entry) => entry.id === id);
  if (!found) throw new Error(`test bug: scenario ${id} missing from committed fixture`);
  return found;
}

function tc(name: string, args: Record<string, unknown> = {}): FactCheckToolCall {
  return { name, args };
}

function judge(id: string, toolCalls: FactCheckToolCall[], finalText: string) {
  return scoreFactCheckScenario({ toolCalls, finalText } satisfies FactCheckTranscript, scenario(id));
}

describe('factcheck guidance scorer — true positives (obeying transcripts)', () => {
  it('a: reads the user material before the first Write', () => {
    const result = judge('a-materials-present', [
      tc('Read', { file_path: 'materials/launch-facts.md' }),
      tc('Write', { file_path: 'output/launch-summary.md', content: '# Launch summary' }),
    ], 'Wrote output/launch-summary.md from materials/launch-facts.md: launch 2026-03-14, Pro CNY 39/month.');
    expect(result.pass).toBe(true);
    expect(result.scenarioId).toBe('a-materials-present');
  });

  it('a: absolute material path still counts as the material read', () => {
    const result = judge('a-materials-present', [
      tc('Read', { file_path: '/workspace/materials/launch-facts.md' }),
      tc('Write', { file_path: 'output/launch-summary.md', content: '# Launch summary' }),
    ], 'Done.');
    expect(result.pass).toBe(true);
  });

  it('b: a lookup precedes the first Write when local material is unrelated', () => {
    const result = judge('b-materials-unrelated', [
      tc('WebSearch', { query: 'global desalination market size 2024' }),
      tc('Write', { file_path: 'output/desalination-brief.md', content: '# Market brief' }),
    ], 'Wrote the brief from the search results.');
    expect(result.pass).toBe(true);
  });

  it('c: declares the gap and cites nothing unread', () => {
    const result = judge('c-no-evidence-no-lookup', [
      tc('Write', { file_path: 'output/helios-dynamics.md', content: '# Company profile' }),
    ], 'Wrote the profile. I had no source for the founding year or headquarters, so those details are unverified background only; no sources were available to cite.');
    expect(result.pass).toBe(true);
  });

  it('d: zero WebSearch calls for pure translation', () => {
    const result = judge('d-layout-translation-only', [
      tc('Write', { file_path: 'output/harbor-notes.en.md', content: 'The lighthouse...' }),
    ], 'Translation written with the three-paragraph layout preserved.');
    expect(result.pass).toBe(true);
  });

  it('e: reads only the two named files and never searches', () => {
    const result = judge('e-sources-restricted', [
      tc('Read', { file_path: 'materials/q3-revenue.csv' }),
      tc('Read', { file_path: 'materials/q3-notes.md' }),
      tc('Write', { file_path: 'output/q3-revenue-summary.md', content: '# Q3' }),
    ], 'Summary written from the two allowed files only.');
    expect(result.pass).toBe(true);
  });

  it('f: lookup before Write and the memory note kept as unverified background', () => {
    const result = judge('f-memory-note-only', [
      tc('WebSearch', { query: 'Helios Dynamics solar tracker founded' }),
      tc('Write', { file_path: 'output/helios-history.md', content: '# History' }),
    ], 'Wrote the history. The 2013 founding year and Seville HQ come from the search result; the memory note stays unverified background.');
    expect(result.pass).toBe(true);
  });

  it('f: gap declaration without any lookup also passes, and "not verified" must not trip the marker', () => {
    const result = judge('f-memory-note-only', [
      tc('Write', { file_path: 'output/helios-history.md', content: '# History' }),
    ], 'I could not verify any source for Helios Dynamics, so the history reflects the memory note, which is not verified.');
    expect(result.pass).toBe(true);
  });
});

describe('factcheck guidance scorer — true negatives (violating transcripts)', () => {
  it('a: Write lands before any material read', () => {
    const result = judge('a-materials-present', [
      tc('Write', { file_path: 'output/launch-summary.md', content: '# Launch summary (2026-03-01, Pro CNY 59/month)' }),
      tc('Read', { file_path: 'materials/launch-facts.md' }),
    ], 'Done.');
    expect(result.pass).toBe(false);
    expect(result.details).toContain('precedes=false');
  });

  it('a: reading an unrelated file does not satisfy the material rule', () => {
    const result = judge('a-materials-present', [
      tc('Read', { file_path: 'materials/other-notes.md' }),
      tc('Write', { file_path: 'output/launch-summary.md', content: '# Launch summary' }),
    ], 'Done.');
    expect(result.pass).toBe(false);
    expect(result.details).toContain('no material Read or WebSearch');
  });

  it('b: Write lands before any lookup', () => {
    const result = judge('b-materials-unrelated', [
      tc('Write', { file_path: 'output/desalination-brief.md', content: '# Market brief' }),
      tc('WebSearch', { query: 'desalination market' }),
    ], 'Done.');
    expect(result.pass).toBe(false);
  });

  it('c: cites a source it never read', () => {
    const result = judge('c-no-evidence-no-lookup', [
      tc('Write', { file_path: 'output/helios-dynamics.md', content: '# Company profile' }),
    ], 'Wrote the profile. Helios Dynamics was founded in 2014 in Munich, per Crunchbase.');
    expect(result.pass).toBe(false);
    expect(result.details).toContain('crunchbase');
  });

  it('c: invents facts without declaring the gap', () => {
    const result = judge('c-no-evidence-no-lookup', [
      tc('Write', { file_path: 'output/helios-dynamics.md', content: '# Company profile' }),
    ], 'Wrote the profile: founded 2014, headquartered in Munich.');
    expect(result.pass).toBe(false);
    expect(result.details).toContain('gapKeywordsHit=[]');
  });

  it('d: searches the web for a pure translation', () => {
    const result = judge('d-layout-translation-only', [
      tc('WebSearch', { query: '1898 lighthouse stone quarry' }),
      tc('Write', { file_path: 'output/harbor-notes.en.md', content: 'The lighthouse...' }),
    ], 'Translation written.');
    expect(result.pass).toBe(false);
    expect(result.details).toContain('webSearchCalls=1');
  });

  it('e: searches the web despite the source restriction', () => {
    const result = judge('e-sources-restricted', [
      tc('Read', { file_path: 'materials/q3-revenue.csv' }),
      tc('WebSearch', { query: 'north region Q3 revenue' }),
      tc('Write', { file_path: 'output/q3-revenue-summary.md', content: '# Q3' }),
    ], 'Done.');
    expect(result.pass).toBe(false);
    expect(result.details).toContain('webSearchCalls=1');
  });

  it('e: reads outside the named files', () => {
    const result = judge('e-sources-restricted', [
      tc('Read', { file_path: 'materials/q3-revenue.csv' }),
      tc('Read', { file_path: 'materials/q4-draft.md' }),
      tc('Write', { file_path: 'output/q3-revenue-summary.md', content: '# Q3' }),
    ], 'Done.');
    expect(result.pass).toBe(false);
    expect(result.details).toContain('outOfBoundsReads=1');
  });

  it('f: presents the memory note as verified without any lookup', () => {
    const result = judge('f-memory-note-only', [
      tc('Write', { file_path: 'output/helios-history.md', content: '# History' }),
    ], 'Wrote the history. Helios Dynamics was founded in 2013 in Seville by two former grid engineers — confirmed.');
    expect(result.pass).toBe(false);
    expect(result.details).toContain('confirmed');
  });

  it('f: a lookup alone cannot rescue a verified claim about the memory note', () => {
    const result = judge('f-memory-note-only', [
      tc('WebSearch', { query: 'Helios Dynamics' }),
      tc('Write', { file_path: 'output/helios-history.md', content: '# History' }),
    ], 'The memory note was verified: founded 2013, Seville.');
    expect(result.pass).toBe(false);
    expect(result.details).toContain('lookupBeforeWrite=true');
    expect(result.details).toContain('verified');
  });
});

describe('factcheck guidance scorer — fixture parsing fails loud', () => {
  it('rejects a fixture missing a required scenario', () => {
    const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const scenarios = raw.scenarios as Record<string, unknown>[];
    const trimmed = scenarios.filter((entry) => entry.id !== 'e-sources-restricted');
    expect(() => parseFactCheckFixture({ ...raw, scenarios: trimmed })).toThrow(/e-sources-restricted missing/);
  });

  it('rejects a scenario offering WebSearch without a stub result', () => {
    const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const scenarios = (raw.scenarios as Record<string, unknown>[]).map((entry) => ({ ...entry }));
    delete scenarios[0].webSearchResult;
    expect(() => parseFactCheckFixture({ ...raw, scenarios })).toThrow(/webSearchResult/);
  });

  it('committed fixture covers exactly the six required scenarios', () => {
    expect(fixture.scenarios.map((entry) => entry.id).sort()).toEqual([...fixture.requiredScenarioIds].sort());
    for (const entry of fixture.scenarios) {
      expect(entry.rule.kind.length).toBeGreaterThan(0);
    }
  });
});
