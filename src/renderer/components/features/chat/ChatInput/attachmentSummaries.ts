import type {
  ArchiveManifest,
  PresentationSlideSummary,
  PresentationSummary,
} from '../../../../../shared/contract';

interface ZipEntry {
  name: string;
  dir: boolean;
  _data?: {
    uncompressedSize?: number;
    compressedSize?: number;
  };
  async(type: 'string'): Promise<string>;
}

interface ZipFile {
  files: Record<string, ZipEntry>;
}

const MAX_PRESENTATION_SLIDES = 20;
const MAX_ARCHIVE_ENTRIES = 200;

function baseNameWithoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadZip(file: File): Promise<ZipFile> {
  const { default: JSZip } = await import('jszip');
  const data = await file.arrayBuffer();
  return JSZip.loadAsync(data) as Promise<ZipFile>;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function extractTextRuns(xml: string): string[] {
  const runs: string[] = [];
  const textRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
  for (const match of xml.matchAll(textRegex)) {
    const text = decodeXmlEntities(match[1]).replace(/\s+/g, ' ').trim();
    if (text) runs.push(text);
  }
  return runs;
}

function getSlideIndex(path: string): number {
  const match = path.match(/slide(\d+)\.xml$/);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function isDangerousArchivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return (
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  );
}

function archiveFormatFor(file: File): string {
  const name = file.name.toLowerCase();
  if (name.endsWith('.tar.gz')) return 'tar.gz';
  if (name.endsWith('.tgz')) return 'tgz';
  if (name.endsWith('.zip')) return 'zip';
  if (name.endsWith('.tar')) return 'tar';
  if (name.endsWith('.gz')) return 'gz';
  if (name.endsWith('.7z')) return '7z';
  if (name.endsWith('.rar')) return 'rar';
  if (file.type.includes('zip')) return 'zip';
  if (file.type.includes('gzip')) return 'gz';
  if (file.type.includes('tar')) return 'tar';
  return 'archive';
}

export async function buildPresentationSummary(file: File): Promise<PresentationSummary> {
  const lowerName = file.name.toLowerCase();
  const isPptx = lowerName.endsWith('.pptx') || file.type.includes('presentationml');
  if (!isPptx) {
    return {
      title: baseNameWithoutExtension(file.name),
      format: 'ppt',
      parseError: 'Legacy .ppt binary parsing is not available in the upload preview path.',
    };
  }

  try {
    const zip = await loadZip(file);
    const slideEntries = Object.values(zip.files)
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
      .sort((a, b) => getSlideIndex(a.name) - getSlideIndex(b.name));

    const slides: PresentationSlideSummary[] = [];
    for (const entry of slideEntries.slice(0, MAX_PRESENTATION_SLIDES)) {
      const xml = await entry.async('string');
      const runs = extractTextRuns(xml);
      const textPreview = runs.join(' ').slice(0, 700);
      slides.push({
        index: getSlideIndex(entry.name),
        title: runs[0],
        textPreview,
        textRuns: runs.length,
        imageCount: (xml.match(/<a:blip\b/g) || []).length,
        tableCount: (xml.match(/<a:tbl\b/g) || []).length,
      });
    }

    return {
      title: slides.find((slide) => slide.title)?.title || baseNameWithoutExtension(file.name),
      format: 'pptx',
      slideCount: slideEntries.length,
      slides,
      truncated: slideEntries.length > MAX_PRESENTATION_SLIDES,
    };
  } catch (error) {
    return {
      title: baseNameWithoutExtension(file.name),
      format: 'pptx',
      parseError: getErrorMessage(error),
    };
  }
}

export async function buildArchiveManifest(file: File): Promise<ArchiveManifest> {
  const format = archiveFormatFor(file);
  if (format !== 'zip') {
    return {
      format,
      supported: false,
      totalFiles: 0,
      entries: [],
      note: 'This archive format is persisted as a file attachment; inline manifest extraction currently supports ZIP only.',
    };
  }

  try {
    const zip = await loadZip(file);
    const allEntries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));
    const dangerousEntries = allEntries
      .filter((entry) => isDangerousArchivePath(entry.name))
      .map((entry) => entry.name);
    const totalFiles = allEntries.filter((entry) => !entry.dir).length;
    const totalDirectories = allEntries.filter((entry) => entry.dir).length;
    const totalUncompressedSize = allEntries.reduce((sum, entry) => (
      sum + (entry._data?.uncompressedSize || 0)
    ), 0);
    const totalCompressedSize = allEntries.reduce((sum, entry) => (
      sum + (entry._data?.compressedSize || 0)
    ), 0);

    return {
      format,
      supported: true,
      totalFiles,
      totalDirectories,
      totalUncompressedSize,
      totalCompressedSize,
      entries: allEntries.slice(0, MAX_ARCHIVE_ENTRIES).map((entry) => ({
        path: entry.name,
        isDirectory: entry.dir,
        size: entry._data?.uncompressedSize,
        compressedSize: entry._data?.compressedSize,
      })),
      dangerousEntries,
      truncated: allEntries.length > MAX_ARCHIVE_ENTRIES,
    };
  } catch (error) {
    return {
      format,
      supported: false,
      totalFiles: 0,
      entries: [],
      note: `ZIP manifest extraction failed: ${getErrorMessage(error)}`,
    };
  }
}
