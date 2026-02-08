/**
 * Mermaid → Native Shapes 转换器
 *
 * 将 Mermaid flowchart 语法解析为结构化数据，
 * 然后用 pptxgenjs 原生形状渲染，实现：
 * - 内容灵活（AI 动态生成 Mermaid）
 * - 样式可控（原生形状，深色主题友好）
 * - 可编辑（用户下载后可调整）
 */

import type PptxGenJS from 'pptxgenjs';

// ============ 类型定义 ============

export interface MermaidNode {
  id: string;
  text: string;
  shape: 'rect' | 'roundRect' | 'diamond' | 'circle' | 'stadium';
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dotted';
}

export interface MermaidGraph {
  direction: 'TD' | 'TB' | 'LR' | 'RL' | 'BT';
  nodes: MermaidNode[];
  edges: MermaidEdge[];
}

export interface LayoutNode extends MermaidNode {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  indexInLayer: number;
}

export interface ThemeConfig {
  bgColor: string;
  bgSecondary: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  cardBorder: string;
}

// ============ 解析器 ============

/**
 * 解析 Mermaid flowchart 语法
 *
 * 支持的语法：
 * - graph TD / LR / TB / RL / BT
 * - A[矩形] B(圆角) C{菱形} D((圆形)) E([体育场])
 * - A --> B  A --- B  A -.-> B  A ==> B
 * - A -->|标签| B
 */
export function parseMermaid(code: string): MermaidGraph {
  const lines = code.trim().split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('%%'));

  // 解析方向
  let direction: MermaidGraph['direction'] = 'TD';
  const dirMatch = lines[0]?.match(/^(?:graph|flowchart)\s+(TD|TB|LR|RL|BT)/i);
  if (dirMatch) {
    direction = dirMatch[1].toUpperCase() as MermaidGraph['direction'];
  }

  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  // 解析节点和边
  for (const line of lines.slice(1)) {
    // 跳过 subgraph、end、style 等指令
    if (/^(subgraph|end|style|classDef|class)\b/i.test(line)) continue;

    // 匹配边：A -->|label| B 或 A --> B
    const edgePatterns = [
      // A -->|label| B
      /(\w+)\s*(-{1,2}>|={2,}>|\.{1,2}->)\s*\|([^|]+)\|\s*(\w+)/,
      // A --> B
      /(\w+)\s*(-{1,2}>|={2,}>|\.{1,2}->)\s*(\w+)/,
      // A --- B (无箭头)
      /(\w+)\s*(-{2,3})\s*(\w+)/,
    ];

    let matched = false;
    for (const pattern of edgePatterns) {
      const m = line.match(pattern);
      if (m) {
        const from = m[1];
        const arrow = m[2];
        const label = m.length === 5 ? m[3] : undefined;
        const to = m.length === 5 ? m[4] : m[3];

        edges.push({
          from,
          to,
          label,
          style: arrow.includes('.') ? 'dotted' : 'solid',
        });

        // 确保节点存在
        if (!nodes.has(from)) nodes.set(from, { id: from, text: from, shape: 'roundRect' });
        if (!nodes.has(to)) nodes.set(to, { id: to, text: to, shape: 'roundRect' });

        matched = true;
        break;
      }
    }

    // 解析独立节点定义：A[文本] 或 A{文本} 等
    const nodePatterns = [
      { regex: /(\w+)\[\[([^\]]+)\]\]/, shape: 'rect' as const },      // [[子程序]]
      { regex: /(\w+)\[([^\]]+)\]/, shape: 'rect' as const },          // [矩形]
      { regex: /(\w+)\(\(([^)]+)\)\)/, shape: 'circle' as const },     // ((圆形))
      { regex: /(\w+)\(([^)]+)\)/, shape: 'roundRect' as const },      // (圆角)
      { regex: /(\w+)\{([^}]+)\}/, shape: 'diamond' as const },        // {菱形}
      { regex: /(\w+)\(\[([^\]]+)\]\)/, shape: 'stadium' as const },   // ([体育场])
    ];

    for (const { regex, shape } of nodePatterns) {
      const matches = [...line.matchAll(new RegExp(regex, 'g'))];
      for (const m of matches) {
        const id = m[1];
        const text = m[2];
        nodes.set(id, { id, text, shape });
      }
    }
  }

  return {
    direction,
    nodes: Array.from(nodes.values()),
    edges,
  };
}

// ============ 布局算法 ============

/**
 * 分层布局算法
 *
 * 1. 拓扑排序确定节点层级
 * 2. 每层内均匀分布
 * 3. 返回带坐标的节点列表
 */
export function layoutGraph(
  graph: MermaidGraph,
  bounds: { x: number; y: number; w: number; h: number },
  options: { padding?: number; maxNodeW?: number; maxNodeH?: number } = {}
): LayoutNode[] {
  const { padding = 0.2, maxNodeW = 1.4, maxNodeH = 0.45 } = options;
  const { nodes, edges, direction } = graph;

  if (nodes.length === 0) return [];

  // 构建邻接表
  const outEdges = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    outEdges.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const edge of edges) {
    outEdges.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
  }

  // 拓扑排序分层
  const layers: string[][] = [];
  const assigned = new Set<string>();

  while (assigned.size < nodes.length) {
    const layer: string[] = [];
    for (const node of nodes) {
      if (assigned.has(node.id)) continue;
      const deg = inDegree.get(node.id) || 0;
      if (deg === 0 || [...edges.filter(e => e.to === node.id)].every(e => assigned.has(e.from))) {
        layer.push(node.id);
      }
    }

    if (layer.length === 0) {
      // 处理环或孤立节点
      for (const node of nodes) {
        if (!assigned.has(node.id)) {
          layer.push(node.id);
          break;
        }
      }
    }

    for (const id of layer) assigned.add(id);
    layers.push(layer);
  }

  // ============ 自适应布局计算 ============
  const isVertical = direction === 'TD' || direction === 'TB' || direction === 'BT';
  const innerW = bounds.w - padding * 2;
  const innerH = bounds.h - padding * 2;
  const layerCount = layers.length;
  const maxNodesInLayer = Math.max(...layers.map(l => l.length));

  // 根据节点数量自适应计算尺寸
  let nodeW: number, nodeH: number, gapRatio: number;

  if (isVertical) {
    // 垂直布局：高度方向需要适应层数，宽度方向需要适应最大层节点数
    const availableH = innerH;
    const availableW = innerW;

    // 节点高度 = (可用高度 - 层间间隙) / 层数
    // 层间间隙 = 节点高度 * 0.5 * (层数-1)
    // 所以：availableH = layerCount * nodeH + (layerCount-1) * nodeH * 0.5
    //      availableH = nodeH * (layerCount + 0.5 * (layerCount - 1))
    //      availableH = nodeH * (1.5 * layerCount - 0.5)
    nodeH = Math.min(maxNodeH, availableH / (1.5 * layerCount - 0.5 + 0.5)); // 额外 0.5 用于边距
    nodeW = Math.min(maxNodeW, (availableW * 0.8) / maxNodesInLayer);
    gapRatio = 0.5;
  } else {
    // 水平布局：宽度方向需要适应层数
    const availableW = innerW;
    const availableH = innerH;

    nodeW = Math.min(maxNodeW, availableW / (1.5 * layerCount - 0.5 + 0.5));
    nodeH = Math.min(maxNodeH, (availableH * 0.8) / maxNodesInLayer);
    gapRatio = 0.5;
  }

  const layoutNodes: LayoutNode[] = [];
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  for (let layerIdx = 0; layerIdx < layerCount; layerIdx++) {
    const layer = layers[layerIdx];
    const nodesInLayer = layer.length;

    for (let nodeIdx = 0; nodeIdx < nodesInLayer; nodeIdx++) {
      const nodeId = layer[nodeIdx];
      const node = nodeMap.get(nodeId)!;

      let x: number, y: number, w: number, h: number;

      if (isVertical) {
        // 垂直布局：层从上到下，节点从左到右
        const layerGap = nodeH * gapRatio;
        const totalLayerH = layerCount * nodeH + (layerCount - 1) * layerGap;
        const startY = bounds.y + padding + (innerH - totalLayerH) / 2;

        const nodeSpacing = innerW / (nodesInLayer + 1);

        w = Math.min(nodeW, nodeSpacing * 0.85);
        h = nodeH;

        x = bounds.x + padding + nodeSpacing * (nodeIdx + 1) - w / 2;
        y = startY + layerIdx * (nodeH + layerGap);

        if (direction === 'BT') {
          y = bounds.y + bounds.h - padding - (innerH - totalLayerH) / 2 - nodeH - layerIdx * (nodeH + layerGap);
        }
      } else {
        // 水平布局：层从左到右，节点从上到下
        const layerGap = nodeW * gapRatio;
        const totalLayerW = layerCount * nodeW + (layerCount - 1) * layerGap;
        const startX = bounds.x + padding + (innerW - totalLayerW) / 2;

        const nodeSpacing = innerH / (nodesInLayer + 1);

        w = nodeW;
        h = Math.min(nodeH, nodeSpacing * 0.85);

        x = startX + layerIdx * (nodeW + layerGap);
        y = bounds.y + padding + nodeSpacing * (nodeIdx + 1) - h / 2;

        if (direction === 'RL') {
          x = bounds.x + bounds.w - padding - (innerW - totalLayerW) / 2 - nodeW - layerIdx * (nodeW + layerGap);
        }
      }

      layoutNodes.push({
        ...node,
        x, y, w, h,
        layer: layerIdx,
        indexInLayer: nodeIdx,
      });
    }
  }

  return layoutNodes;
}

// ============ 绘制辅助函数 ============

/**
 * 计算从源节点边缘到目标节点边缘的连接点
 * 返回 [sourceX, sourceY, targetX, targetY]
 */
function calculateEdgePoints(
  from: LayoutNode,
  to: LayoutNode
): [number, number, number, number] {
  const fromCx = from.x + from.w / 2;
  const fromCy = from.y + from.h / 2;
  const toCx = to.x + to.w / 2;
  const toCy = to.y + to.h / 2;

  const dx = toCx - fromCx;
  const dy = toCy - fromCy;

  let fromX: number, fromY: number, toX: number, toY: number;

  // 判断主方向
  if (Math.abs(dy) > Math.abs(dx)) {
    // 主要是垂直方向
    if (dy > 0) {
      // 向下：从底部到顶部
      fromX = fromCx;
      fromY = from.shape === 'diamond' ? fromCy + from.h / 2 : from.y + from.h;
      toX = toCx;
      toY = to.shape === 'diamond' ? toCy - to.h / 2 : to.y;
    } else {
      // 向上：从顶部到底部
      fromX = fromCx;
      fromY = from.shape === 'diamond' ? fromCy - from.h / 2 : from.y;
      toX = toCx;
      toY = to.shape === 'diamond' ? toCy + to.h / 2 : to.y + to.h;
    }
  } else {
    // 主要是水平方向
    if (dx > 0) {
      // 向右：从右侧到左侧
      fromX = from.shape === 'diamond' ? fromCx + from.w / 2 : from.x + from.w;
      fromY = fromCy;
      toX = to.shape === 'diamond' ? toCx - to.w / 2 : to.x;
      toY = toCy;
    } else {
      // 向左：从左侧到右侧
      fromX = from.shape === 'diamond' ? fromCx - from.w / 2 : from.x;
      fromY = fromCy;
      toX = to.shape === 'diamond' ? toCx + to.w / 2 : to.x + to.w;
      toY = toCy;
    }
  }

  return [fromX, fromY, toX, toY];
}

/**
 * 绘制一条带箭头的直线
 *
 * 注意：pptxgenjs 的 flipH 有 bug（单独使用时箭头位置错误）
 * 但对于简单流程图，建议使用 mermaid_export 生成透明 PNG 图片
 * 这里保留简化版本用于基本场景
 */
function drawArrowLine(
  slide: PptxGenJS.Slide,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: ThemeConfig,
  style?: string
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;

  const boxX = Math.min(x1, x2);
  const boxY = Math.min(y1, y2);
  const boxW = Math.max(Math.abs(dx), 0.001);
  const boxH = Math.max(Math.abs(dy), 0.001);

  // 简化版：只使用 endArrowType，接受 flipH 的 bug
  // 对于复杂流程图，建议使用 mermaid_export 生成透明 PNG
  slide.addShape('line', {
    x: boxX,
    y: boxY,
    w: boxW,
    h: boxH,
    flipH: dx < 0,
    flipV: dy < 0,
    line: {
      color: theme.accent,
      width: 1.5,
      dashType: style === 'dotted' ? 'dash' : 'solid',
      endArrowType: 'triangle',
    },
  });
}

/**
 * 绘制一条无箭头的直线（用于正交连线的中间段）
 */
function drawLine(
  slide: PptxGenJS.Slide,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: ThemeConfig,
  style?: string
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;

  const boxX = Math.min(x1, x2);
  const boxY = Math.min(y1, y2);
  const boxW = Math.max(Math.abs(dx), 0.001);
  const boxH = Math.max(Math.abs(dy), 0.001);

  slide.addShape('line', {
    x: boxX,
    y: boxY,
    w: boxW,
    h: boxH,
    flipH: dx < 0,
    flipV: dy < 0,
    line: {
      color: theme.accent,
      width: 1.5,
      dashType: style === 'dotted' ? 'dash' : 'solid',
    },
  });
}

/**
 * 绘制正交连线（三段式：起点 → 中点 → 终点）
 * 这种连线在流程图中更美观，避免斜线穿过其他节点
 */
function drawOrthogonalArrowLine(
  slide: PptxGenJS.Slide,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: ThemeConfig,
  style?: string,
  isVerticalFirst: boolean = true
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;

  // 如果几乎是直线，直接画
  if (Math.abs(dx) < 0.1 || Math.abs(dy) < 0.1) {
    drawArrowLine(slide, x1, y1, x2, y2, theme, style);
    return;
  }

  // 计算中间点
  const midY = (y1 + y2) / 2;
  const midX = (x1 + x2) / 2;

  if (isVerticalFirst) {
    // 三段式：垂直 → 水平 → 垂直
    drawLine(slide, x1, y1, x1, midY, theme, style);      // 垂直段1
    drawLine(slide, x1, midY, x2, midY, theme, style);    // 水平段
    drawArrowLine(slide, x2, midY, x2, y2, theme, style); // 垂直段2（带箭头）
  } else {
    // 三段式：水平 → 垂直 → 水平
    drawLine(slide, x1, y1, midX, y1, theme, style);      // 水平段1
    drawLine(slide, midX, y1, midX, y2, theme, style);    // 垂直段
    drawArrowLine(slide, midX, y2, x2, y2, theme, style); // 水平段2（带箭头）
  }
}

// ============ 渲染器 ============

/**
 * 用 pptxgenjs 原生形状渲染 Mermaid 图
 */
export function renderMermaidNative(
  slide: PptxGenJS.Slide,
  code: string,
  bounds: { x: number; y: number; w: number; h: number },
  theme: ThemeConfig,
  options: {
    title?: string;
    showBackground?: boolean;
  } = {}
): void {
  const { title, showBackground = true } = options;

  // 计算内容区域（预留标题和边距空间）
  const titleHeight = title ? 0.4 : 0;
  const bottomPadding = 0.15;
  const contentBounds = {
    x: bounds.x,
    y: bounds.y + titleHeight,
    w: bounds.w,
    h: bounds.h - titleHeight - bottomPadding,
  };

  // 解析和布局（使用内容区域，而非整个 bounds）
  const graph = parseMermaid(code);
  const layoutNodes = layoutGraph(graph, contentBounds);
  const nodeMap = new Map(layoutNodes.map(n => [n.id, n]));

  // 背景
  if (showBackground) {
    slide.addShape('roundRect', {
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 0.5 },
      rectRadius: 0.1,
    });
  }

  // 标题
  if (title) {
    slide.addText(title, {
      x: bounds.x + 0.1,
      y: bounds.y + 0.08,
      w: bounds.w - 0.2,
      h: 0.28,
      fontSize: 9,
      color: theme.textSecondary,
      align: 'center',
    });
  }

  // 绘制连接线（先画线，后画节点，这样节点会覆盖线的端点）
  for (const edge of graph.edges) {
    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    if (!fromNode || !toNode) continue;

    // 使用智能边缘连接计算精确的连接点
    const [startX, startY, endX, endY] = calculateEdgePoints(fromNode, toNode);

    const dx = endX - startX;
    const dy = endY - startY;

    // 判断是否需要正交连线（当水平和垂直偏移都较大时）
    const needOrthogonal = Math.abs(dx) > 0.2 && Math.abs(dy) > 0.2;

    if (needOrthogonal) {
      // 使用正交连线（三段式转弯线）
      // 对于 TD 布局，主要是垂直方向，所以用 isVerticalFirst=true
      const isVerticalFirst = Math.abs(dy) >= Math.abs(dx);
      drawOrthogonalArrowLine(slide, startX, startY, endX, endY, theme, edge.style, isVerticalFirst);
    } else {
      // 直线连接
      drawArrowLine(slide, startX, startY, endX, endY, theme, edge.style);
    }

    // 边标签（放在中间位置）
    if (edge.label) {
      const labelX = (startX + endX) / 2;
      const labelY = (startY + endY) / 2;
      slide.addText(edge.label, {
        x: labelX - 0.4,
        y: labelY - 0.12,
        w: 0.8,
        h: 0.24,
        fontSize: 7,
        color: theme.textSecondary,
        align: 'center',
        fill: { color: theme.bgSecondary },
      });
    }
  }

  // 绘制节点
  for (const node of layoutNodes) {
    const isFirst = node.layer === 0 && node.indexInLayer === 0;
    const isLast = node.layer === Math.max(...layoutNodes.map(n => n.layer));
    const isHighlight = isFirst || isLast;

    // 节点形状
    let shapeType: string = 'roundRect';
    let rectRadius = 0.06;

    switch (node.shape) {
      case 'rect':
        shapeType = 'rect';
        rectRadius = 0;
        break;
      case 'diamond':
        shapeType = 'diamond';
        break;
      case 'circle':
        shapeType = 'ellipse';
        break;
      case 'stadium':
        rectRadius = node.h / 2;
        break;
    }

    // 绘制形状
    const shapeProps: any = {
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      fill: isHighlight ? { color: theme.accent } : { color: theme.bgColor },
      line: { color: isHighlight ? theme.accent : theme.cardBorder, width: 1.5 },
    };

    if (shapeType === 'roundRect' || shapeType === 'rect') {
      shapeProps.rectRadius = rectRadius;
    }

    slide.addShape(shapeType as any, shapeProps);

    // 节点文本
    slide.addText(node.text, {
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      fontSize: 9,
      color: isHighlight ? theme.bgColor : theme.textPrimary,
      align: 'center',
      valign: 'middle',
      bold: isHighlight,
    });
  }
}

// ============ 预设图表 ============

/**
 * Agent Loop 流程图 Mermaid 代码
 */
export const AGENT_LOOP_MERMAID = `graph TD
    A[用户输入] --> B[上下文构建]
    B --> C[LLM 推理]
    C --> D[工具执行]
    D --> E[迭代/完成]`;

/**
 * Skills 系统流程图
 */
export const SKILLS_MERMAID = `graph TD
    A[输入命令] --> B[匹配 Skill]
    B --> C[读取配置]
    C --> D[执行步骤]
    D --> E[完成]`;

/**
 * 沙箱机制图
 */
export const SANDBOX_MERMAID = `graph LR
    A[AI] --> B{权限检查}
    B -->|允许| C[安全操作]
    B -->|拒绝| D[请求授权]
    D --> E[用户确认]
    E --> C`;

/**
 * LSP 对比图
 */
export const LSP_COMPARE_MERMAID = `graph TD
    A[传统 grep] --> B[遍历文件]
    B --> C[文本匹配]
    C --> D[45秒]
    E[LSP] --> F[语义索引]
    F --> G[直接跳转]
    G --> H[0.05秒]`;
