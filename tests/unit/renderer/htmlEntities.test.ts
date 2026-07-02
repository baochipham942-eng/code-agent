import { describe, expect, it } from 'vitest';
import { unescapeHtmlEntities } from '../../../src/renderer/utils/htmlEntities';

describe('unescapeHtmlEntities', () => {
  it('unescapes common html entities from telemetry text', () => {
    expect(unescapeHtmlEntities('&gt; 失败记录 &amp; 提示 &lt;tag&gt; &quot;q&quot; &#39;s&#39;'))
      .toBe('> 失败记录 & 提示 <tag> "q" \'s\'');
  });

  it('returns plain text unchanged', () => {
    expect(unescapeHtmlEntities('normal > text & already fine')).toBe('normal > text & already fine');
  });

  it('unescapes double-escaped amp sequences once per pass', () => {
    expect(unescapeHtmlEntities('&amp;gt;')).toBe('&gt;');
  });
});
