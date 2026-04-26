// V2-B Tweak 5 类原子操作的声明式 API 类型
// renderer 和 main 共享，实现在 src/main/tools/livePreview/tailwindCategories.ts

export type ColorTarget = 'text' | 'bg' | 'border';
export type SpacingAxis = 'p' | 'px' | 'py' | 'pt' | 'pr' | 'pb' | 'pl' | 'm' | 'mx' | 'my' | 'gap';
export type FontSizeKey = 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl';
export type RadiusKey = 'none' | 'sm' | '' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'full';
export type TextAlignValue = 'left' | 'center' | 'right';
export type ItemsAlignValue = 'start' | 'center' | 'end';
export type JustifyAlignValue = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';

export type ClassMutation =
  | { kind: 'color'; target: ColorTarget; color: string; shade: number }
  | { kind: 'spacing'; axis: SpacingAxis; value: number }
  | { kind: 'fontSize'; size: FontSizeKey }
  | { kind: 'radius'; size: RadiusKey }
  | { kind: 'align'; axis: 'text'; value: TextAlignValue }
  | { kind: 'align'; axis: 'items'; value: ItemsAlignValue }
  | { kind: 'align'; axis: 'justify'; value: JustifyAlignValue };

export interface TweakLocation {
  /** 绝对路径 */
  file: string;
  /** 1-based, 跟 babel loc 一致 */
  line: number;
  /** 0-based */
  column: number;
}

export type TweakResult =
  | {
      ok: true;
      newClassName: string;
      mutation: { finalClasses: string[]; removed: string[]; added: string[]; changed: boolean };
    }
  | {
      ok: false;
      reason: 'expression' | 'no-className' | 'element-not-found' | 'parse-error' | 'noop' | 'io';
      detail?: string;
    };
