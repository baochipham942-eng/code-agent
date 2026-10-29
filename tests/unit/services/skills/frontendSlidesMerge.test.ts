// 合成脚本从随包目录运行，不靠仓库 node_modules 解析 pptxgenjs / pdf-lib。
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo root not found');
}

function slides(count: number): string {
  const pages = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    layout: index === 0 ? 'cover' : 'content',
    title: `第 ${index + 1} 页结论`,
    subtitle: index === 0 ? '纯文字兜底' : '',
    bullets: index === 0 ? [] : ['要点甲', '要点乙'],
    footnote: '',
  }));
  return JSON.stringify(pages, null, 2);
}

function runNode(script: string, args: string[], cwd: string) {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

function slideXmlCount(pptxPath: string): number {
  const listed = spawnSync('unzip', ['-l', pptxPath], { encoding: 'utf8' });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout.split('\n').filter((line) => /ppt\/slides\/slide[0-9]+\.xml/.test(line)).length;
}

function slideXml(pptxPath: string, index: number): string {
  const extracted = spawnSync('unzip', ['-p', pptxPath, `ppt/slides/slide${index}.xml`], {
    encoding: 'utf8',
  });
  expect(extracted.status, extracted.stderr).toBe(0);
  return extracted.stdout;
}

function pptxEntryHashes(pptxPath: string): Record<string, string> {
  const listed = spawnSync('unzip', ['-Z1', pptxPath], { encoding: 'utf8' });
  expect(listed.status, listed.stderr).toBe(0);
  const hashes: Record<string, string> = {};
  const entries = listed.stdout
    .split('\n')
    .filter((entry) => entry && !entry.endsWith('/') && entry !== 'docProps/core.xml');
  for (const entry of entries) {
    const escaped = entry.replaceAll('[', '\\[').replaceAll(']', '\\]');
    const extracted = spawnSync('unzip', ['-p', pptxPath, escaped]);
    expect(extracted.status, extracted.stderr.toString()).toBe(0);
    hashes[entry] = createHash('sha256').update(extracted.stdout).digest('hex');
  }
  return hashes;
}

const BASELINE_HASHES: Record<string, string> = Object.fromEntries(`
[Content_Types].xml\tdf4c7187ea4d73242defd3421bd060addeaaedebf409473a2a624319fe1ab7a3
_rels/.rels\ta73dc65f1cb1959ca09044852c3697385e6124853bf5a0fa3f0215f608e86b47
docProps/app.xml\t0b42f7eae1a1d47924cdbb39baa037d347061b8c0c9bd5e5f5aea77203ce47f7
ppt/_rels/presentation.xml.rels\tb9ea86f7a1cbf48363f9075ffd2a94d43d2c3f67c94a40bb50b367cf78c20013
ppt/theme/theme1.xml\t4c4d228fe0ed2577e90bcda2a7ebdd9c0227d8f84c9777419f2d6b8ccc137dd3
ppt/presentation.xml\t00251d9584ede238811c8c208fde7749883f70f8250004a086e4a66b73a92a89
ppt/presProps.xml\t4446069208ff4cd22879cccdfb0a2a302cb7e572e2c48d00b64066d25f026df1
ppt/tableStyles.xml\t0e7ac03251337ecbaf6c8ca13619db1caeda5c90c4e3210d45d6c3f5df4de103
ppt/viewProps.xml\t4cc12863620049069daeb39b14b4aba98a5e3048318be16a5af5879f6e4b2ac8
ppt/slideLayouts/slideLayout1.xml\t5015c0989d7672a610fc41c3f7f4a468fc0da42198f06e6c5f20a0921090e1c9
ppt/slideLayouts/_rels/slideLayout1.xml.rels\t8246d333bf3764cd35563e3df1828c26bbc28890815a2987caf3e592791ba60d
ppt/slides/slide1.xml\t70600c69b57a2f0cc300b96771a28c4d96c6d026456893a7c3cdecd0708717b2
ppt/slides/_rels/slide1.xml.rels\tf78f296579095a9d8296d23b5afb91380b7ddb6ec944113187bbd6deffd1b1d0
ppt/notesSlides/notesSlide1.xml\ta559bf003438191a2723e887544acb00d550c7a9d8a4fd36a41bd877d46e2be6
ppt/notesSlides/_rels/notesSlide1.xml.rels\t4e7f04378558285258df490583e9ed0e8039b27df83bcdc2e5b4992cf47090f2
ppt/slides/slide2.xml\tf6d0a33ffccd5980ee242481f36a3504734fa009d93b0c3d0debddb1855a0a30
ppt/slides/_rels/slide2.xml.rels\t21cce9f09d7d0432290df9f83bbb7d1378c5895898f22f0e1a869c4090b590a6
ppt/notesSlides/notesSlide2.xml\tbae0245bfeb4194074a5dfde0aa08b36a6fa527ddcaccca0bdbc37eee8b3a57c
ppt/notesSlides/_rels/notesSlide2.xml.rels\td9b0b8b9c1791837bed1ec75969ec1d34486b5e1606a0d739d3c35eeba590d06
ppt/slides/slide3.xml\td37240a7820f009b88e886d47b2e2dd6995d2d392678bc591606e2ee1ef5e6b7
ppt/slides/_rels/slide3.xml.rels\t509ce02a65832cefe49c42eec7fa0772dfa918adbc81dc87075a2706431b9014
ppt/notesSlides/notesSlide3.xml\t7ec927f72813271eb244cfe044facb5970f0e26e10a84b83b2cda218e56b92f5
ppt/notesSlides/_rels/notesSlide3.xml.rels\t578c28b0582eba439178176fb0b102c03bb1ec88abed3503f44bcd0f9a11783c
ppt/slides/slide4.xml\tf935304bd94a16b833de5a01d27cb02c4cb810cf40c87b8f4b8019a161f7be97
ppt/slides/_rels/slide4.xml.rels\t5e69cf9fdab20034cde57cf1b62e0ed7d1d8b1328e476d82daa2376c46a754e4
ppt/notesSlides/notesSlide4.xml\t81b9ecb4086b52a4868a8f81f611012497f27933c28c9e5a24b05d6b5d891226
ppt/notesSlides/_rels/notesSlide4.xml.rels\t6de72adb9167a1c1aab19cda70f7d44ca6fc93d97f14b01e74a76a5a7197b958
ppt/slides/slide5.xml\tc866dd6b0325b0f265ecf15bab288fd29076c3537bfd44747e8b8d0f8b23a6f8
ppt/slides/_rels/slide5.xml.rels\te7d16ad24fefea6748107a65ca9e49cf6bed3f8b53148ad8272afeabbc56d593
ppt/notesSlides/notesSlide5.xml\ta423384449d4f093ae59df5fb176af9078643d1c16262d7fdf35b9af8763483a
ppt/notesSlides/_rels/notesSlide5.xml.rels\t9c83aa477a5a4c0f5108d5160fd45674eba6e6583f49c67b254b4ea715ddc83b
ppt/slideMasters/slideMaster1.xml\tebd49ca7c690fabf8b16c077711e80f2aa970b1aa2a31090407b2af58cab77c3
ppt/slideMasters/_rels/slideMaster1.xml.rels\t066fd8f2e94608804160631c736d82e4c0b0784a1646489030092cc04888839a
ppt/notesMasters/notesMaster1.xml\tc2c0255a24d45ef3ad633078fd8a2dca43fc6db1b3eb36244a934eb0b9d97c57
ppt/notesMasters/_rels/notesMaster1.xml.rels\t92eb9005ae03705d1db0f1da37f89e4c77f61b2026efa66bdbf610d01116f2b9
`.trim().split('\n').map((line) => line.split('\t')));

describe('frontend-slides packaged merge scripts', () => {
  const root = repoRoot();
  const packagedScripts = path.join(root, 'resources', 'skills', 'frontend-slides', 'scripts');
  // Entry sources live outside the packaged tree (release leak); bundles are generated from them.
  const skillSources = path.join(root, 'resources', 'skill-sources', 'frontend-slides');

  it('keeps the text-only notice inside the committed bundle and does not import pptxgenjs bare', () => {
    const source = fs.readFileSync(path.join(skillSources, 'merge-to-pptx-hybrid.mjs'), 'utf8');
    const notice = source.match(/const TEXT_ONLY_NOTICE = '([^']+)';/);
    expect(notice?.[1]).toBe('backgrounds were skipped');
    const bundle = fs.readFileSync(path.join(packagedScripts, 'merge-to-pptx-hybrid.bundle.mjs'), 'utf8');
    expect(bundle.length).toBeGreaterThan(10_000);
    expect(bundle).toContain(notice![1]);
    expect(bundle).not.toMatch(/from\s+["']pptxgenjs["']/);
    expect(bundle).not.toMatch(/require\(\s*["']pptxgenjs["']\s*\)/);
    const pdfBundle = fs.readFileSync(path.join(packagedScripts, 'merge-to-pdf.bundle.mjs'), 'utf8');
    expect(pdfBundle).not.toMatch(/from\s+["']pdf-lib["']/);
    expect(pdfBundle).not.toMatch(/require\(\s*["']pdf-lib["']\s*\)/);
  });

  it('passes the selected theme through every documented hybrid merge command', () => {
    const skillDocs = [
      'resources/skills/frontend-slides/SKILL.md',
      '.claude/skills/frontend-slides/SKILL.md',
      '.agents/skills/frontend-slides/SKILL.md',
    ];
    for (const relative of skillDocs) {
      const content = fs.readFileSync(path.join(root, relative), 'utf8');
      const commands = content.split('\n').filter((line) => line.includes('merge-to-pptx-hybrid.mjs'));
      expect(commands.length, `${relative} must document the hybrid merge command`).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command, `${relative} must forward the selected style`).toContain('--theme <theme>');
      }
      expect(content, `${relative} must define the supported theme mapping`).toContain(
        '`<theme>` 取已选的 `corporate`、`minimal` 或 `bold-editorial`，选择这三种风格后不得省略 `--theme`；其他风格省略该参数，沿用 `default`',
      );
    }
  });

  it('renders a 5-page text-only pptx from a copy outside the repo', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-merge-'));
    const scriptDir = path.join(outside, 'scripts');
    fs.cpSync(packagedScripts, scriptDir, {
      recursive: true,
      filter: (sourcePath) => path.basename(sourcePath) !== 'src',
    });
    const deckDir = path.join(outside, 'deck');
    fs.mkdirSync(deckDir);
    fs.writeFileSync(path.join(deckDir, 'slides.json'), slides(5), 'utf8');

    const env = { ...process.env };
    delete env.NODE_PATH;
    const paths = spawnSync(process.execPath, ['-e', 'console.log(module.paths.join("\\n"))'], {
      cwd: scriptDir,
      env,
      encoding: 'utf8',
    });
    expect(paths.status).toBe(0);
    const repoModules = fs.realpathSync(path.join(root, 'node_modules'));
    expect(paths.stdout).not.toContain(repoModules);
    expect(paths.stdout).not.toContain(path.join(root, 'node_modules'));

    const script = path.join(scriptDir, 'merge-to-pptx-hybrid.mjs');
    const explicit = runNode(script, [deckDir, '--text-only'], scriptDir);
    expect(explicit.status, `${explicit.stdout}\n${explicit.stderr}`).toBe(0);
    expect(explicit.stdout).toContain('backgrounds were skipped');
    const explicitPptx = path.join(deckDir, 'deck.pptx');
    const tested = spawnSync('unzip', ['-t', explicitPptx], { encoding: 'utf8' });
    expect(tested.status, tested.stdout + tested.stderr).toBe(0);
    expect(slideXmlCount(explicitPptx)).toBe(5);

    const autoDir = path.join(outside, 'auto');
    fs.mkdirSync(autoDir);
    fs.writeFileSync(path.join(autoDir, 'slides.json'), slides(5), 'utf8');
    const automatic = runNode(script, [autoDir], scriptDir);
    expect(automatic.status, `${automatic.stdout}\n${automatic.stderr}`).toBe(0);
    expect(automatic.stdout).toContain('backgrounds were skipped');
    expect(slideXmlCount(path.join(autoDir, 'auto.pptx'))).toBe(5);
  });

  it('keeps the unflagged and explicit default decks byte-identical to the baseline', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-default-theme-'));
    const scriptDir = path.join(outside, 'scripts');
    fs.cpSync(packagedScripts, scriptDir, {
      recursive: true,
      filter: (sourcePath) => path.basename(sourcePath) !== 'src',
    });
    const script = path.join(scriptDir, 'merge-to-pptx-hybrid.mjs');
    const noFlagDir = path.join(outside, 'no-flag');
    const defaultDir = path.join(outside, 'default');
    fs.mkdirSync(noFlagDir);
    fs.mkdirSync(defaultDir);
    fs.writeFileSync(path.join(noFlagDir, 'slides.json'), slides(5), 'utf8');
    fs.writeFileSync(path.join(defaultDir, 'slides.json'), slides(5), 'utf8');

    const noFlag = runNode(script, [noFlagDir, '--text-only'], scriptDir);
    const explicitDefault = runNode(script, [defaultDir, '--text-only', '--theme', 'default'], scriptDir);
    expect(noFlag.status, `${noFlag.stdout}\n${noFlag.stderr}`).toBe(0);
    expect(explicitDefault.status, `${explicitDefault.stdout}\n${explicitDefault.stderr}`).toBe(0);

    const noFlagHashes = pptxEntryHashes(path.join(noFlagDir, 'no-flag.pptx'));
    const defaultHashes = pptxEntryHashes(path.join(defaultDir, 'default.pptx'));
    expect(noFlagHashes).toEqual(BASELINE_HASHES);
    expect(defaultHashes).toEqual(BASELINE_HASHES);
    expect(defaultHashes).toEqual(noFlagHashes);
  });

  it('renders pairwise-different named themes with their font and background in slide XML', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-named-themes-'));
    const scriptDir = path.join(outside, 'scripts');
    fs.cpSync(packagedScripts, scriptDir, {
      recursive: true,
      filter: (sourcePath) => path.basename(sourcePath) !== 'src',
    });
    const script = path.join(scriptDir, 'merge-to-pptx-hybrid.mjs');
    const themes = [
      { name: 'corporate', font: 'Microsoft YaHei', background: 'F8FAFC' },
      { name: 'minimal', font: 'PingFang SC', background: 'FFFFFF' },
      { name: 'bold-editorial', font: 'Songti SC', background: '111111' },
    ];
    const outputs: string[] = [];
    for (const theme of themes) {
      const deckDir = path.join(outside, theme.name);
      fs.mkdirSync(deckDir);
      fs.writeFileSync(path.join(deckDir, 'slides.json'), slides(5), 'utf8');
      const result = runNode(script, [deckDir, '--text-only', '--theme', theme.name], scriptDir);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const pptxPath = path.join(deckDir, `${theme.name}.pptx`);
      expect(slideXml(pptxPath, 1)).toContain(`typeface="${theme.font}"`);
      expect(slideXml(pptxPath, 1)).toContain(`srgbClr val="${theme.background}"`);
      outputs.push(pptxPath);
    }

    const hashes = outputs.map(pptxEntryHashes);
    expect(hashes[0]).not.toEqual(hashes[1]);
    expect(hashes[0]).not.toEqual(hashes[2]);
    expect(hashes[1]).not.toEqual(hashes[2]);
  });

  it('rejects an unknown theme and lists all valid names', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-unknown-theme-'));
    const scriptDir = path.join(outside, 'scripts');
    fs.cpSync(packagedScripts, scriptDir, {
      recursive: true,
      filter: (sourcePath) => path.basename(sourcePath) !== 'src',
    });
    const deckDir = path.join(outside, 'deck');
    fs.mkdirSync(deckDir);
    fs.writeFileSync(path.join(deckDir, 'slides.json'), slides(1), 'utf8');

    const result = runNode(
      path.join(scriptDir, 'merge-to-pptx-hybrid.mjs'),
      [deckDir, '--text-only', '--theme', 'unknown'],
      scriptDir,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Unknown theme "unknown". Valid themes: default, corporate, minimal, bold-editorial',
    );
  });

  it('keeps image mode silent about skipped backgrounds and still builds a pdf', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-image-'));
    const scriptDir = path.join(outside, 'scripts');
    fs.cpSync(packagedScripts, scriptDir, {
      recursive: true,
      filter: (sourcePath) => path.basename(sourcePath) !== 'src',
    });
    const deckDir = path.join(outside, 'picture');
    fs.mkdirSync(deckDir);
    fs.writeFileSync(path.join(deckDir, 'slides.json'), slides(1), 'utf8');
    fs.writeFileSync(path.join(deckDir, '01-slide-cover.png'), ONE_PIXEL_PNG);

    const hybrid = runNode(
      path.join(scriptDir, 'merge-to-pptx-hybrid.mjs'),
      [deckDir, '--theme', 'corporate'],
      scriptDir,
    );
    expect(hybrid.status, `${hybrid.stdout}\n${hybrid.stderr}`).toBe(0);
    expect(hybrid.stdout).not.toContain('backgrounds were skipped');
    const pptx = path.join(deckDir, 'picture.pptx');
    expect(spawnSync('unzip', ['-t', pptx], { encoding: 'utf8' }).status).toBe(0);
    expect(slideXmlCount(pptx)).toBe(1);
    expect(slideXml(pptx, 1)).toContain('typeface="Microsoft YaHei"');
    expect(slideXml(pptx, 1)).toContain('srgbClr val="FFFFFF"');

    const pdf = runNode(path.join(scriptDir, 'merge-to-pdf.mjs'), [deckDir], scriptDir);
    expect(pdf.status, `${pdf.stdout}\n${pdf.stderr}`).toBe(0);
    expect(fs.statSync(path.join(deckDir, 'picture.pdf')).size).toBeGreaterThan(100);
  });
});
