// react-konva 在系统 Node（vitest environment=node，无 canvas 原生模块）下
// import 即崩（konva/lib/index-node.js → require('canvas')）。
// 与 keytar 同理用轻量 mock 兜底：组件渲染成同名 stub，纯逻辑（reduceAnnot）不受影响。
import React from 'react';

const stub = (name: string): React.FC<Record<string, unknown>> => {
  const Comp: React.FC<Record<string, unknown>> = (props) =>
    React.createElement(name, props as Record<string, unknown>);
  Comp.displayName = name;
  return Comp;
};

export const Stage = stub('Stage');
export const Layer = stub('Layer');
export const Group = stub('Group');
export const Line = stub('Line');
export const Arrow = stub('Arrow');
export const Rect = stub('Rect');
export const Text = stub('Text');
export const Image = stub('Image');
