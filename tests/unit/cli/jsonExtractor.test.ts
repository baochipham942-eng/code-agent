import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractJSON } from '../../../src/cli/utils/jsonExtractor';

describe('CLI jsonExtractor', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-extractor-test-'));
    tempDirs.push(dir);
    return dir;
  }

  it('prefers fenced json blocks over surrounding prose', () => {
    expect(extractJSON('done\n```json\n{"ok":true,"items":[1,2]}\n```')).toEqual({
      ok: true,
      items: [1, 2],
    });
  });

  it('parses whole-text json objects and arrays', () => {
    expect(extractJSON('{"name":"neo"}')).toEqual({ name: 'neo' });
    expect(extractJSON('[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('extracts embedded object or array payloads from prose', () => {
    expect(extractJSON('Use this payload: {"status":"ok"} thanks')).toEqual({ status: 'ok' });
    expect(extractJSON('Result list: [{"id":"a"},{"id":"b"}].')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('falls back to referenced json files in projectDir order', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ fromFile: true }));

    expect(extractJSON('See bad.json then `good.json`', dir)).toEqual({ fromFile: true });
  });

  it('returns null when no strategy yields valid json', () => {
    expect(extractJSON('no structured payload here')).toBeNull();
    expect(extractJSON('')).toBeNull();
  });
});
