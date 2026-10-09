import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const COMPONENTS = path.join(ROOT, 'src/renderer/components');
const RENDERER = path.join(ROOT, 'src/renderer');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

// 组件里禁止拿披露级别字面量做行为分支（=== 'simple' 这种）。选项 id 不算比较。
const DISCLOSURE_ENUM_COMPARE = /(?:disclosureLevel|DisclosureLevel)\s*(?:===|!==|==|!=)\s*['"](?:simple|standard|advanced|expert)['"]|['"](?:simple|standard|advanced|expert)['"]\s*(?:===|!==|==|!=)\s*(?:disclosureLevel|DisclosureLevel)/;
const LEVEL_LITERAL_COMPARE = /(?:===|!==|==|!=)\s*['"](?:simple|standard|advanced|expert)['"]|['"](?:simple|standard|advanced|expert)['"]\s*(?:===|!==|==|!=)/;

describe('disclosure enum stays out of components', () => {
  it('no component compares the disclosure enum literals', () => {
    const hits: string[] = [];
    for (const file of walk(COMPONENTS)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      const mentionsDisclosure = /disclosureLevel|DisclosureLevel|useWorkDetailPolicy|useDisclosure/.test(source);
      if (DISCLOSURE_ENUM_COMPARE.test(source) || (mentionsDisclosure && LEVEL_LITERAL_COMPARE.test(source))) {
        hits.push(path.relative(ROOT, file));
      }
    }
    expect(hits).toEqual([]);
  });

  it('only workDetailPolicy.ts maps a level onto chat process behaviour', () => {
    const hits: string[] = [];
    for (const file of walk(RENDERER)) {
      const source = readFileSync(file, 'utf8');
      const hasLevels = ['simple', 'standard', 'advanced', 'expert'].every((level) => (
        source.includes(`'${level}'`) || source.includes(`"${level}"`)
      ));
      const hasBehaviour = source.includes('foldThreshold')
        && source.includes('toolGroupDefaultExpanded')
        && source.includes('showThinkingDigest');
      if (hasLevels && hasBehaviour) hits.push(path.relative(ROOT, file));
    }
    expect(hits).toEqual(['src/renderer/utils/workDetailPolicy.ts']);
  });
});
