// ============================================================================
// Previewable file types — single extension→kind table for the side panel.
// FileExplorerPanel gates on isPreviewable(); PreviewPanel renders through
// previewDispatch() so the two cannot drift.
// ============================================================================

type PreviewKind =
  | 'markdown'
  | 'table'
  | 'html'
  | 'code'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'archive'
  | 'docx'
  | 'excel'
  | 'presentation'
  | 'text'
  | 'heic'
  | 'legacy-office';

type PreviewCodeLanguage = 'json' | 'yaml' | 'typescript' | 'javascript';

interface PreviewSpec {
  kind: PreviewKind;
  codeLanguage?: PreviewCodeLanguage;
  shikiLanguage?: string | null;
  csvDelimiter?: ',' | '\t';
}

function textSpec(shikiLanguage?: string): PreviewSpec {
  return { kind: 'text', shikiLanguage: shikiLanguage ?? null };
}

// One table. Adding an extension here is what makes the file list AND the
// panel agree. Plain-text kinds are read-only Shiki; code kinds stay editable.
const PREVIEW_BY_EXTENSION: Readonly<Record<string, PreviewSpec>> = {
  md: { kind: 'markdown' },
  mdx: { kind: 'markdown' },
  markdown: { kind: 'markdown' },
  csv: { kind: 'table', csvDelimiter: ',' },
  tsv: { kind: 'table', csvDelimiter: '\t' },
  docx: { kind: 'docx' },
  xlsx: { kind: 'excel' },
  xls: { kind: 'excel' },
  pptx: { kind: 'presentation' },
  html: { kind: 'html' },
  htm: { kind: 'html' },
  txt: textSpec(),
  json: { kind: 'code', codeLanguage: 'json' },
  yaml: { kind: 'code', codeLanguage: 'yaml' },
  yml: { kind: 'code', codeLanguage: 'yaml' },
  ts: { kind: 'code', codeLanguage: 'typescript' },
  tsx: { kind: 'code', codeLanguage: 'typescript' },
  js: { kind: 'code', codeLanguage: 'javascript' },
  jsx: { kind: 'code', codeLanguage: 'javascript' },
  jpg: { kind: 'image' },
  jpeg: { kind: 'image' },
  png: { kind: 'image' },
  gif: { kind: 'image' },
  webp: { kind: 'image' },
  svg: { kind: 'image' },
  pdf: { kind: 'pdf' },
  mp3: { kind: 'audio' },
  wav: { kind: 'audio' },
  m4a: { kind: 'audio' },
  aac: { kind: 'audio' },
  flac: { kind: 'audio' },
  ogg: { kind: 'audio' },
  mp4: { kind: 'video' },
  webm: { kind: 'video' },
  mov: { kind: 'video' },
  mkv: { kind: 'video' },
  avi: { kind: 'video' },
  zip: { kind: 'archive' },
  tar: { kind: 'archive' },
  gz: { kind: 'archive' },
  tgz: { kind: 'archive' },
  rar: { kind: 'archive' },
  '7z': { kind: 'archive' },
  py: textSpec('python'),
  sh: textSpec('shellscript'),
  bash: textSpec('shellscript'),
  zsh: textSpec('shellscript'),
  css: textSpec('css'),
  scss: textSpec('scss'),
  sql: textSpec('sql'),
  xml: textSpec('xml'),
  toml: textSpec('toml'),
  ini: textSpec('ini'),
  log: textSpec(),
  go: textSpec('go'),
  rs: textSpec('rust'),
  java: textSpec('java'),
  c: textSpec('c'),
  cpp: textSpec('cpp'),
  cc: textSpec('cpp'),
  h: textSpec('c'),
  hpp: textSpec('cpp'),
  swift: textSpec('swift'),
  kt: textSpec('kotlin'),
  rb: textSpec('ruby'),
  php: textSpec('php'),
  heic: { kind: 'heic' },
  heif: { kind: 'heic' },
  doc: { kind: 'legacy-office' },
  ppt: { kind: 'legacy-office' },
  key: { kind: 'legacy-office' },
  pages: { kind: 'legacy-office' },
  numbers: { kind: 'legacy-office' },
};

export const PREVIEWABLE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(PREVIEW_BY_EXTENSION));

export interface PreviewDispatch {
  kind: PreviewKind | null;
  rendersInPanel: boolean;
  isMarkdown: boolean;
  isHtml: boolean;
  isCsv: boolean;
  csvDelimiter: ',' | '\t' | null;
  isCode: boolean;
  codeLanguage: PreviewCodeLanguage | null;
  isImage: boolean;
  isPdf: boolean;
  isAudio: boolean;
  isVideo: boolean;
  isArchive: boolean;
  isDocx: boolean;
  isExcel: boolean;
  isPresentation: boolean;
  isOffice: boolean;
  isBinary: boolean;
  isHeic: boolean;
  isLegacyOffice: boolean;
  isText: boolean;
  shikiLanguage: string | null;
}

export function getFileExtension(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  // A leading dot (".gitignore") is not an extension — sniff decides.
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function isPreviewable(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  return PREVIEWABLE_EXTENSIONS.has(getFileExtension(filePath));
}

function blank(kind: PreviewKind | null): PreviewDispatch {
  return {
    kind,
    rendersInPanel: false,
    isMarkdown: false,
    isHtml: false,
    isCsv: false,
    csvDelimiter: null,
    isCode: false,
    codeLanguage: null,
    isImage: false,
    isPdf: false,
    isAudio: false,
    isVideo: false,
    isArchive: false,
    isDocx: false,
    isExcel: false,
    isPresentation: false,
    isOffice: false,
    isBinary: false,
    isHeic: false,
    isLegacyOffice: false,
    isText: false,
    shikiLanguage: null,
  };
}

function dispatchSpec(spec: PreviewSpec): PreviewDispatch {
  const kind = spec.kind;
  switch (kind) {
    case 'markdown':
      return { ...blank(kind), rendersInPanel: true, isMarkdown: true };
    case 'table':
      return { ...blank(kind), rendersInPanel: true, isCsv: true, csvDelimiter: spec.csvDelimiter ?? ',' };
    case 'html':
      return { ...blank(kind), rendersInPanel: true, isHtml: true };
    case 'code':
      return {
        ...blank(kind),
        rendersInPanel: true,
        isCode: true,
        codeLanguage: spec.codeLanguage ?? 'javascript',
      };
    case 'image':
      return { ...blank(kind), rendersInPanel: true, isImage: true, isBinary: true };
    case 'pdf':
      return { ...blank(kind), rendersInPanel: true, isPdf: true, isBinary: true };
    case 'audio':
      return { ...blank(kind), rendersInPanel: true, isAudio: true, isBinary: true };
    case 'video':
      return { ...blank(kind), rendersInPanel: true, isVideo: true, isBinary: true };
    case 'archive':
      return { ...blank(kind), rendersInPanel: true, isArchive: true };
    case 'docx':
      return { ...blank(kind), rendersInPanel: true, isDocx: true, isOffice: true };
    case 'excel':
      return { ...blank(kind), rendersInPanel: true, isExcel: true, isOffice: true };
    case 'presentation':
      return { ...blank(kind), rendersInPanel: true, isPresentation: true, isOffice: true };
    case 'text':
      return {
        ...blank(kind),
        rendersInPanel: true,
        isText: true,
        shikiLanguage: spec.shikiLanguage ?? null,
      };
    case 'heic':
      return { ...blank(kind), rendersInPanel: true, isHeic: true };
    case 'legacy-office':
      return { ...blank(kind), rendersInPanel: true, isLegacyOffice: true };
    default:
      return blank(kind);
  }
}

export function previewDispatch(filePath: string | null | undefined): PreviewDispatch {
  if (!filePath) return blank(null);
  const ext = getFileExtension(filePath);
  // Extensionless names (and dotfiles) that reach the panel were sniffed as text.
  if (!ext) {
    return { ...blank('text'), rendersInPanel: true, isText: true, shikiLanguage: null };
  }
  const spec = PREVIEW_BY_EXTENSION[ext];
  if (!spec) return blank(null);
  return dispatchSpec(spec);
}
