import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { cleanToolResultDisplayText } from '../../../src/renderer/utils/toolResultDisplayText';
import {
  GLOB_EMPTY_PAGE_RESULT,
  GLOB_NO_MATCH_RESULT,
  GLOB_PAGED_RESULT,
  GREP_COMPLETE_RESULT,
  GREP_NO_MATCH_RESULT,
  GREP_PAGED_RESULT,
  LIST_DIRECTORY_EMPTY_RESULT,
  LIST_DIRECTORY_PAGED_RESULT,
  RAW_READ_RESULT,
  READ_RESULT_BODY,
} from '../../fixtures/toolResultDisplayText';

const zhCopy = zh.rendererHumanPipe.toolDetails;
const enCopy = en.rendererHumanPipe.toolDetails;

describe('tool result display text', () => {
  it('removes only the digest line and document-evidence tail from real-shape Read output', () => {
    expect(cleanToolResultDisplayText('Read', RAW_READ_RESULT, enCopy)).toBe(READ_RESULT_BODY);
    expect(cleanToolResultDisplayText('read_file', RAW_READ_RESULT, enCopy)).toBe(READ_RESULT_BODY);
  });

  it('localizes real-shape Glob and ListDirectory empty results', () => {
    expect(cleanToolResultDisplayText('Glob', GLOB_NO_MATCH_RESULT, enCopy)).toBe('No matching files.');
    expect(cleanToolResultDisplayText('glob', GLOB_EMPTY_PAGE_RESULT, zhCopy)).toBe('没有匹配的文件。');
    expect(cleanToolResultDisplayText('ListDirectory', LIST_DIRECTORY_EMPTY_RESULT, enCopy))
      .toBe('This folder is empty.');
  });

  it('humanizes pagination and drops only discovery next-read hints', () => {
    expect(cleanToolResultDisplayText('Glob', GLOB_PAGED_RESULT, enCopy)).toBe(
      GLOB_PAGED_RESULT
        .replace('nextOffset: 2', 'More results are available.')
        .replace('\n[next-read] Before Edit or overwrite Write on any search result path, call Read on that exact file first.', ''),
    );
    expect(cleanToolResultDisplayText('list_directory', LIST_DIRECTORY_PAGED_RESULT, zhCopy)).toBe(
      LIST_DIRECTORY_PAGED_RESULT
        .replace('nextOffset: 2', '还有更多结果可查看。')
        .replace('\n[next-read] Before Edit or overwrite Write on any listed file path, call Read on that exact file first.', ''),
    );
    expect(cleanToolResultDisplayText('Grep', GREP_PAGED_RESULT, enCopy)).toBe(
      GREP_PAGED_RESULT.replace('nextOffset: 1', 'More results are available.'),
    );
    expect(cleanToolResultDisplayText('grep', GREP_COMPLETE_RESULT, enCopy)).toBe('src/a.ts:1:alpha');
    expect(cleanToolResultDisplayText('grep', GREP_NO_MATCH_RESULT, enCopy)).toBe(GREP_NO_MATCH_RESULT);
  });

  it('passes unrelated text through byte-for-byte and refuses an empty cleaned body', () => {
    const unrelated = 'Read version digest: not-a-hex-digest\r\nbody\r\n';
    expect(cleanToolResultDisplayText('Bash', RAW_READ_RESULT, enCopy)).toBe(RAW_READ_RESULT);
    expect(cleanToolResultDisplayText('Read', unrelated, enCopy)).toBe(unrelated);
    expect(cleanToolResultDisplayText('Read', 'Read version digest: 0123456789abcdef\n', enCopy))
      .toBe('Read version digest: 0123456789abcdef\n');
  });

  it('uses the cleaner at the expanded ToolDetails render site', () => {
    const html = renderToStaticMarkup(
      <ToolDetails
        toolCall={{
          id: 'read-fixture',
          name: 'Read',
          arguments: { file_path: '/tmp/notes.txt' },
          result: { toolCallId: 'read-fixture', success: true, output: RAW_READ_RESULT },
        }}
      />,
    );

    expect(html).toContain('first line');
    expect(html).toContain('second line');
    expect(html).not.toContain('Read version digest:');
    expect(html).not.toContain('document-evidence');
  });
});
