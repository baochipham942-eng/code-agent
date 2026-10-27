import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { handleInspectArchive } from '../../../src/host/ipc/workspaceArchive.ipc';
import {
  classifyPreviewFile,
  previewHeic,
  previewLegacyOffice,
  readTextPreview,
} from '../../../src/host/ipc/workspacePreviewFormats';

const TEXT_CAP = 512 * 1024;
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'neo-preview-formats-'));
}

function tarVersion(): string {
  try {
    return execFileSync('tar', ['--version'], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function hasZip(): boolean {
  try {
    return execFileSync('which', ['zip'], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

function sofficeBin(): string | null {
  try {
    const found = execFileSync('which', ['soffice'], { encoding: 'utf8' }).trim();
    return found || null;
  } catch {
    return null;
  }
}

function tarFailure(stderr: string): never {
  const error = new Error('tar failed') as NodeJS.ErrnoException & { stderr?: string };
  error.stderr = stderr;
  throw error;
}

describe('classifyPreviewFile', () => {
  it('sniffs an extensionless Mach-O and an extensionless png as binary', async () => {
    const dir = await tempDir();
    const macho = path.join(dir, 'copied-macho');
    const png = path.join(dir, 'copied-png');
    await copyFile('/bin/ls', macho);
    await writeFile(png, ONE_PIXEL_PNG);

    await expect(classifyPreviewFile({ filePath: macho })).resolves.toMatchObject({ classification: 'binary' });
    await expect(classifyPreviewFile({ filePath: png })).resolves.toMatchObject({ classification: 'binary' });
  });

  it('sniffs extensionless text and an empty file as text', async () => {
    const dir = await tempDir();
    const notes = path.join(dir, 'notes');
    const empty = path.join(dir, 'empty');
    await writeFile(notes, 'hello preview\n');
    await writeFile(empty, '');

    await expect(classifyPreviewFile({ filePath: notes })).resolves.toMatchObject({ classification: 'text' });
    await expect(classifyPreviewFile({ filePath: empty })).resolves.toMatchObject({ classification: 'text' });
    await expect(readTextPreview({ filePath: notes })).resolves.toMatchObject({
      kind: 'text-preview',
      text: 'hello preview\n',
      truncated: false,
    });
  });

  it('treats NUL, invalid UTF-8, and zip magic as binary', async () => {
    const dir = await tempDir();
    const nul = path.join(dir, 'nul');
    const bad = path.join(dir, 'bad-utf8');
    const zip = path.join(dir, 'zip-magic');
    await writeFile(nul, Buffer.from([0x68, 0x00, 0x69]));
    await writeFile(bad, Buffer.from([0xff, 0xfe, 0x41]));
    await writeFile(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x68, 0x69]));

    await expect(classifyPreviewFile({ filePath: nul })).resolves.toMatchObject({ classification: 'binary' });
    await expect(classifyPreviewFile({ filePath: bad })).resolves.toMatchObject({ classification: 'binary' });
    await expect(classifyPreviewFile({ filePath: zip })).resolves.toMatchObject({ classification: 'binary' });
    await expect(readTextPreview({ filePath: zip })).resolves.toMatchObject({
      kind: 'text-preview',
      text: '',
      fallback: { code: 'binary' },
    });
  });

  it('caps a text preview at 512 KB', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'long.txt');
    await writeFile(filePath, Buffer.alloc(TEXT_CAP + 32, 0x61));
    const preview = await readTextPreview({ filePath });
    expect(preview.truncated).toBe(true);
    expect(preview.text.length).toBe(TEXT_CAP);
    expect(preview.fallback).toBeUndefined();
  });

  it('rejects a relative path', async () => {
    await expect(classifyPreviewFile({ filePath: 'notes.txt' })).rejects.toThrow(/absolute file path/);
  });
});

describe('previewHeic', () => {
  it('degrades off darwin without calling sips', async () => {
    const execFile = vi.fn();
    const result = await previewHeic(
      { filePath: '/tmp/picture.heic' },
      { platform: 'linux', execFile },
    );
    expect(result).toMatchObject({ state: 'error', code: 'heic-failed' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reuses a cached jpeg on the second open', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'picture.heic');
    await writeFile(filePath, 'not-a-real-heic');
    const cacheRoot = path.join(dir, 'cache');
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      const out = args[args.indexOf('--out') + 1];
      await writeFile(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    });
    const first = await previewHeic({ filePath }, { platform: 'darwin', cacheRoot, execFile });
    const second = await previewHeic({ filePath }, { platform: 'darwin', cacheRoot, execFile });
    expect(first.state).toBe('ready');
    expect(second.imagePath).toBe(first.imagePath);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect((await stat(first.imagePath!)).size).toBeGreaterThan(0);
  });

  it.skipIf(process.platform !== 'darwin')('converts a real heic written by sips', async () => {
    const dir = await tempDir();
    const png = path.join(dir, 'x.png');
    const heic = path.join(dir, 'x.heic');
    await writeFile(png, ONE_PIXEL_PNG);
    execFileSync('sips', ['-s', 'format', 'heic', png, '--out', heic]);
    const result = await previewHeic({ filePath: heic }, { cacheRoot: path.join(dir, 'cache') });
    expect(result.state).toBe('ready');
    const jpeg = await readFile(result.imagePath!);
    expect(jpeg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
  });
});

describe('previewLegacyOffice', () => {
  it('degrades doc and key when LibreOffice is injected as missing', async () => {
    const convertOfficeToPdf = vi.fn();
    const doc = await previewLegacyOffice(
      { filePath: '/tmp/legacy.doc' },
      { platform: 'darwin', libreOfficeAvailable: () => false, convertOfficeToPdf },
    );
    const key = await previewLegacyOffice(
      { filePath: '/tmp/deck.key' },
      { platform: 'darwin', libreOfficeAvailable: () => false, convertOfficeToPdf },
    );
    expect(doc.state).toBe('libreoffice-missing');
    expect(key.state).toBe('libreoffice-missing');
    expect(convertOfficeToPdf).not.toHaveBeenCalled();
  });

  it('degrades on non-darwin even when LibreOffice is present', async () => {
    const convertOfficeToPdf = vi.fn();
    const result = await previewLegacyOffice(
      { filePath: '/tmp/legacy.doc' },
      { platform: 'linux', libreOfficeAvailable: () => true, convertOfficeToPdf },
    );
    expect(result.state).toBe('libreoffice-missing');
    expect(convertOfficeToPdf).not.toHaveBeenCalled();
  });

  it('degrades when conversion yields no pages', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'legacy.doc');
    await writeFile(filePath, 'doc-bytes');
    const result = await previewLegacyOffice({ filePath }, {
      platform: 'darwin',
      libreOfficeAvailable: () => true,
      cacheRoot: path.join(dir, 'office'),
      convertOfficeToPdf: async () => path.join(dir, 'missing.pdf'),
      rasterizePdfToImages: async () => [],
    });
    expect(result.state).toBe('conversion-failed');
  });

  it.skipIf(sofficeBin() === null)('rasterizes a real doc through LibreOffice', async () => {
    const dir = await tempDir();
    const txt = path.join(dir, 'hello.txt');
    await writeFile(txt, 'hello preview\n');
    execFileSync(sofficeBin()!, ['--headless', '--convert-to', 'doc', '--outdir', dir, txt], { timeout: 120_000 });
    const result = await previewLegacyOffice(
      { filePath: path.join(dir, 'hello.doc') },
      { platform: 'darwin', cacheRoot: path.join(dir, 'office') },
    );
    expect(result.state).toBe('ready');
    expect(result.pages?.length).toBeGreaterThan(0);
    expect((await stat(result.pages![0].imagePath)).size).toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(sofficeBin() === null)('rasterizes a real ppt converted from a pptx fixture', async () => {
    const dir = await tempDir();
    const source = path.resolve('.claude/test-cases/artifact-runnable/fixtures/good-deck.pptx');
    execFileSync(sofficeBin()!, ['--headless', '--convert-to', 'ppt', '--outdir', dir, source], { timeout: 120_000 });
    const result = await previewLegacyOffice(
      { filePath: path.join(dir, 'good-deck.ppt') },
      { platform: 'darwin', cacheRoot: path.join(dir, 'office') },
    );
    expect(result.state).toBe('ready');
    expect(result.pages?.length).toBeGreaterThan(0);
    expect((await stat(result.pages![0].imagePath)).size).toBeGreaterThan(0);
  }, 180_000);
});

describe('handleInspectArchive non-zip', () => {
  it('lists a real tar.gz', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'd'));
    await writeFile(path.join(dir, 'd', 'a.txt'), 'a');
    await writeFile(path.join(dir, 'b.txt'), 'b');
    const archive = path.join(dir, 'sample.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', dir, 'd', 'b.txt']);
    const inspection = await handleInspectArchive({ filePath: archive });
    expect(inspection.format).toBe('tgz');
    expect(inspection.fallback).toBeUndefined();
    expect(inspection.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['d/', 'd/a.txt', 'b.txt']));
    expect(inspection.entries.find((entry) => entry.name === 'd/')?.isDirectory).toBe(true);
  });

  it.skipIf(!/bsdtar|libarchive/i.test(tarVersion()))('lists a real 7z written by bsdtar', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'd'));
    await writeFile(path.join(dir, 'd', 'a.txt'), 'a');
    await writeFile(path.join(dir, 'b.txt'), 'b');
    const archive = path.join(dir, 'sample.7z');
    execFileSync('tar', ['-a', '-cf', archive, '-C', dir, 'd', 'b.txt']);
    const inspection = await handleInspectArchive({ filePath: archive });
    expect(inspection.format).toBe('7z');
    expect(inspection.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['d/', 'd/a.txt', 'b.txt']));
  });

  it('rejects a plain gzip that is not a tar', async () => {
    const dir = await tempDir();
    const archive = path.join(dir, 'plain.gz');
    await writeFile(archive, gzipSync(Buffer.from('hello plain\n')));
    const execFile = vi.fn();
    const inspection = await handleInspectArchive({ filePath: archive }, { execFile });
    expect(inspection).toMatchObject({ format: 'gz', fallback: { code: 'unsupported' }, entryCount: 0 });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.skipIf(!hasZip())(
    'classifies a real encrypted zip',
    async () => {
      const dir = await tempDir();
      const note = path.join(dir, 'a.txt');
      await writeFile(note, 'secret\n');
      const zipPath = path.join(dir, 'secret.zip');
      execFileSync('zip', ['-P', 'secret', '-j', zipPath, note]);
      const encrypted = await handleInspectArchive({ filePath: zipPath });
      expect(encrypted.fallback).toEqual({ code: 'encrypted' });
    },
  );

  it('classifies a truncated tar.gz as corrupt', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'd'));
    await writeFile(path.join(dir, 'd', 'a.txt'), 'a');
    const archive = path.join(dir, 'whole.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', dir, 'd']);
    const broken = path.join(dir, 'broken.tar.gz');
    const bytes = await readFile(archive);
    await writeFile(broken, bytes.subarray(0, Math.min(24, bytes.length)));
    const corrupt = await handleInspectArchive({ filePath: broken });
    expect(corrupt.fallback).toEqual({ code: 'corrupt' });
  });

  it('classifies mocked rar, encrypted, and corrupt archives', async () => {
    const dir = await tempDir();
    const rar = path.join(dir, 'sample.rar');
    const encrypted = path.join(dir, 'secret.7z');
    const corrupt = path.join(dir, 'broken.tar.gz');
    await writeFile(rar, 'not-a-rar');
    await writeFile(encrypted, 'not-a-7z');
    await writeFile(corrupt, 'not-a-tar');

    const unsupported = await handleInspectArchive({ filePath: rar }, {
      execFile: async () => tarFailure('Unrecognized archive format'),
    });
    const locked = await handleInspectArchive({ filePath: encrypted }, {
      execFile: async () => tarFailure('Archive is encrypted; passphrase required'),
    });
    const damaged = await handleInspectArchive({ filePath: corrupt }, {
      execFile: async () => tarFailure('tar: Error opening archive: truncated gzip input'),
    });

    expect(unsupported.fallback).toEqual({ code: 'unsupported' });
    expect(locked.fallback).toEqual({ code: 'encrypted' });
    expect(damaged.fallback).toEqual({ code: 'corrupt' });
  });
});
