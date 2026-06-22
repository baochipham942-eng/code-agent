import { describe, it, expect } from 'vitest';
import {
  serializeCanvasDoc,
  deserializeCanvasDoc,
  isVideoNode,
  isImageNode,
  formatDurationLabel,
  type CanvasVideoNode,
  type CanvasImageNode,
  type DesignCanvasDoc,
} from '../../../src/renderer/components/design/designCanvasTypes';

const imageNode: CanvasImageNode = { id: 'i1', src: 'assets/a.png', x: 0, y: 0, width: 100, height: 100, createdAt: 1 };
const videoNode: CanvasVideoNode = {
  id: 'v1', kind: 'video', src: 'assets/v.mp4', x: 10, y: 0, width: 320, height: 180,
  durationSec: 5, prompt: '猫', parentId: 'i1', costCny: 3.5, createdAt: 2,
};

describe('CanvasVideoNode 序列化', () => {
  it('图+视频混合文档 round-trip 保真', () => {
    const doc: DesignCanvasDoc = { version: 1, nodes: [imageNode, videoNode], camera: { x: 0, y: 0, scale: 1 } };
    const back = deserializeCanvasDoc(serializeCanvasDoc(doc));
    expect(back.nodes).toHaveLength(2);
    const v = back.nodes.find((n) => n.id === 'v1');
    expect(v && isVideoNode(v)).toBe(true);
    expect((v as CanvasVideoNode).durationSec).toBe(5);
    expect((v as CanvasVideoNode).src).toBe('assets/v.mp4');
    expect((v as CanvasVideoNode).costCny).toBe(3.5);
  });

  it('视频节点缺 durationSec/坏字段安全降级（不崩、durationSec 回退正数）', () => {
    const text = JSON.stringify({ version: 1, nodes: [{ id: 'v2', kind: 'video', src: 'assets/x.mp4', x: 0, y: 0, width: 10, height: 10 }], camera: {} });
    const back = deserializeCanvasDoc(text);
    const v = back.nodes[0] as CanvasVideoNode;
    expect(isVideoNode(v)).toBe(true);
    expect(v.durationSec).toBeGreaterThan(0);
  });

  it('kind 缺失但 src 是 .mp4 → 识别为视频（兼容老/手写数据）', () => {
    const text = JSON.stringify({ version: 1, nodes: [{ id: 'v3', src: 'assets/y.mp4', x: 0, y: 0, width: 10, height: 10, durationSec: 8 }], camera: {} });
    const back = deserializeCanvasDoc(text);
    expect(isVideoNode(back.nodes[0])).toBe(true);
  });

  it('普通图节点仍被 isImageNode 识别（向后兼容）', () => {
    const back = deserializeCanvasDoc(JSON.stringify({ version: 1, nodes: [imageNode], camera: {} }));
    expect(isImageNode(back.nodes[0])).toBe(true);
    expect(isVideoNode(back.nodes[0])).toBe(false);
  });

  it('视频节点负 costCny 被丢弃（防注入压低累计成本）', () => {
    const text = JSON.stringify({ version: 1, nodes: [{ id: 'v4', kind: 'video', src: 'assets/z.mp4', x: 0, y: 0, width: 10, height: 10, durationSec: 5, costCny: -9 }], camera: {} });
    const v = deserializeCanvasDoc(text).nodes[0] as CanvasVideoNode;
    expect(v.costCny).toBeUndefined();
  });
});

describe('formatDurationLabel', () => {
  it('秒数加 s 后缀', () => {
    expect(formatDurationLabel(5)).toBe('5s');
    expect(formatDurationLabel(0)).toBe('0s');
  });
});
