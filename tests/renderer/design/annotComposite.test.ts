import { composeAnnotOps } from '../../../src/renderer/components/design/annotComposite';
import type { AnnotShape } from '../../../src/renderer/components/design/AnnotationLayer';

describe('composeAnnotOps 坐标换算', () => {
  it('显示512→原图1024 时 rect 坐标×2', () => {
    const ops = composeAnnotOps({ naturalW: 1024, naturalH: 1024, displayW: 512, displayH: 512,
      shapes: [{ kind: 'rect', x: 10, y: 10, w: 20, h: 20, color: '#ef4444' }] });
    expect(ops[0]).toMatchObject({ kind: 'rect', x: 20, y: 20, w: 40, h: 40, color: '#ef4444' });
  });

  it('pen 每个点按轴向缩放（x×2,y×3）', () => {
    const ops = composeAnnotOps({ naturalW: 200, naturalH: 300, displayW: 100, displayH: 100,
      shapes: [{ kind: 'pen', points: [1, 1, 2, 2], color: '#ef4444' }] });
    expect((ops[0] as any).points).toEqual([2, 3, 4, 6]);
  });

  it('arrow 四点按轴向缩放', () => {
    const ops = composeAnnotOps({ naturalW: 200, naturalH: 200, displayW: 100, displayH: 100,
      shapes: [{ kind: 'arrow', points: [0, 0, 5, 6], color: '#ef4444' }] });
    expect((ops[0] as any).points).toEqual([0, 0, 10, 12]);
  });

  it('text 坐标缩放，文字与颜色不变', () => {
    const ops = composeAnnotOps({ naturalW: 200, naturalH: 200, displayW: 100, displayH: 100,
      shapes: [{ kind: 'text', x: 3, y: 4, text: '改这里', color: '#ef4444' }] });
    expect(ops[0]).toMatchObject({ kind: 'text', x: 6, y: 8, text: '改这里', color: '#ef4444' });
  });

  it('不可变：不改输入 shapes', () => {
    const shapes: AnnotShape[] = [{ kind: 'rect', x: 1, y: 1, w: 1, h: 1, color: '#ef4444' }];
    composeAnnotOps({ naturalW: 2, naturalH: 2, displayW: 1, displayH: 1, shapes });
    expect((shapes[0] as any).x).toBe(1); // 原数组未变
  });
});
