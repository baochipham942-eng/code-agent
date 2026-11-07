export const READ_RESULT_BODY = '     1\tfirst line\n     2\tsecond line';

export const RAW_READ_RESULT = `Read version digest: 0123456789abcdef
${READ_RESULT_BODY}

<document-evidence>{"path":"/tmp/notes.txt","digest":"0123456789abcdef","kind":"unclassified","roots":["/tmp/notes.txt"]}; local file content, source independence unverified</document-evidence>`;

export const GLOB_NO_MATCH_RESULT = 'No files matched the pattern';
export const GLOB_EMPTY_PAGE_RESULT = '(empty page)\n\nnextOffset: null';
export const LIST_DIRECTORY_EMPTY_RESULT = '(empty page)\n\nnextOffset: null';

const ARCHIVE_NOTICE =
  '[Full output saved to: /tmp/tool-results/result.txt — archive=tool_result:fixture; sha256=0123456789ab; bytes=42; use Read/Grep on this file to inspect the full output.]';

export const GLOB_PAGED_RESULT = `src/a.ts
src/b.ts

nextOffset: 2
${ARCHIVE_NOTICE}
[next-read] Before Edit or overwrite Write on any search result path, call Read on that exact file first.`;

export const LIST_DIRECTORY_PAGED_RESULT = `📁 src/
📄 README.md (42B)

nextOffset: 2
${ARCHIVE_NOTICE}
[next-read] Before Edit or overwrite Write on any listed file path, call Read on that exact file first.`;

export const GREP_PAGED_RESULT = `src/a.ts:1:alpha

(showing 1-1 of 2 matches)
nextOffset: 1`;
