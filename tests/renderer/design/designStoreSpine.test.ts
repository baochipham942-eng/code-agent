import { describe, expect, it, beforeEach } from 'vitest';
import { useDesignStore } from '../../../src/renderer/components/design/designStore';
import {
  emptySpine,
  appendVariant,
  type VariantSpine,
} from '../../../src/renderer/components/design/variantSpine';
import { makeProtoVariant } from '../../../src/renderer/components/design/variantAdapters';

const spineWith = (runDir: string): VariantSpine =>
  appendVariant(emptySpine(), makeProtoVariant(`${runDir}/versions/v-1.html`, 1, runDir));

describe('designStore variant spine 集成', () => {
  beforeEach(() => {
    useDesignStore.getState().reset();
    useDesignStore.getState().setSpine(emptySpine());
  });

  it('默认 spine 为空', () => {
    expect(useDesignStore.getState().spine).toEqual(emptySpine());
  });

  it('setSpine 写入；selectRun 切换 run 时清空 spine（避免串台）', () => {
    useDesignStore.getState().setSpine(spineWith('/d/run-1'));
    expect(useDesignStore.getState().spine.variants).toHaveLength(1);
    useDesignStore.getState().selectRun('/d/run-2');
    expect(useDesignStore.getState().spine).toEqual(emptySpine());
  });

  it('reset 清空 spine', () => {
    useDesignStore.getState().setSpine(spineWith('/d/run-1'));
    useDesignStore.getState().reset();
    expect(useDesignStore.getState().spine).toEqual(emptySpine());
  });
});
