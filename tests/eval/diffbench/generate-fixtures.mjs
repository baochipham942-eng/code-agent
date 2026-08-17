import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, 'fixtures');
const realisticCommit = '415fb045e797238d5e06ddc531a489c9004c0403';
const pureAddCommit = '7e1a30788f2aef3186be088c0a156d387c5835ee';

function gitShow(commit) {
  return execFileSync('git', [
    'show',
    '--format=',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    '--unified=3',
    commit,
  ], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parsePatch(patch) {
  const events = [];
  let file = 'unknown';
  let hunk = 0;

  for (const rawLine of patch.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      const match = rawLine.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = match?.[2] ?? rawLine.slice('diff --git '.length);
      hunk = 0;
      continue;
    }
    if (rawLine.startsWith('@@ ')) {
      hunk += 1;
      events.push({
        kind: 'context',
        line: `/* diffbench source: ${file} hunk ${hunk} */`,
        file,
      });
      continue;
    }
    if (rawLine.startsWith('+++ ') || rawLine.startsWith('--- ')) continue;
    if (rawLine.startsWith('\\ No newline at end of file')) continue;
    if (rawLine.startsWith('+')) {
      events.push({ kind: 'added', line: rawLine.slice(1), file });
    } else if (rawLine.startsWith('-')) {
      events.push({ kind: 'removed', line: rawLine.slice(1), file });
    } else if (rawLine.startsWith(' ')) {
      events.push({ kind: 'context', line: rawLine.slice(1), file });
    }
  }
  return events;
}

function buildRealisticFixture(events, targetRows) {
  const oldLines = [];
  const newLines = [];
  const sourceFiles = new Set();
  const counts = { context: 0, added: 0, removed: 0 };

  for (const event of events.slice(0, targetRows)) {
    sourceFiles.add(event.file);
    counts[event.kind] += 1;
    if (event.kind !== 'added') oldLines.push(event.line);
    if (event.kind !== 'removed') newLines.push(event.line);
  }

  return {
    id: `history-${targetRows}`,
    label: `${targetRows} 行历史真实改动`,
    kind: 'history-realistic',
    oldText: oldLines.join('\n'),
    newText: newLines.join('\n'),
    provenance: {
      commit: realisticCommit,
      extraction: 'git show --unified=3 的 hunk 内容按出现顺序裁切；hunk 间插入双方共有的来源哨兵，防止跨文件误配。',
      targetUnifiedRows: targetRows,
      extractedRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
      oldLines: oldLines.length,
      newLines: newLines.length,
      counts,
      sourceFiles: [...sourceFiles],
    },
  };
}

function findChangedSamples(events) {
  const removed = events.find((event) => event.kind === 'removed' && event.line.length >= 40)?.line;
  const added = events.find((event) => event.kind === 'added' && event.line.length >= 40)?.line;
  if (!removed || !added) throw new Error('Unable to find long enough historical changed lines');
  return { removed, added };
}

function expandLine(source, length) {
  const parts = [];
  while (parts.join(' | ').length < length) parts.push(source);
  return parts.join(' | ');
}

function buildLongLineFixture(events) {
  const samples = findChangedSamples(events);
  const oldText = expandLine(samples.removed, 2_400);
  const newText = expandLine(samples.added, 2_400);
  return {
    id: 'long-line-2400',
    label: '超长单行（>2000 字符）',
    kind: 'boundary-long-line',
    oldText,
    newText,
    provenance: {
      commit: realisticCommit,
      extraction: '取该历史提交真实删除行与新增行，重复扩展到边界长度。',
      oldCharacters: oldText.length,
      newCharacters: newText.length,
      minimumRequiredCharacters: 2_000,
    },
  };
}

function buildPureAdditionFixture(events, lineCount) {
  const additions = events
    .filter((event) => event.kind === 'added')
    .slice(0, lineCount);
  if (additions.length !== lineCount) {
    throw new Error(`Pure-add source only yielded ${additions.length}/${lineCount} lines`);
  }
  const sourceFiles = [...new Set(additions.map((event) => event.file))];
  return {
    id: `pure-add-${lineCount}`,
    label: `纯新增文件（${lineCount} 行）`,
    kind: 'boundary-pure-addition',
    oldText: '',
    newText: additions.map((event) => event.line).join('\n'),
    provenance: {
      commit: pureAddCommit,
      extraction: '从历史大提交的真实新增行按出现顺序提取，旧文件为空。',
      newLines: lineCount,
      sourceFiles,
    },
  };
}

mkdirSync(fixtureDir, { recursive: true });
const realisticEvents = parsePatch(gitShow(realisticCommit));
const pureAddEvents = parsePatch(gitShow(pureAddCommit));
const fixtures = [
  buildRealisticFixture(realisticEvents, 500),
  buildRealisticFixture(realisticEvents, 2_000),
  buildRealisticFixture(realisticEvents, 5_000),
  buildLongLineFixture(realisticEvents),
  buildPureAdditionFixture(pureAddEvents, 5_000),
];

for (const fixture of fixtures) {
  writeFileSync(
    path.join(fixtureDir, `${fixture.id}.json`),
    `${JSON.stringify(fixture, null, 2)}\n`,
  );
}

writeFileSync(
  path.join(fixtureDir, 'manifest.json'),
  `${JSON.stringify(fixtures.map(({ oldText, newText, ...metadata }) => metadata), null, 2)}\n`,
);

console.log(`Generated ${fixtures.length} fixtures in ${fixtureDir}`);
