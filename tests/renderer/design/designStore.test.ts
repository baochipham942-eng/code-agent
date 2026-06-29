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

describe('designStore applyDefaultModels（设置页默认 · ADR-027）', () => {
  it('未显式选过时套用设置默认；显式选过后默认不再覆盖', () => {
    // 复位到初始（未选状态）
    useDesignStore.setState({
      imageModel: 'wanx-t2i',
      videoModel: 'wan2.7-t2v',
      imageModelUserPicked: false,
      videoModelUserPicked: false,
    });

    // 未选 → 套用设置默认
    useDesignStore.getState().applyDefaultModels({ image: 'cogview-4', video: 'wanx2.1-i2v-turbo' });
    expect(useDesignStore.getState().imageModel).toBe('cogview-4');
    expect(useDesignStore.getState().videoModel).toBe('wanx2.1-i2v-turbo');
    // applyDefaultModels 不应把 userPicked 置真（它不是用户显式选）
    expect(useDesignStore.getState().imageModelUserPicked).toBe(false);

    // 用户在画布显式选 → 置 userPicked
    useDesignStore.getState().setImageModel('flux-2');
    expect(useDesignStore.getState().imageModelUserPicked).toBe(true);

    // 再套用设置默认 → 图像被显式选过，不覆盖；视频未显式选，仍可被覆盖
    useDesignStore.getState().applyDefaultModels({ image: 'wanx-t2i', video: 'wan2.7-t2v' });
    expect(useDesignStore.getState().imageModel).toBe('flux-2'); // 保持用户选择
    expect(useDesignStore.getState().videoModel).toBe('wan2.7-t2v'); // 视频未锁，被覆盖

    // 复位避免污染其它测试
    useDesignStore.setState({
      imageModel: 'wanx-t2i',
      videoModel: 'wan2.7-t2v',
      imageModelUserPicked: false,
      videoModelUserPicked: false,
    });
  });

  it('undefined 默认值为 no-op（设置页未配置时零行为变更）', () => {
    useDesignStore.setState({ imageModel: 'wanx-t2i', imageModelUserPicked: false });
    useDesignStore.getState().applyDefaultModels({});
    expect(useDesignStore.getState().imageModel).toBe('wanx-t2i');
  });
});

describe('designStore proto 版本对比（P2 统一历史）', () => {
  it('toggleCompareId 选版上限 2、FIFO 顶替、再点取消', () => {
    const s = useDesignStore.getState();
    s.clearCompare();
    s.toggleCompareId('v1');
    expect(useDesignStore.getState().compareIds).toEqual(['v1']);
    s.toggleCompareId('v2');
    expect(useDesignStore.getState().compareIds).toEqual(['v1', 'v2']);
    // 第三个：FIFO 顶替最旧（保留 v2 + 新的 v3）
    s.toggleCompareId('v3');
    expect(useDesignStore.getState().compareIds).toEqual(['v2', 'v3']);
    // 再点 v2 取消
    s.toggleCompareId('v2');
    expect(useDesignStore.getState().compareIds).toEqual(['v3']);
    s.clearCompare();
  });

  it('startEditing 清空对比状态（与 selectRun/startGenerating 对称，审计 MED#3）', () => {
    const s = useDesignStore.getState();
    s.toggleCompareId('a');
    s.setComparing(true);
    s.startEditing('/d/run-x');
    expect(useDesignStore.getState().compareIds).toEqual([]);
    expect(useDesignStore.getState().comparing).toBe(false);
    s.reset();
  });

  it('clearCompare 清空选版 + 关对比浮层', () => {
    const s = useDesignStore.getState();
    s.toggleCompareId('a');
    s.setComparing(true);
    s.clearCompare();
    expect(useDesignStore.getState().compareIds).toEqual([]);
    expect(useDesignStore.getState().comparing).toBe(false);
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

  it('annotModel 默认空（未选，组件经 cap 解析默认）、可 set，且与全局 imageModel 解耦', () => {
    const s = useDesignStore.getState();
    expect(s.annotModel).toBe('');
    s.setAnnotModel('flux-kontext');
    expect(useDesignStore.getState().annotModel).toBe('flux-kontext');
    // 解耦：改 annotModel 不动全局 imageModel（文生图默认）。
    expect(useDesignStore.getState().imageModel).toBe('wanx-t2i');
    s.setAnnotModel(''); // 复位，避免污染其它测试
  });
});
