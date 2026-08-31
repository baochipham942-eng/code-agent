import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('playwright-core/lib/utilsBundle');

export function parseRepeatedArgs(argv) {
  const result = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result.positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key.startsWith('no-')) {
      result[key.slice(3)] = false;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    index += 1;
    if (result[key] === undefined) result[key] = next;
    else if (Array.isArray(result[key])) result[key].push(next);
    else result[key] = [result[key], next];
  }
  return result;
}

export function asStringList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

export function isMaskPixel(data, offset) {
  return data[offset] === 255 && data[offset + 1] === 0 && data[offset + 2] === 255;
}

function dimensionsEqual(before, after) {
  return before.width === after.width && before.height === after.height;
}

export function createPixelDiff(beforeBuffer, afterBuffer) {
  const before = PNG.sync.read(beforeBuffer);
  const after = PNG.sync.read(afterBuffer);
  if (!dimensionsEqual(before, after)) {
    throw new Error(
      `Screenshot dimensions differ: before=${before.width}x${before.height}, after=${after.width}x${after.height}`,
    );
  }

  const output = new PNG({ width: before.width, height: before.height });
  let changedPixels = 0;
  let maskedPixels = 0;
  let scoredPixels = 0;

  for (let offset = 0; offset < before.data.length; offset += 4) {
    const masked = isMaskPixel(before.data, offset) || isMaskPixel(after.data, offset);
    if (masked) {
      maskedPixels += 1;
      output.data[offset] = 255;
      output.data[offset + 1] = 0;
      output.data[offset + 2] = 255;
      output.data[offset + 3] = 72;
      continue;
    }

    scoredPixels += 1;
    const changed = before.data[offset] !== after.data[offset]
      || before.data[offset + 1] !== after.data[offset + 1]
      || before.data[offset + 2] !== after.data[offset + 2]
      || before.data[offset + 3] !== after.data[offset + 3];

    if (changed) {
      changedPixels += 1;
      output.data[offset] = 255;
      output.data[offset + 1] = 32;
      output.data[offset + 2] = 32;
      output.data[offset + 3] = 255;
    } else {
      const gray = Math.round(
        after.data[offset] * 0.299
        + after.data[offset + 1] * 0.587
        + after.data[offset + 2] * 0.114,
      );
      output.data[offset] = gray;
      output.data[offset + 1] = gray;
      output.data[offset + 2] = gray;
      output.data[offset + 3] = 80;
    }
  }

  return {
    buffer: PNG.sync.write(output),
    width: before.width,
    height: before.height,
    changedPixels,
    maskedPixels,
    scoredPixels,
    changedRatio: scoredPixels === 0 ? 0 : changedPixels / scoredPixels,
  };
}

export async function readRubric(rubricPath) {
  const rubric = JSON.parse(await fs.readFile(rubricPath, 'utf8'));
  if (!Array.isArray(rubric.items) || rubric.items.length === 0) {
    throw new Error(`Rubric has no items: ${rubricPath}`);
  }
  return rubric;
}

export function appendRubricToPrompt(template, rubric, mode) {
  const lines = rubric.items.map((item) => (
    `- ${item.id} ${item.name}: ${item.criterion}`
  ));
  return [
    template.trim(),
    '',
    `本次模式：${mode}`,
    mode === 'triptych'
      ? '图片顺序固定为 before、after、diff。'
      : '本次只有一张图，严格按单图证据判断。',
    '',
    '固定 rubric：',
    ...lines,
    '',
    `必须输出 ${rubric.items.length} 条 items，顺序与 rubric 一致。`,
  ].join('\n');
}

export function validateReviewDraft(draft, rubric, mode) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('VLM output is not a JSON object');
  }
  if (draft.draftOnly !== true) throw new Error('draftOnly must be true');
  if (draft.mode !== mode) throw new Error(`mode must be ${mode}`);
  if (!Array.isArray(draft.items) || draft.items.length !== rubric.items.length) {
    throw new Error(`Expected ${rubric.items.length} rubric results`);
  }
  const expectedIds = rubric.items.map((item) => item.id);
  const receivedIds = draft.items.map((item) => item.rubricId);
  if (JSON.stringify(expectedIds) !== JSON.stringify(receivedIds)) {
    throw new Error(`Rubric IDs/order mismatch: ${receivedIds.join(', ')}`);
  }
  const allowed = new Set(['PASS', 'RED', 'NA']);
  for (const item of draft.items) {
    if (!allowed.has(item.status)) throw new Error(`Invalid status for ${item.rubricId}`);
    if (typeof item.reason !== 'string' || !item.reason.trim()) {
      throw new Error(`Missing reason for ${item.rubricId}`);
    }
    if (typeof item.region !== 'string' || !item.region.trim()) {
      throw new Error(`Missing region for ${item.rubricId}`);
    }
  }
  const hasRed = draft.items.some((item) => item.status === 'RED');
  if (draft.recommendHumanOpen !== hasRed) {
    throw new Error('recommendHumanOpen must match whether any item is RED');
  }
  return draft;
}

export async function listPngFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}
