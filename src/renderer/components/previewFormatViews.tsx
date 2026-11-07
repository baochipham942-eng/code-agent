// ============================================================================
// Side-panel views for sniffed text, HEIC, legacy Office, and the shared
// "open with default app" card. One card for every degrade path.
// ============================================================================

import type { ReactElement } from 'react';
import ShikiCodeBlock from './features/chat/MessageBubble/ShikiCodeBlock';
import { Button } from './primitives/Button';
import { useI18n } from '../hooks/useI18n';
import { resolveFileUrl } from '../utils/resolveFileUrl';

type PreviewFallbackCode =
  | 'encrypted'
  | 'corrupt'
  | 'unsupported'
  | 'libreoffice-missing'
  | 'conversion-failed'
  | 'heic-failed'
  | 'binary';

const FALLBACK_CODES = new Set<string>([
  'encrypted',
  'corrupt',
  'unsupported',
  'libreoffice-missing',
  'conversion-failed',
  'heic-failed',
  'binary',
]);

export function PreviewFallbackCard({
  code,
  onOpenDefault,
}: {
  code: PreviewFallbackCode;
  onOpenDefault: () => void;
}): ReactElement {
  const { t } = useI18n();
  const pv = t.previewWorkspace.preview;
  const sentence = {
    encrypted: pv.archiveEncrypted,
    corrupt: pv.archiveCorrupt,
    unsupported: pv.archiveUnsupported,
    'libreoffice-missing': pv.needsLibreOffice,
    'conversion-failed': pv.officeConversionFailed,
    'heic-failed': pv.heicFailed,
    binary: pv.cannotPreview,
  }[code];
  return (
    <div
      data-testid="preview-fallback-card"
      className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-950 p-6 text-center"
    >
      <p data-testid="preview-fallback-sentence" className="max-w-md text-sm text-zinc-300">
        {sentence}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="preview-fallback-open"
        onClick={onOpenDefault}
      >
        {pv.openWithDefault}
      </Button>
    </div>
  );
}

interface TextPreviewBody {
  text: string;
  truncated: boolean;
  fallback?: { code: PreviewFallbackCode };
}

function fallbackCode(value: unknown): PreviewFallbackCode | null {
  return typeof value === 'string' && FALLBACK_CODES.has(value) ? value as PreviewFallbackCode : null;
}

function parseTextPreviewContent(content: string): TextPreviewBody {
  if (content.startsWith('{"kind":"text-preview"')) {
    try {
      const parsed = JSON.parse(content) as {
        kind?: unknown;
        text?: unknown;
        truncated?: unknown;
        fallback?: { code?: unknown };
      };
      if (parsed.kind === 'text-preview' && typeof parsed.text === 'string') {
        const code = fallbackCode(parsed.fallback?.code);
        return {
          text: parsed.text,
          truncated: parsed.truncated === true,
          fallback: code ? { code } : undefined,
        };
      }
    } catch {
      // Raw file text that merely starts with the marker stays raw.
    }
  }
  return { text: content, truncated: false };
}

export function TextPreviewView({
  content,
  shikiLanguage,
  onOpenDefault,
}: {
  content: string;
  shikiLanguage: string | null;
  onOpenDefault: () => void;
}): ReactElement {
  const { t } = useI18n();
  const body = parseTextPreviewContent(content);
  if (body.fallback) {
    return <PreviewFallbackCard code={body.fallback.code} onOpenDefault={onOpenDefault} />;
  }
  return (
    <div data-testid="text-preview" className="h-full overflow-auto bg-zinc-950 p-4 text-zinc-100">
      {body.truncated && (
        <p data-testid="text-preview-truncated" className="mb-3 text-xs text-zinc-400">
          {t.previewWorkspace.preview.textTruncated}
        </p>
      )}
      <ShikiCodeBlock code={body.text} language={shikiLanguage ?? ''} />
    </div>
  );
}

export function HeicPreviewView({
  content,
  onOpenDefault,
}: {
  content: string;
  onOpenDefault: () => void;
}): ReactElement {
  const parsed = parseHeicPreview(content);
  if (parsed?.state === 'ready' && parsed.imagePath) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-zinc-950 p-4">
        <img
          data-testid="heic-preview"
          src={resolveFileUrl(parsed.imagePath)}
          alt=""
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }
  return <PreviewFallbackCard code="heic-failed" onOpenDefault={onOpenDefault} />;
}

function parseHeicPreview(content: string): { state?: string; imagePath?: string } | null {
  try {
    const parsed = JSON.parse(content) as { state?: unknown; imagePath?: unknown };
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      state: typeof parsed.state === 'string' ? parsed.state : undefined,
      imagePath: typeof parsed.imagePath === 'string' ? parsed.imagePath : undefined,
    };
  } catch {
    return null;
  }
}

export function LegacyOfficePreviewView({
  content,
  onOpenDefault,
}: {
  content: string;
  onOpenDefault: () => void;
}): ReactElement {
  const parsed = parseLegacyOfficePreview(content);
  if (parsed?.state === 'ready' && parsed.pages.length > 0) {
    return (
      <div data-testid="legacy-office-preview" className="h-full overflow-auto bg-zinc-950 p-4">
        {parsed.pages.map((page) => (
          <img
            key={`${page.index}-${page.imagePath}`}
            data-testid="legacy-office-page"
            src={resolveFileUrl(page.imagePath)}
            alt=""
            className="mb-3 max-w-full"
          />
        ))}
      </div>
    );
  }
  const code = parsed?.state === 'libreoffice-missing' ? 'libreoffice-missing' : 'conversion-failed';
  return <PreviewFallbackCard code={code} onOpenDefault={onOpenDefault} />;
}

function parseLegacyOfficePreview(content: string): {
  state: string;
  pages: Array<{ index: number; imagePath: string }>;
} | null {
  try {
    const parsed = JSON.parse(content) as { state?: unknown; pages?: unknown };
    if (!parsed || typeof parsed.state !== 'string') return null;
    const pages = Array.isArray(parsed.pages)
      ? parsed.pages.flatMap((page) => {
        if (!page || typeof page !== 'object') return [];
        const record = page as { index?: unknown; imagePath?: unknown };
        if (typeof record.imagePath !== 'string') return [];
        return [{ index: typeof record.index === 'number' ? record.index : 0, imagePath: record.imagePath }];
      })
      : [];
    return { state: parsed.state, pages };
  } catch {
    return null;
  }
}
