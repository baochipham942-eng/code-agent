// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAppStore, type DisclosureLevel } from '../../../src/renderer/stores/appStore';
import { useWorkDetailPolicy } from '../../../src/renderer/utils/workDetailPolicy';

const TODAY = {
  foldThreshold: 5,
  toolGroupDefaultExpanded: false,
  showThinkingDigest: true,
};

const EXPECTED: Record<DisclosureLevel, typeof TODAY> = {
  simple: { foldThreshold: 2, toolGroupDefaultExpanded: false, showThinkingDigest: false },
  standard: TODAY,
  advanced: { foldThreshold: Infinity, toolGroupDefaultExpanded: false, showThinkingDigest: true },
  expert: { foldThreshold: Infinity, toolGroupDefaultExpanded: true, showThinkingDigest: true },
};

describe('workDetailPolicy', () => {
  afterEach(() => {
    useAppStore.setState({ disclosureLevel: 'standard' });
  });

  it('standard equals today: fold at 5, tool groups collapsed, thinking digest shown', () => {
    useAppStore.setState({ disclosureLevel: 'standard' });
    const { result } = renderHook(() => useWorkDetailPolicy());
    expect(result.current).toEqual(TODAY);
  });

  it.each(Object.entries(EXPECTED) as Array<[DisclosureLevel, typeof TODAY]>)(
    '%s exposes foldThreshold, toolGroupDefaultExpanded, and showThinkingDigest',
    (level, expected) => {
      useAppStore.setState({ disclosureLevel: level });
      const { result } = renderHook(() => useWorkDetailPolicy());
      expect(result.current.foldThreshold).toBe(expected.foldThreshold);
      expect(result.current.toolGroupDefaultExpanded).toBe(expected.toolGroupDefaultExpanded);
      expect(result.current.showThinkingDigest).toBe(expected.showThinkingDigest);
    },
  );
});
