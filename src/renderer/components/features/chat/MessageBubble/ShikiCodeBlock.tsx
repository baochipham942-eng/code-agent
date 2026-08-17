import { memo, useEffect, useState, type CSSProperties } from 'react';
import type {
  HighlighterCore,
  LanguageRegistration,
  ThemedToken,
} from '@shikijs/core';
import { useShikiTheme, type ShikiThemeName } from './shikiTheme';

type ThemedLines = ThemedToken[][];

export interface ShikiCodeBlockProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  startingLineNumber?: number;
  wrapLongLines?: boolean;
  customStyle?: CSSProperties;
  lineNumberStyle?: CSSProperties;
  codeTagProps?: { style?: CSSProperties };
  className?: string;
}

type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  json: () => import('@shikijs/langs/json'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  sql: () => import('@shikijs/langs/sql'),
  yaml: () => import('@shikijs/langs/yaml'),
  markdown: () => import('@shikijs/langs/markdown'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  dart: () => import('@shikijs/langs/dart'),
  diff: () => import('@shikijs/langs/diff'),
  xml: () => import('@shikijs/langs/xml'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  graphql: () => import('@shikijs/langs/graphql'),
  mermaid: () => import('@shikijs/langs/mermaid'),
};

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rs: 'rust',
  bash: 'shellscript',
  shell: 'shellscript',
  sh: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  cs: 'csharp',
  rb: 'ruby',
  kt: 'kotlin',
  docker: 'dockerfile',
  gql: 'graphql',
};

const HIGHLIGHT_SETTLE_MS = 200;
let highlighterPromise: Promise<HighlighterCore> | null = null;
const languagePromises = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import('@shikijs/core'),
      import('@shikijs/engine-javascript'),
      import('@shikijs/themes/one-dark-pro'),
      import('@shikijs/themes/one-light'),
      import('@shikijs/themes/github-dark-high-contrast'),
      import('@shikijs/themes/github-light-high-contrast'),
    ]).then(([core, engine, dark, light, highContrastDark, highContrastLight]) => (
      core.createHighlighterCore({
        engine: engine.createJavaScriptRegexEngine(),
        themes: [dark.default, light.default, highContrastDark.default, highContrastLight.default],
        langs: [],
      })
    ));
  }
  return highlighterPromise;
}

function resolveLanguage(language: string): string | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized || normalized === 'text' || normalized === 'plain' || normalized === 'plaintext') {
    return null;
  }
  const canonical = LANGUAGE_ALIASES[normalized] ?? normalized;
  return LANGUAGE_LOADERS[canonical] ? canonical : null;
}

async function ensureLanguage(highlighter: HighlighterCore, language: string): Promise<void> {
  if (highlighter.getLoadedLanguages().includes(language)) return;
  let pending = languagePromises.get(language);
  if (!pending) {
    pending = LANGUAGE_LOADERS[language]().then(({ default: registrations }) => (
      highlighter.loadLanguage(...registrations)
    ));
    languagePromises.set(language, pending);
  }
  await pending;
}

export async function highlightCode(
  code: string,
  language: string,
  theme: ShikiThemeName,
): Promise<ThemedLines | null> {
  const resolvedLanguage = resolveLanguage(language);
  if (!resolvedLanguage) return null;
  const highlighter = await getHighlighter();
  await ensureLanguage(highlighter, resolvedLanguage);
  return highlighter.codeToTokensBase(code, { lang: resolvedLanguage, theme });
}

function tokenStyle(token: ThemedToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0;
  return {
    ...(token.htmlStyle as CSSProperties | undefined),
    color: token.color,
    backgroundColor: token.bgColor,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 'bold' : undefined,
    textDecoration: [fontStyle & 4 ? 'underline' : '', fontStyle & 8 ? 'line-through' : '']
      .filter(Boolean)
      .join(' ') || undefined,
  };
}

function CodeLines({
  code,
  tokens,
  showLineNumbers,
  startingLineNumber,
  wrapLongLines,
  lineNumberStyle,
}: {
  code: string;
  tokens: ThemedLines | null;
  showLineNumbers: boolean;
  startingLineNumber: number;
  wrapLongLines: boolean;
  lineNumberStyle?: CSSProperties;
}) {
  const plainLines = code.split('\n');
  return (
    <>
      {plainLines.map((line, index) => (
        <span className="table-row" key={index}>
          {showLineNumbers && (
            <span
              className="table-cell min-w-10 select-none pr-4 text-right"
              aria-hidden="true"
              style={lineNumberStyle}
            >
              {startingLineNumber + index}
            </span>
          )}
          <span className={`table-cell ${wrapLongLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>
            {tokens?.[index]
              ? tokens[index].map((token, tokenIndex) => (
                  <span key={`${token.offset}-${tokenIndex}`} style={tokenStyle(token)}>{token.content}</span>
                ))
              : line}
          </span>
        </span>
      ))}
    </>
  );
}

const ShikiCodeBlock = memo(function ShikiCodeBlock({
  code,
  language,
  showLineNumbers = false,
  startingLineNumber = 1,
  wrapLongLines = false,
  customStyle,
  lineNumberStyle,
  codeTagProps,
  className,
}: ShikiCodeBlockProps) {
  const theme = useShikiTheme();
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language: string;
    theme: ShikiThemeName;
    tokens: ThemedLines | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    const timer = globalThis.setTimeout(() => {
      void highlightCode(code, language, theme).then((tokens) => {
        if (active) setHighlighted({ code, language, theme, tokens });
      });
    }, HIGHLIGHT_SETTLE_MS);
    return () => {
      active = false;
      globalThis.clearTimeout(timer);
    };
  }, [code, language, theme]);

  const tokens = highlighted?.code === code
    && highlighted.language === language
    && highlighted.theme === theme
    ? highlighted.tokens
    : null;

  return (
    <pre
      className={className}
      data-code-preview={tokens ? 'shiki' : 'plain'}
      style={{ margin: 0, background: 'transparent', ...customStyle }}
    >
      <code
        className="block font-mono"
        {...codeTagProps}
        style={{ background: 'transparent', ...codeTagProps?.style }}
      >
        <CodeLines
          code={code}
          tokens={tokens}
          showLineNumbers={showLineNumbers}
          startingLineNumber={startingLineNumber}
          wrapLongLines={wrapLongLines}
          lineNumberStyle={lineNumberStyle}
        />
      </code>
    </pre>
  );
});

export default ShikiCodeBlock;
