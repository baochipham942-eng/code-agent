import { describe, expect, it } from 'vitest';
import { maskArtifactSource } from '../../../../../src/host/agent/runtime/game/artifactSourceMask';

const META_ASSIGN = /window\.__GAME_META__\s*=\s*\{/;
const KEYDOWN = /\bkeydown\b/;

function htmlWithScript(body: string): string {
  return `<!doctype html><html><body><canvas></canvas><script>\n${body}\n</script></body></html>`;
}

describe('maskArtifactSource', () => {
  it('preserves length and newline positions', () => {
    const source = htmlWithScript('const a = 1;\n// comment\nconst b = 2;');
    const masked = maskArtifactSource(source, 'comments');
    expect(masked.length).toBe(source.length);
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === '\n') expect(masked[index]).toBe('\n');
    }
  });

  it('strips JS line comments so a commented contract assignment does not match', () => {
    const source = htmlWithScript('// window.__GAME_META__ = {\nconst paddle = 1;');
    expect(META_ASSIGN.test(source)).toBe(true);
    expect(META_ASSIGN.test(maskArtifactSource(source, 'comments'))).toBe(false);
    expect(maskArtifactSource(source, 'comments')).toContain('const paddle = 1;');
  });

  it('strips JS block comments', () => {
    const source = htmlWithScript('/* window.__GAME_META__ = { */\nconst paddle = 1;');
    expect(META_ASSIGN.test(source)).toBe(true);
    expect(META_ASSIGN.test(maskArtifactSource(source, 'comments'))).toBe(false);
  });

  it('strips HTML comments including a fake canvas tag', () => {
    const source = '<!doctype html><!-- <canvas id="game"></canvas> --><html><body></body></html>';
    expect(/<canvas\b/i.test(source)).toBe(true);
    expect(/<canvas\b/i.test(maskArtifactSource(source, 'comments'))).toBe(false);
  });

  it('does not treat // inside a string as a comment', () => {
    const source = htmlWithScript("const url = 'http://example.com/window.__GAME_META__';\nconst live = 1;");
    const masked = maskArtifactSource(source, 'comments');
    expect(masked).toContain('const live = 1;');
    expect(masked).toContain('http://example.com/window.__GAME_META__');
  });

  it('comments-and-js-strings blanks a string that only fakes the assignment', () => {
    const source = htmlWithScript('const fake = "window.__GAME_META__ = {";\nconst paddle = 1;');
    expect(META_ASSIGN.test(source)).toBe(true);
    expect(META_ASSIGN.test(maskArtifactSource(source, 'comments'))).toBe(true);
    expect(META_ASSIGN.test(maskArtifactSource(source, 'comments-and-js-strings'))).toBe(false);
    expect(maskArtifactSource(source, 'comments-and-js-strings')).toContain('const paddle = 1;');
  });

  it('keeps keydown inside addEventListener on the comments view and blanks it on the string view', () => {
    const source = htmlWithScript("document.addEventListener('keydown', handler);");
    expect(KEYDOWN.test(maskArtifactSource(source, 'comments'))).toBe(true);
    expect(KEYDOWN.test(maskArtifactSource(source, 'comments-and-js-strings'))).toBe(false);
  });

  it('does not end a script at </script> that lives inside a string', () => {
    const source = htmlWithScript("const html = '</script>';\nwindow.__GAME_META__ = {\n  ok: true\n};");
    expect(META_ASSIGN.test(maskArtifactSource(source, 'comments'))).toBe(true);
    expect(META_ASSIGN.test(maskArtifactSource(source, 'comments-and-js-strings'))).toBe(true);
  });

  it('leaves application/json script bodies intact even in string mode', () => {
    const source = [
      '<!doctype html><html><body>',
      '<script type="application/json" id="game-meta">{"domain":"game","levels":[]}</script>',
      '</body></html>',
    ].join('');
    const masked = maskArtifactSource(source, 'comments-and-js-strings');
    expect(masked).toContain('"domain":"game"');
    expect(masked).toContain('"levels":[]');
  });

  it('masks CSS comments so overflow:hidden in a comment is not a cropping signal', () => {
    const source = '<!doctype html><html><head><style>/* overflow: hidden */ canvas{width:100%}</style></head></html>';
    expect(/\boverflow\s*:\s*hidden\b/i.test(source)).toBe(true);
    expect(/\boverflow\s*:\s*hidden\b/i.test(maskArtifactSource(source, 'comments'))).toBe(false);
    expect(maskArtifactSource(source, 'comments')).toContain('canvas{width:100%}');
  });

  it('scans template literal expressions so comments inside ${} are stripped', () => {
    const source = htmlWithScript('const x = `n=${1 + 2 /* window.__GAME_META__ = { */}`;\nconst paddle = 1;');
    expect(META_ASSIGN.test(source)).toBe(true);
    expect(META_ASSIGN.test(maskArtifactSource(source, 'comments'))).toBe(false);
    expect(maskArtifactSource(source, 'comments')).toContain('const paddle = 1;');
  });
});
