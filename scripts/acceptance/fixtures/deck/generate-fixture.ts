#!/usr/bin/env npx tsx
/**
 * Deterministic .pptx fixture generator for PR-1 deck acceptance baseline.
 *
 * Reads sample-slides.json `structured` array and renders a minimal pptx via
 * pptxgenjs (writer-only — we don't aim for visual quality, only for a real
 * zip-valid .pptx the L2 checks can chew on).
 *
 * Run:
 *   npm run acceptance:deck:rebuild-fixture
 *
 * Re-run only if you intentionally edit sample-slides.json. Re-recording the
 * fixture also requires re-recording baseline.json afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireCjs = createRequire(import.meta.url);
const PptxGenJS = requireCjs('pptxgenjs');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const slidesPath = path.join(scriptDir, 'sample-slides.json');
const outputPath = path.join(scriptDir, 'sample-deck.pptx');

interface StatsItem { label: string; value: string; description?: string }
interface TimelineItem { title: string; description: string }
interface SlideJson {
  layout: string;
  title: string;
  subtitle?: string;
  isTitle?: boolean;
  isEnd?: boolean;
  content: {
    points?: string[];
    stats?: StatsItem[];
    steps?: TimelineItem[];
  };
}

interface FixtureRoot {
  topic: string;
  structured: SlideJson[];
}

function renderSlideBody(slide: SlideJson): string[] {
  if (slide.content.points) return slide.content.points;
  if (slide.content.stats) {
    return slide.content.stats.map((s) =>
      s.description ? `${s.label}：${s.value}（${s.description}）` : `${s.label}：${s.value}`,
    );
  }
  if (slide.content.steps) {
    return slide.content.steps.map((s) => `${s.title} — ${s.description}`);
  }
  return [];
}

async function main(): Promise<void> {
  const raw = fs.readFileSync(slidesPath, 'utf8');
  const fixture = JSON.parse(raw) as FixtureRoot;

  const pres = new PptxGenJS();
  pres.title = fixture.topic;
  pres.layout = 'LAYOUT_16x9';

  for (const slide of fixture.structured) {
    const page = pres.addSlide();

    page.addText(slide.title, {
      x: 0.5,
      y: 0.4,
      w: 9,
      h: 0.8,
      fontSize: slide.isTitle ? 32 : 24,
      bold: true,
    });

    if (slide.subtitle) {
      page.addText(slide.subtitle, {
        x: 0.5,
        y: 1.3,
        w: 9,
        h: 0.5,
        fontSize: 16,
        italic: true,
      });
    }

    const body = renderSlideBody(slide);
    if (body.length > 0) {
      page.addText(
        body.map((line) => ({ text: line, options: { bullet: true } })),
        { x: 0.5, y: 2.0, w: 9, h: 4.5, fontSize: 14 },
      );
    }
  }

  await pres.writeFile({ fileName: outputPath });

  const stat = fs.statSync(outputPath);
  console.log(`✓ wrote ${path.relative(process.cwd(), outputPath)} (${stat.size} bytes, ${fixture.structured.length} slides)`);
}

main().catch((err) => {
  console.error('fixture generation failed:', err);
  process.exit(1);
});
