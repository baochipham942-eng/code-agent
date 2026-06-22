import { describe, expect, it } from 'vitest';
import {
  brandContractToBriefProjection,
  normalizeBrandContract,
  type BrandContract,
} from '../../../src/shared/contract/brandContract';
import { directionTokens } from '../../../src/design/direction-tokens';

const validInput = {
  id: 'porsche-abc123',
  name: 'Porsche 数字化',
  tokens: directionTokens.premium,
  keep: ['  克制留白 ', '克制留白', ''],
  change: ['主色可浮动'],
  doNotCopy: ['  不要渐变按钮 ', '不要 emoji 图标'],
  source: 'manual' as const,
  createdAt: 1000,
  updatedAt: 2000,
};

describe('normalizeBrandContract', () => {
  it('normalizes a valid contract: trims + dedupes string arrays, keeps tokens', () => {
    const brand = normalizeBrandContract(validInput);
    expect(brand).toBeDefined();
    expect(brand?.id).toBe('porsche-abc123');
    expect(brand?.name).toBe('Porsche 数字化');
    expect(brand?.tokens).toEqual(directionTokens.premium);
    expect(brand?.keep).toEqual(['克制留白']);
    expect(brand?.change).toEqual(['主色可浮动']);
    expect(brand?.doNotCopy).toEqual(['不要渐变按钮', '不要 emoji 图标']);
    expect(brand?.source).toBe('manual');
    expect(brand?.createdAt).toBe(1000);
    expect(brand?.updatedAt).toBe(2000);
  });

  it('returns undefined for non-object / null / array', () => {
    expect(normalizeBrandContract(null)).toBeUndefined();
    expect(normalizeBrandContract(undefined)).toBeUndefined();
    expect(normalizeBrandContract('x')).toBeUndefined();
    expect(normalizeBrandContract([])).toBeUndefined();
  });

  it('requires id and name', () => {
    expect(normalizeBrandContract({ ...validInput, id: '   ' })).toBeUndefined();
    expect(normalizeBrandContract({ ...validInput, name: '' })).toBeUndefined();
    const { name, ...noName } = validInput;
    expect(normalizeBrandContract(noName)).toBeUndefined();
  });

  it('rejects invalid / incomplete tokens (same rules as designBrief directionTokens)', () => {
    // missing accent in palette
    expect(
      normalizeBrandContract({
        ...validInput,
        tokens: {
          ...directionTokens.premium,
          palette: { ...directionTokens.premium.palette, accent: '' },
        },
      }),
    ).toBeUndefined();
    // missing tokens entirely
    const { tokens, ...noTokens } = validInput;
    expect(normalizeBrandContract(noTokens)).toBeUndefined();
    // tokens not an object
    expect(normalizeBrandContract({ ...validInput, tokens: 'nope' })).toBeUndefined();
  });

  it('defaults empty arrays when buckets are missing or all-blank', () => {
    const brand = normalizeBrandContract({
      id: 'min-1',
      name: '极简',
      tokens: directionTokens.calm,
    });
    expect(brand?.keep).toEqual([]);
    expect(brand?.change).toEqual([]);
    expect(brand?.doNotCopy).toEqual([]);
    // all-blank arrays collapse to []
    const blank = normalizeBrandContract({
      id: 'min-2',
      name: '空桶',
      tokens: directionTokens.calm,
      keep: ['', '  '],
      doNotCopy: ['   '],
    });
    expect(blank?.keep).toEqual([]);
    expect(blank?.doNotCopy).toEqual([]);
  });

  it('coerces source to manual unless explicitly reference', () => {
    expect(normalizeBrandContract({ ...validInput, source: 'reference' })?.source).toBe('reference');
    expect(normalizeBrandContract({ ...validInput, source: 'whatever' })?.source).toBe('manual');
    const { source, ...noSource } = validInput;
    expect(normalizeBrandContract(noSource)?.source).toBe('manual');
  });

  it('keeps logoPath when present, drops blank', () => {
    expect(normalizeBrandContract({ ...validInput, logoPath: '/x/logo.png' })?.logoPath).toBe('/x/logo.png');
    expect(normalizeBrandContract({ ...validInput, logoPath: '   ' })?.logoPath).toBeUndefined();
  });

  it('defaults timestamps: updatedAt falls back to createdAt, both 0 if absent', () => {
    const brand = normalizeBrandContract({ id: 'a', name: 'b', tokens: directionTokens.calm });
    expect(brand?.createdAt).toBe(0);
    expect(brand?.updatedAt).toBe(0);
    const withCreated = normalizeBrandContract({
      id: 'a',
      name: 'b',
      tokens: directionTokens.calm,
      createdAt: 5,
    });
    expect(withCreated?.updatedAt).toBe(5);
  });
});

describe('brandContractToBriefProjection', () => {
  it('extracts the prompt-relevant slice (keep/change/doNotCopy/logo)', () => {
    const brand = normalizeBrandContract({ ...validInput, logoPath: '/x/logo.png' }) as BrandContract;
    const projection = brandContractToBriefProjection(brand);
    expect(projection).toEqual({
      keep: ['克制留白'],
      change: ['主色可浮动'],
      doNotCopy: ['不要渐变按钮', '不要 emoji 图标'],
      logoPath: '/x/logo.png',
    });
  });

  it('returns fresh array copies (no shared references)', () => {
    const brand = normalizeBrandContract(validInput) as BrandContract;
    const projection = brandContractToBriefProjection(brand);
    expect(projection.keep).not.toBe(brand.keep);
    expect(projection.keep).toEqual(brand.keep);
  });

  it('omits logoPath when absent', () => {
    const brand = normalizeBrandContract(validInput) as BrandContract;
    expect(brandContractToBriefProjection(brand).logoPath).toBeUndefined();
  });
});
