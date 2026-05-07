#!/usr/bin/env npx tsx
/**
 * Deck acceptance baseline — Phase 4 PR-1.
 *
 * Validates the deterministic fixture under scripts/acceptance/fixtures/deck/
 * with the validators that are already on main:
 *   L1 schema:     slideSchemas.validateStructuredSlides
 *   Narrative:     narrativeValidator.validateNarrative (currently dead in pptGenerate.ts:584)
 *   L2 zip-level:  unzip -t / file count of ppt/slides/*.xml
 *   L3 unit-tests: spawn the legacy ppt mjs test files
 *
 * Two modes:
 *   default (--fixture):  read fixtures from disk; do not invoke any LLM.
 *   --live:               (PR-1.5) drive frontend-slides skill end-to-end.
 *                         Stubbed in PR-1; raises an error directing the caller to PR-1.5.
 *
 * Hard rules enforced (see docs/audits/2026-05-07-game-acceptance-architecture.md §7):
 *   - Baseline JSON is the ground truth for regression detection.
 *   - PR-2 / PR-3 must run with --compare; any regressed key fails the run.
 *   - Re-record (--record) only after explicitly approving fixture/baseline drift.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFlag, parseArgs, finishWithError, getStringOption } from './_helpers.ts';
import { validateStructuredSlides, type StructuredSlide } from '../../src/main/tools/media/ppt/slideSchemas.ts';
import { validateNarrative } from '../../src/main/tools/media/ppt/narrativeValidator.ts';
import type { SlideData } from '../../src/main/tools/media/ppt/types.ts';
import { DeckVerifier } from '../../src/main/agent/runtime/deck/DeckVerifier.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..', '..');
const fixtureDir = path.join(scriptDir, 'fixtures', 'deck');
const slidesJsonPath = path.join(fixtureDir, 'sample-slides.json');
const pptxPath = path.join(fixtureDir, 'sample-deck.pptx');
const baselinePath = path.join(fixtureDir, 'baseline.json');
const liveSlidesPath = path.join(fixtureDir, 'live-slides.json');
const liveBaselinePath = path.join(fixtureDir, 'live-baseline.json');

const PPT_MJS_FILES = [
  'src/main/tools/media/ppt/__tests__/ppt-d3d4.test.mjs',
  'src/main/tools/media/ppt/__tests__/ppt-schema.test.mjs',
  'src/main/tools/media/ppt/__tests__/ppt.test.mjs',
  'src/main/tools/media/ppt/__tests__/ppt-extended.test.mjs',
  'src/main/tools/media/ppt/__tests__/ppt-d1d2d5d6.test.mjs',
] as const;

// ---------------------------------------------------------------------------
// Output schema (record + compare both produce this shape)
// ---------------------------------------------------------------------------

interface ZipResult {
  parsable: boolean;
  slide_xml_count: number;
  presentation_xml_present: boolean;
  size_bytes: number;
}

interface SchemaResult {
  total: number;
  valid: number;
  errors: Array<{ index: number; errors: string[] }>;
}

interface NarrativeResult {
  total_slides: number;
  issue_count: number;
  issue_types: string[];
}

interface MjsTestResult {
  file: string;
  exit_code: number;
  summary_line: string | null;
  parsed_pass: number | null;
  parsed_fail: number | null;
}

interface BaselineDoc {
  recorded_at: string;
  git_head: string;
  fixture: { topic: string; slide_count: number };
  zip: ZipResult;
  schema: SchemaResult;
  narrative: NarrativeResult;
  mjs_tests: MjsTestResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFixture(): { topic: string; structured: StructuredSlide[]; legacy: SlideData[] } {
  const raw = fs.readFileSync(slidesJsonPath, 'utf8');
  return JSON.parse(raw);
}

function checkZipAt(targetPath: string): ZipResult {
  const stat = fs.statSync(targetPath);
  let parsable = false;
  let slideXmlCount = 0;
  let presPresent = false;
  try {
    execFileSync('unzip', ['-t', targetPath], { stdio: ['ignore', 'ignore', 'ignore'] });
    parsable = true;
    const listing = execFileSync('unzip', ['-l', targetPath], { encoding: 'utf8' });
    slideXmlCount = (listing.match(/ppt\/slides\/slide\d+\.xml\b/g) ?? []).length;
    presPresent = / ppt\/presentation\.xml\b/.test(listing);
  } catch {
    // parsable stays false
  }
  return {
    parsable,
    slide_xml_count: slideXmlCount,
    presentation_xml_present: presPresent,
    size_bytes: stat.size,
  };
}

function checkZip(): ZipResult {
  return checkZipAt(pptxPath);
}

function checkSchema(structured: StructuredSlide[]): SchemaResult {
  const result = validateStructuredSlides(structured);
  return {
    total: structured.length,
    valid: result.validSlides.length,
    errors: result.errors,
  };
}

function checkNarrative(legacy: SlideData[]): NarrativeResult {
  const issues = validateNarrative(legacy);
  return {
    total_slides: legacy.length,
    issue_count: issues.length,
    issue_types: issues.map((i) => i.type).sort(),
  };
}

function parseSummary(stdout: string): { pass: number | null; fail: number | null; line: string | null } {
  // Two known formats observed across the ppt mjs tests:
  //   "═══ Summary: 65 passed, 0 failed (65 total) ═══"
  //   "Z 项: X 通过, Y 失败"
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    const m1 = line.match(/Summary:\s*(\d+)\s+passed,\s*(\d+)\s+failed/);
    if (m1) return { pass: Number(m1[1]), fail: Number(m1[2]), line: line.trim() };
    const m2 = line.match(/(\d+)\s*项:\s*(\d+)\s*通过,\s*(\d+)\s*失败/);
    if (m2) return { pass: Number(m2[2]), fail: Number(m2[3]), line: line.trim() };
  }
  return { pass: null, fail: null, line: null };
}

function runMjs(file: string): MjsTestResult {
  const abs = path.join(projectRoot, file);
  const result = spawnSync('npx', ['tsx', abs], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const exitCode = result.status ?? 1;
  const stdout = result.stdout ?? '';
  const parsed = parseSummary(stdout);
  return {
    file,
    exit_code: exitCode,
    summary_line: parsed.line,
    parsed_pass: parsed.pass,
    parsed_fail: parsed.fail,
  };
}

function getGitHead(): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
    return out.trim();
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Compare: does `current` regress vs `baseline`?
// ---------------------------------------------------------------------------

function compare(baseline: BaselineDoc, current: BaselineDoc): string[] {
  const regressions: string[] = [];

  // zip
  if (baseline.zip.parsable && !current.zip.parsable) regressions.push('zip.parsable: pass → fail');
  if (current.zip.slide_xml_count < baseline.zip.slide_xml_count) {
    regressions.push(`zip.slide_xml_count: ${baseline.zip.slide_xml_count} → ${current.zip.slide_xml_count}`);
  }
  if (baseline.zip.presentation_xml_present && !current.zip.presentation_xml_present) {
    regressions.push('zip.presentation_xml_present: true → false');
  }

  // schema
  if (current.schema.valid < baseline.schema.valid) {
    regressions.push(`schema.valid: ${baseline.schema.valid} → ${current.schema.valid}`);
  }
  if (current.schema.errors.length > baseline.schema.errors.length) {
    regressions.push(`schema.errors: ${baseline.schema.errors.length} → ${current.schema.errors.length}`);
  }

  // narrative — drift either direction is regression (rules changed semantics)
  const baseTypes = baseline.narrative.issue_types.join(',');
  const curTypes = current.narrative.issue_types.join(',');
  if (baseTypes !== curTypes) {
    regressions.push(`narrative.issue_types: [${baseTypes}] → [${curTypes}]`);
  }

  // mjs tests — any file that was passing must keep passing
  const baselineByFile = new Map(baseline.mjs_tests.map((t) => [t.file, t]));
  for (const cur of current.mjs_tests) {
    const base = baselineByFile.get(cur.file);
    if (!base) continue;
    if (base.exit_code === 0 && cur.exit_code !== 0) {
      regressions.push(`mjs_tests[${cur.file}]: exit 0 → ${cur.exit_code}`);
    }
    if (base.parsed_pass !== null && cur.parsed_pass !== null && cur.parsed_pass < base.parsed_pass) {
      regressions.push(`mjs_tests[${cur.file}].pass: ${base.parsed_pass} → ${cur.parsed_pass}`);
    }
  }

  return regressions;
}

// ---------------------------------------------------------------------------
// Live mode — verify external frontend-slides products via DeckVerifier
// ---------------------------------------------------------------------------

/**
 * frontend-slides slides.json schema:
 *   [{ index, layout, title, subtitle?, bullets?, footnote? }]
 * (matches .claude/skills/frontend-slides/SKILL.md §3 + scripts/merge-to-pptx-hybrid.mjs)
 */
interface FrontendSlide {
  index: number;
  layout: string;          // 'cover' / 'content' / others — only 'cover' is structurally distinct
  title: string;
  subtitle?: string;
  bullets?: string[];
  footnote?: string;
}

/**
 * Normalize frontend-slides slides.json to DeckArtifactInput shape.
 * - cover-layout (or index===1) → isTitle=true (skips schema content checks)
 * - last slide title looks like end ("谢谢" / "Q&A" / "thank you" / "致谢") → isEnd=true
 * - everything else → list-layout content slide with bullets as points
 *
 * The aim is structural parity with what PR-1's sample-slides.json fixture provides,
 * so DeckVerifier behaves consistently across fixture and live modes.
 */
const END_TITLE_RE = /^(谢谢|致谢|q\s*&\s*a|thank\s*you|结束)/i;

function normalizeFrontendSlides(slides: readonly FrontendSlide[]): {
  structured: StructuredSlide[];
  legacy: SlideData[];
} {
  const total = slides.length;
  const structured: StructuredSlide[] = [];
  const legacy: SlideData[] = [];

  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const bullets = s.bullets ?? [];
    const isCover = s.layout === 'cover' || s.index === 1;
    const isEndCandidate = i === total - 1 && END_TITLE_RE.test(s.title);

    structured.push({
      layout: 'list',
      title: s.title,
      subtitle: s.subtitle && s.subtitle.length > 0 ? s.subtitle : undefined,
      isTitle: isCover ? true : undefined,
      isEnd: isEndCandidate ? true : undefined,
      content: { points: bullets },
    });

    legacy.push({
      title: s.title,
      subtitle: s.subtitle && s.subtitle.length > 0 ? s.subtitle : undefined,
      points: bullets,
      isTitle: isCover,
      isEnd: isEndCandidate,
    });
  }

  return { structured, legacy };
}

interface VerifierResult {
  passed: boolean;
  subtype: string;
  failed_probes: string[];
  failures: string[];
}

interface LiveBaselineDoc {
  recorded_at: string;
  git_head: string;
  source: { slides_path: string; pptx_path: string | null };
  fixture: { slide_count: number };
  zip: ZipResult | null;
  schema: SchemaResult;
  narrative: NarrativeResult;
  verifier: VerifierResult;
}

function runDeckVerifier(structured: StructuredSlide[], legacy: SlideData[], topic?: string): VerifierResult {
  const verifier = new DeckVerifier();
  const result = verifier.validate({ structured, legacy, metadata: topic ? { topic } : {} });
  return {
    passed: result.passed,
    subtype: result.subtype,
    failed_probes: result.probes.filter((p) => !p.passed).map((p) => p.probe),
    failures: [...result.failures],
  };
}

function compareLive(baseline: LiveBaselineDoc, current: LiveBaselineDoc): string[] {
  const regressions: string[] = [];

  // schema
  if (current.schema.valid < baseline.schema.valid) {
    regressions.push(`schema.valid: ${baseline.schema.valid} → ${current.schema.valid}`);
  }

  // narrative — drift either direction is regression
  const baseTypes = baseline.narrative.issue_types.join(',');
  const curTypes = current.narrative.issue_types.join(',');
  if (baseTypes !== curTypes) {
    regressions.push(`narrative.issue_types: [${baseTypes}] → [${curTypes}]`);
  }

  // verifier verdict
  if (baseline.verifier.passed && !current.verifier.passed) {
    regressions.push('verifier.passed: true → false');
  }
  const baseProbes = [...baseline.verifier.failed_probes].sort().join(',');
  const curProbes = [...current.verifier.failed_probes].sort().join(',');
  if (baseProbes !== curProbes) {
    regressions.push(`verifier.failed_probes: [${baseProbes}] → [${curProbes}]`);
  }

  // zip — only compare when baseline has zip data; current zip may be null if user
  // didn't supply --pptx, in which case we skip rather than treating as regression.
  if (baseline.zip && current.zip) {
    if (baseline.zip.parsable && !current.zip.parsable) regressions.push('zip.parsable: pass → fail');
    if (current.zip.slide_xml_count < baseline.zip.slide_xml_count) {
      regressions.push(`zip.slide_xml_count: ${baseline.zip.slide_xml_count} → ${current.zip.slide_xml_count}`);
    }
  }

  return regressions;
}

async function runLiveMode(args: ReturnType<typeof parseArgs>): Promise<void> {
  const wantRecord = hasFlag(args, 'record');
  const wantJson = hasFlag(args, 'json');
  const slidesOverride = getStringOption(args, 'slides');
  const pptxOverride = getStringOption(args, 'pptx');
  const baselineOverride = getStringOption(args, 'baseline');
  const baselineFile = baselineOverride ? path.resolve(baselineOverride) : liveBaselinePath;

  const slidesSourcePath = slidesOverride ? path.resolve(slidesOverride) : liveSlidesPath;

  if (!fs.existsSync(slidesSourcePath)) {
    finishWithError(
      `Missing live slides JSON: ${slidesSourcePath}\n` +
        `  Pass --slides <path> to verify an external frontend-slides product, or commit a snapshot to ${liveSlidesPath}.`,
    );
  }

  const raw = fs.readFileSync(slidesSourcePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    finishWithError(`Invalid JSON in ${slidesSourcePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    finishWithError(`${slidesSourcePath} must be an array of frontend-slides objects.`);
  }

  const slides = parsed as FrontendSlide[];
  const { structured, legacy } = normalizeFrontendSlides(slides);
  const schema = checkSchema(structured);
  const narrative = checkNarrative(legacy);
  const verifier = runDeckVerifier(structured, legacy);

  const pptxResolved = pptxOverride ? path.resolve(pptxOverride) : null;
  const zip = pptxResolved
    ? fs.existsSync(pptxResolved)
      ? checkZipAt(pptxResolved)
      : (() => {
          finishWithError(`--pptx points to missing file: ${pptxResolved}`);
        })()
    : null;

  const current: LiveBaselineDoc = {
    recorded_at: new Date().toISOString(),
    git_head: getGitHead(),
    source: {
      slides_path: path.relative(projectRoot, slidesSourcePath),
      pptx_path: pptxResolved ? path.relative(projectRoot, pptxResolved) : null,
    },
    fixture: { slide_count: structured.length },
    zip,
    schema,
    narrative,
    verifier,
  };

  if (wantRecord) {
    // Record path: copy slides.json to live-slides.json (if external) and write baseline.
    if (slidesOverride) {
      fs.copyFileSync(slidesSourcePath, liveSlidesPath);
    }
    fs.writeFileSync(baselineFile, JSON.stringify(current, null, 2) + '\n', 'utf8');
    if (wantJson) {
      console.log(JSON.stringify({ recorded: baselineFile, doc: current }, null, 2));
    } else {
      console.log(`✓ recorded live baseline → ${path.relative(projectRoot, baselineFile)}`);
      if (slidesOverride) {
        console.log(`  also copied slides → ${path.relative(projectRoot, liveSlidesPath)}`);
      }
      console.log(`  schema.valid=${schema.valid}/${schema.total} errors=${schema.errors.length}`);
      console.log(`  narrative.issues=${narrative.issue_count} types=[${narrative.issue_types.join(',')}]`);
      console.log(`  verifier.passed=${verifier.passed} failed_probes=[${verifier.failed_probes.join(',')}]`);
      if (zip) console.log(`  zip.parsable=${zip.parsable} slide_xml=${zip.slide_xml_count}`);
    }
    return;
  }

  if (!fs.existsSync(baselineFile)) {
    finishWithError(`Missing live baseline at ${baselineFile}. Run with --live --record to create one.`);
  }

  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as LiveBaselineDoc;
  const regressions = compareLive(baseline, current);

  if (wantJson) {
    console.log(JSON.stringify({ baseline_git_head: baseline.git_head, current, regressions }, null, 2));
  } else {
    console.log(`Live baseline recorded at ${baseline.recorded_at} (git ${baseline.git_head})`);
    console.log(`Current   git ${current.git_head}`);
    console.log('');
    if (regressions.length === 0) {
      console.log('✓ no live regressions vs baseline');
      console.log(`  schema.valid=${schema.valid}/${schema.total}`);
      console.log(`  narrative.issues=${narrative.issue_count} types=[${narrative.issue_types.join(',')}]`);
      console.log(`  verifier.passed=${verifier.passed} failed_probes=[${verifier.failed_probes.join(',')}]`);
      if (zip) console.log(`  zip.parsable=${zip.parsable} slide_xml=${zip.slide_xml_count}`);
    } else {
      console.log('✗ live regressions detected:');
      for (const r of regressions) console.log(`  - ${r}`);
    }
  }

  process.exit(regressions.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function usage(): void {
  console.log(`Deck acceptance baseline (Phase 4 PR-1 + PR-1.5)

Usage:
  Fixture mode (default):
    npm run acceptance:deck                       compare current fixture run to baseline.json
    npm run acceptance:deck -- --record           record a fresh baseline.json
    npm run acceptance:deck -- --json             JSON-only output

  Live mode (verify external frontend-slides products via DeckVerifier):
    npm run acceptance:deck -- --live                                    use cached live-slides.json
    npm run acceptance:deck -- --live --slides <path>                    use external slides.json
    npm run acceptance:deck -- --live --slides <path> --pptx <path>      also run zip integrity
    npm run acceptance:deck -- --live --record                           record live-baseline.json
    npm run acceptance:deck -- --live --slides <path> --record           also copy to live-slides.json

What fixture mode checks:
  L1 schema      validateStructuredSlides on sample-slides.json[structured]
  Narrative      validateNarrative on sample-slides.json[legacy]
  L2 zip-level   unzip -t + slide xml count on sample-deck.pptx
  L3 unit-tests  the 5 ppt mjs test files; exit code + parsed pass/fail

What live mode checks:
  Source         frontend-slides slides.json (cached or external)
  Normalize      cover/index===1 → isTitle; ending-keyword last slide → isEnd; bullets → points
  Schema         on normalized StructuredSlide[]
  Narrative      on normalized SlideData[]
  Verifier       DeckVerifier.validate verdict + failed-probe set
  Zip (optional) only when --pptx supplied

Live mode does NOT call any LLM — it only verifies products you provide.
For end-to-end LLM verification, run frontend-slides skill manually,
then point --slides / --pptx at the product directory.

Output baseline keys (any regression fails):
  Fixture: zip.{parsable, slide_xml_count, presentation_xml_present}
           schema.{valid, errors[]}
           narrative.{issue_types}
           mjs_tests[].{exit_code, parsed_pass}
  Live:    schema.{valid}
           narrative.{issue_types}
           verifier.{passed, failed_probes}
           zip.* (when --pptx supplied)
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  if (hasFlag(args, 'live')) {
    await runLiveMode(args);
    return;
  }

  const wantRecord = hasFlag(args, 'record');
  const wantJson = hasFlag(args, 'json');
  const baselineOverride = getStringOption(args, 'baseline');
  const baselineFile = baselineOverride ? path.resolve(baselineOverride) : baselinePath;

  if (!fs.existsSync(slidesJsonPath)) finishWithError(`Missing fixture JSON: ${slidesJsonPath}`);
  if (!fs.existsSync(pptxPath)) {
    finishWithError(
      `Missing fixture pptx: ${pptxPath}\n  Run: npm run acceptance:deck:rebuild-fixture`,
    );
  }

  const fixture = readFixture();
  const zip = checkZip();
  const schema = checkSchema(fixture.structured);
  const narrative = checkNarrative(fixture.legacy);

  if (!wantJson) {
    console.log('Running ppt mjs tests (this can take ~30-60s) ...');
  }
  const mjs = PPT_MJS_FILES.map((f) => runMjs(f));

  const current: BaselineDoc = {
    recorded_at: new Date().toISOString(),
    git_head: getGitHead(),
    fixture: { topic: fixture.topic, slide_count: fixture.structured.length },
    zip,
    schema,
    narrative,
    mjs_tests: mjs,
  };

  if (wantRecord) {
    fs.writeFileSync(baselineFile, JSON.stringify(current, null, 2) + '\n', 'utf8');
    if (wantJson) {
      console.log(JSON.stringify({ recorded: baselineFile, doc: current }, null, 2));
    } else {
      console.log(`✓ recorded baseline → ${path.relative(projectRoot, baselineFile)}`);
      console.log(`  zip.parsable=${zip.parsable} slide_xml=${zip.slide_xml_count}`);
      console.log(`  schema.valid=${schema.valid}/${schema.total} errors=${schema.errors.length}`);
      console.log(`  narrative.issues=${narrative.issue_count} types=[${narrative.issue_types.join(',')}]`);
      for (const t of mjs) {
        const tag = t.exit_code === 0 ? 'PASS' : 'FAIL';
        const detail = t.parsed_pass !== null ? `${t.parsed_pass}p/${t.parsed_fail}f` : `exit=${t.exit_code}`;
        console.log(`  mjs ${tag}  ${t.file}  ${detail}`);
      }
    }
    return;
  }

  if (!fs.existsSync(baselineFile)) {
    finishWithError(
      `Missing baseline.json at ${baselineFile}. Run with --record to create one.`,
    );
  }

  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as BaselineDoc;
  const regressions = compare(baseline, current);

  if (wantJson) {
    console.log(
      JSON.stringify({ baseline_git_head: baseline.git_head, current, regressions }, null, 2),
    );
  } else {
    console.log(`Baseline recorded at ${baseline.recorded_at} (git ${baseline.git_head})`);
    console.log(`Current   git ${current.git_head}`);
    console.log('');
    if (regressions.length === 0) {
      console.log('✓ no regressions vs baseline');
      for (const t of current.mjs_tests) {
        const tag = t.exit_code === 0 ? 'PASS' : 'FAIL';
        const detail = t.parsed_pass !== null ? `${t.parsed_pass}p/${t.parsed_fail}f` : `exit=${t.exit_code}`;
        console.log(`  mjs ${tag}  ${t.file}  ${detail}`);
      }
    } else {
      console.log('✗ regressions detected:');
      for (const r of regressions) console.log(`  - ${r}`);
    }
  }

  process.exit(regressions.length === 0 ? 0 : 1);
}

main().catch(finishWithError);
