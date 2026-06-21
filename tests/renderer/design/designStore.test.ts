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

describe('designStore 标注模式', () => {
  it('annotMode 默认关、annotInstruction 默认空，可 set', () => {
    const s = useDesignStore.getState();
    expect(s.annotMode).toBe(false);
    expect(s.annotInstruction).toBe('');
    s.setAnnotMode(true); s.setAnnotInstruction('改成绿色');
    expect(useDesignStore.getState().annotMode).toBe(true);
    expect(useDesignStore.getState().annotInstruction).toBe('改成绿色');
    s.setAnnotMode(false); s.setAnnotInstruction(''); // 复位，避免污染其它测试
  });
});
