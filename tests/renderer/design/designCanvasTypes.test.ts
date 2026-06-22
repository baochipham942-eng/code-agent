import { describe, expect, it } from 'vitest';
import {
  emptyCanvasDoc,
  serializeCanvasDoc,
  deserializeCanvasDoc,
  nextNodePlacement,
  isReferenceNode,
  DEFAULT_CAMERA,
  type CanvasImageNode,
  type DesignCanvasDoc,
} from '../../../src/renderer/components/design/designCanvasTypes';

const node = (over: Partial<CanvasImageNode> = {}): CanvasImageNode => ({
  id: 'n1',
  src: 'assets/gen-1.png',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  createdAt: 1,
  ...over,
});

describe('emptyCanvasDoc', () => {
  it('版本/空节点/默认相机', () => {
    const d = emptyCanvasDoc();
    expect(d.version).toBe(1);
    expect(d.nodes).toEqual([]);
    expect(d.camera).toEqual(DEFAULT_CAMERA);
  });
});

describe('serialize/deserialize round-trip', () => {
  it('完整文档往返不丢字段（含 chosen 主版）', () => {
    const doc: DesignCanvasDoc = {
      version: 1,
      nodes: [node({ prompt: '改成黄昏', parentId: 'n0', chosen: true })],
      camera: { x: 12, y: -8, scale: 1.5 },
    };
    const back = deserializeCanvasDoc(serializeCanvasDoc(doc));
    expect(back).toEqual(doc);
  });

  it('chosen 非 true 不落字段（保持紧凑）', () => {
    const back = deserializeCanvasDoc(
      JSON.stringify({ nodes: [{ ...node(), chosen: false }], camera: DEFAULT_CAMERA }),
    );
    expect(back.nodes[0].chosen).toBeUndefined();
  });
});

describe('deserializeCanvasDoc 容错', () => {
  it('null/空串 → 空文档', () => {
    expect(deserializeCanvasDoc(null)).toEqual(emptyCanvasDoc());
    expect(deserializeCanvasDoc('')).toEqual(emptyCanvasDoc());
  });

  it('破损 JSON → 空文档，不抛', () => {
    expect(deserializeCanvasDoc('{not json')).toEqual(emptyCanvasDoc());
  });

  it('过滤非法节点（缺 src / 坐标非数字）', () => {
    const text = JSON.stringify({
      nodes: [
        node(),
        { id: 'bad', x: 0, y: 0, width: 1, height: 1 }, // 缺 src
        { id: 'bad2', src: 'a.png', x: 'NaN', y: 0, width: 1, height: 1 }, // x 非数字
      ],
      camera: DEFAULT_CAMERA,
    });
    const d = deserializeCanvasDoc(text);
    expect(d.nodes).toHaveLength(1);
    expect(d.nodes[0].id).toBe('n1');
  });

  it('scale<=0 回退到 1，防画布塌缩', () => {
    const text = JSON.stringify({ nodes: [], camera: { x: 0, y: 0, scale: 0 } });
    expect(deserializeCanvasDoc(text).camera.scale).toBe(1);
  });
});

describe('nextNodePlacement', () => {
  it('空画布落原点', () => {
    expect(nextNodePlacement([], 60)).toEqual({ x: 0, y: 0 });
  });

  it('放在最右节点右侧 +gap，沿用其 y', () => {
    const nodes = [node({ x: 0, width: 100, y: 0 }), node({ id: 'n2', x: 200, width: 100, y: 30 })];
    expect(nextNodePlacement(nodes, 60)).toEqual({ x: 360, y: 30 });
  });
});

describe('CanvasImageNode 反序列化 label / costCny（T2）', () => {
  it('保留 label 与 costCny，类型不符则丢弃', () => {
    const doc = deserializeCanvasDoc(
      JSON.stringify({
        version: 1,
        camera: DEFAULT_CAMERA,
        nodes: [
          { id: 'a', src: 'a.png', x: 0, y: 0, width: 1, height: 1, createdAt: 1, label: '命名步', costCny: 0.14 },
          { id: 'b', src: 'b.png', x: 0, y: 0, width: 1, height: 1, createdAt: 1, label: 123, costCny: 'x' },
        ],
      }),
    );
    expect(doc.nodes[0].label).toBe('命名步');
    expect(doc.nodes[0].costCny).toBe(0.14);
    expect(doc.nodes[1].label).toBeUndefined();
    expect(doc.nodes[1].costCny).toBeUndefined();
  });
});

describe('role 参考/产物角色（P0 统一画布）', () => {
  it('role=reference 序列化往返保留', () => {
    const doc: DesignCanvasDoc = {
      version: 1,
      nodes: [node({ role: 'reference' })],
      camera: DEFAULT_CAMERA,
    };
    const back = deserializeCanvasDoc(serializeCanvasDoc(doc));
    expect(back.nodes[0].role).toBe('reference');
  });

  it('role 缺省（产物）不落字段保持紧凑', () => {
    const back = deserializeCanvasDoc(
      JSON.stringify({ nodes: [{ ...node(), role: 'output' }], camera: DEFAULT_CAMERA }),
    );
    expect(back.nodes[0].role).toBeUndefined();
  });

  it('非法 role 值丢弃（防破损 canvas.json 注入）', () => {
    const back = deserializeCanvasDoc(
      JSON.stringify({ nodes: [{ ...node(), role: 'garbage' }], camera: DEFAULT_CAMERA }),
    );
    expect(back.nodes[0].role).toBeUndefined();
  });

  it('isReferenceNode：仅 role=reference 为真', () => {
    expect(isReferenceNode(node({ role: 'reference' }))).toBe(true);
    expect(isReferenceNode(node({ role: 'output' }))).toBe(false);
    expect(isReferenceNode(node())).toBe(false);
  });
});

describe('costCny 负值防注入（codex/gemini 审计 MED）', () => {
  it('负成本被拒（防手改 canvas.json 压低累计花费，破坏 BYOK 信任）', () => {
    const doc = deserializeCanvasDoc(
      JSON.stringify({
        version: 1,
        camera: DEFAULT_CAMERA,
        nodes: [
          { id: 'a', src: 'a.png', x: 0, y: 0, width: 1, height: 1, createdAt: 1, costCny: -100 },
          { id: 'b', src: 'b.png', x: 0, y: 0, width: 1, height: 1, createdAt: 1, costCny: 0 },
        ],
      }),
    );
    expect(doc.nodes[0].costCny).toBeUndefined(); // 负值丢弃
    expect(doc.nodes[1].costCny).toBe(0); // 0(免费)合法保留
  });
});
