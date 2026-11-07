interface ToolResultDisplayCopy {
  globEmpty: string;
  directoryEmpty: string;
  moreResultsAvailable: string;
}

const READ_TOOL_NAMES = new Set(['read', 'readfile', 'readdocument']);
const GLOB_TOOL_NAMES = new Set(['glob']);
const DIRECTORY_TOOL_NAMES = new Set(['listdirectory']);
const GREP_TOOL_NAMES = new Set(['grep']);

const READ_DIGEST_LINE = /^Read version digest: [a-f0-9]+\r?\n/i;
const DOCUMENT_EVIDENCE_TAIL =
  /(?:\r?\n){2}<document-evidence>[^\r\n]*<\/document-evidence>[ \t]*$/;
const NEXT_READ_HINT_LINE = /(?:\r?\n)?\[next-read\][^\r\n]*(?=\r?\n|$)/g;
const NEXT_OFFSET_TAIL =
  /(\r?\n(?:\r?\n)?)nextOffset: (null|\d+)(?=(?:\r?\n\[Full output saved to:[^\r\n]*)?(?:\r?\n\r?\n\[partial\][\s\S]*)?$)/;

function normalizedToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[_-]/g, '');
}

function cleanReadText(text: string): string {
  return text.replace(READ_DIGEST_LINE, '').replace(DOCUMENT_EVIDENCE_TAIL, '');
}

function cleanPaginationText(
  text: string,
  copy: ToolResultDisplayCopy,
  removeNextReadHint: boolean,
): string {
  const withoutHint = removeNextReadHint ? text.replace(NEXT_READ_HINT_LINE, '') : text;
  return withoutHint.replace(NEXT_OFFSET_TAIL, (_match, separator: string, offset: string) => (
    offset === 'null' ? '' : `${separator}${copy.moreResultsAvailable}`
  ));
}

/** Keeps model-facing tool output intact while hiding its internal protocol markers in the expanded card. */
export function cleanToolResultDisplayText(
  toolName: string,
  text: string,
  copy: ToolResultDisplayCopy,
): string {
  const normalizedName = normalizedToolName(toolName);
  let cleaned = text;

  if (READ_TOOL_NAMES.has(normalizedName)) {
    cleaned = cleanReadText(text);
  } else if (GLOB_TOOL_NAMES.has(normalizedName)) {
    cleaned = cleanPaginationText(text, copy, true);
    if (cleaned === 'No files matched the pattern' || cleaned === '(empty page)') {
      cleaned = copy.globEmpty;
    }
  } else if (DIRECTORY_TOOL_NAMES.has(normalizedName)) {
    cleaned = cleanPaginationText(text, copy, true);
    if (cleaned === '(empty page)') cleaned = copy.directoryEmpty;
  } else if (GREP_TOOL_NAMES.has(normalizedName)) {
    cleaned = cleanPaginationText(text, copy, false);
  }

  return text.length > 0 && cleaned.length === 0 ? text : cleaned;
}
