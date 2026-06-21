import { describe, it, expect } from 'vitest';
import { useDesignStore } from '../../../src/renderer/components/design/designStore';

describe('designStore imageModel', () => {
  it('默认 imageModel = wanx-t2i 且可 set', () => {
    expect(useDesignStore.getState().imageModel).toBe('wanx-t2i');
    useDesignStore.getState().setImageModel('cogview-4');
    expect(useDesignStore.getState().imageModel).toBe('cogview-4');
    useDesignStore.getState().setImageModel('wanx-t2i'); // 复位避免污染其它测试
  });
});
