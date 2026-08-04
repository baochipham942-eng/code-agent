// 画布出图的复述/验收/失败句构造（工单 2026-07-31 路径 B）。
//
// 三句共用同一份 op spec：复述说「要做什么」、验收说「实际做了什么」、失败回指复述——
// 同源保证三者不会互相打架（不会出现复述说扩图、失败句说重绘）。
// 全部由按钮参数和产出物实测尺寸拼成，不过模型、零成本。
import type { Translations } from '../../i18n';
import {
  aspectOrientation,
  aspectRatioMatches,
  expectedExpandSize,
  expectedExpandSizeFromScales,
  sizeApproxEquals,
  type ExpandDirection,
  type ExpandScales,
} from '@shared/media/imageNarration';

type NarrationText = Translations['imageNarration'];

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * 一次画布出图动作的意图，复述/验收/失败三句共用。
 *
 * 扩图有两种形态，对应 ExpandArgs 的两条互斥入参：单方向 direction+ratio（扩图按钮），
 * 与四向独立 scales（「调整大小」比例预设，一次调用做非对称外扩）。两者都是真付费路径，
 * 预期尺寸走同一条式子，只是复述句的说法不同。
 */
export type CanvasOpSpec =
  | { op: 'generate'; requirement: string; ratio: string }
  | { op: 'expand'; direction: ExpandDirection; ratio: number; base: PixelSize }
  | { op: 'expand'; scales: ExpandScales; base: PixelSize }
  | { op: 'editRegion'; instruction: string; regionCount: number; base: PixelSize }
  | { op: 'removeWatermark'; base: PixelSize }
  | { op: 'annotation'; instruction: string; shapeCount: number; base: PixelSize };

/** 扩图两形态共用的预期尺寸出口；算不出来返回 undefined，调用方据此省掉该断言。 */
function expandExpected(spec: Extract<CanvasOpSpec, { op: 'expand' }>): PixelSize | undefined {
  return 'scales' in spec
    ? expectedExpandSizeFromScales(spec.base.width, spec.base.height, spec.scales)
    : expectedExpandSize(spec.base.width, spec.base.height, spec.direction, spec.ratio);
}

function fill(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)),
    template,
  );
}

function orientationWord(nt: NarrationText, ratio: string): string {
  switch (aspectOrientation(ratio)) {
    case 'portrait': return nt.orientationPortrait;
    case 'landscape': return nt.orientationLandscape;
    case 'square': return nt.orientationSquare;
    default: return '';
  }
}

function directionWord(nt: NarrationText, direction: ExpandDirection): string {
  switch (direction) {
    case 'up': return nt.directionUp;
    case 'down': return nt.directionDown;
    case 'left': return nt.directionLeft;
    case 'right': return nt.directionRight;
    case 'all': return nt.directionAll;
  }
}

/** 失败句里指代这次动作用的短标签。 */
function opLabel(nt: NarrationText, spec: CanvasOpSpec): string {
  switch (spec.op) {
    case 'generate': return nt.opGenerate;
    case 'expand': return nt.opExpand;
    case 'editRegion': return nt.opEditRegion;
    case 'removeWatermark': return nt.opRemoveWatermark;
    case 'annotation': return nt.opAnnotation;
  }
}

/** 动手前复述：说清我理解的诉求 + 这一步会动什么、不动什么。 */
export function buildCanvasBriefing(nt: NarrationText, spec: CanvasOpSpec): string {
  const lines: string[] = [];
  switch (spec.op) {
    case 'generate':
      lines.push(nt.briefingHeader + spec.requirement);
      lines.push(fill(nt.briefingGenerate, {
        ratio: spec.ratio,
        orientation: orientationWord(nt, spec.ratio),
      }));
      break;
    case 'expand': {
      if ('scales' in spec) {
        // 非对称外扩说不出一个「方向 + 倍数」，改说「从多大补到多大」——同样是可核对的数字。
        const expected = expandExpected(spec);
        if (expected) {
          lines.push(fill(nt.briefingExpandScales, {
            w: spec.base.width, h: spec.base.height,
            ew: expected.width, eh: expected.height,
          }));
        }
      } else {
        lines.push(fill(nt.briefingExpand, {
          direction: directionWord(nt, spec.direction),
          ratio: spec.ratio,
          w: spec.base.width,
          h: spec.base.height,
        }));
      }
      break;
    }
    case 'editRegion':
      lines.push(nt.briefingHeader + spec.instruction);
      lines.push(fill(nt.briefingEditRegion, { count: spec.regionCount }));
      break;
    case 'removeWatermark':
      lines.push(fill(nt.briefingRemoveWatermark, { w: spec.base.width, h: spec.base.height }));
      break;
    case 'annotation':
      lines.push(nt.briefingHeader + spec.instruction);
      lines.push(fill(nt.briefingAnnotation, { count: spec.shapeCount }));
      break;
  }
  lines.push(nt.briefingPaidHint);
  return lines.join('\n');
}

/**
 * 出完验收：只写能对着新图核对的数字。
 * 比例/预期尺寸算不出来时退到「新图 W×H」这条纯事实，而不是补一句「已完成」。
 */
export function buildCanvasVerdict(
  nt: NarrationText,
  spec: CanvasOpSpec,
  actual: PixelSize,
  costText?: string,
): string {
  const lines: string[] = [];

  if (spec.op === 'generate') {
    const matches = aspectRatioMatches(actual.width, actual.height, spec.ratio);
    const vars = { w: actual.width, h: actual.height, ratio: spec.ratio };
    lines.push(
      matches === true ? fill(nt.verdictRatioMatch, vars)
        : matches === false ? fill(nt.verdictRatioMismatch, vars)
          : fill(nt.verdictSize, vars),
    );
  } else if (spec.op === 'expand') {
    const expected = expandExpected(spec);
    if (expected) {
      const vars = {
        w: actual.width, h: actual.height,
        ew: expected.width, eh: expected.height,
        bw: spec.base.width, bh: spec.base.height,
      };
      lines.push(sizeApproxEquals(actual, expected)
        ? fill(nt.verdictExpandMatch, vars)
        : fill(nt.verdictExpandMismatch, vars));
    } else {
      lines.push(fill(nt.verdictSize, { w: actual.width, h: actual.height }));
    }
  } else {
    // 编辑类（局部重绘/去水印/标注重绘）承诺过「其余像素不动」，尺寸变了就是没守住，必须说出来。
    const vars = {
      w: actual.width, h: actual.height,
      bw: spec.base.width, bh: spec.base.height,
    };
    lines.push(sizeApproxEquals(actual, spec.base)
      ? fill(nt.verdictSizeKept, vars)
      : fill(nt.verdictSizeChanged, vars));
  }

  if (costText) lines.push(fill(nt.verdictCost, { cost: costText }));
  return `${nt.verdictHeader}\n${lines.join('\n')}`;
}

/** 失败收口：回指刚才那句复述，并说清画布上什么都没多出来。 */
export function buildCanvasFailure(nt: NarrationText, spec: CanvasOpSpec, reason: string): string {
  return fill(nt.failure, { what: opLabel(nt, spec), reason });
}
