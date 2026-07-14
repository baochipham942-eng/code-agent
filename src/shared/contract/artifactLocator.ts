// ADR-040 — Artifact Locator 契约：预览定点与编辑目标的唯一对账口径。
//
// 为什么要有这层：预览侧算出的「位置」和编辑工具用的「位置」一直是两套坐标系，中间
// 没有翻译层也没有校验。用户点了表格第 4 行，预览按数组下标算 A1、写侧按 xlsx 原始
// 行号执行，两边各错各的，且**静默改错**——不报错，用户（非程序员）根本发现不了。
//
// 这个 envelope 只统一四件事：产物身份、revision、显示标签、失败语义。坐标本身保持
// 各自领域原生语义（Excel 的 A1、PPT 的 slide part、Word 的 <w:p> 序数），不造一个
// 跨产物的通用 index——那只会再加一层换算，也就再加一个错位点。

type ArtifactKind = 'spreadsheet' | 'presentation' | 'document';

export interface ArtifactRevision {
  algorithm: 'sha256';
  value: string;
}

/** Excel：sheetName 是必填生产项。缺了它写侧会静默落到第一张表（excelEdit.ts getWorksheet）。 */
interface SheetRangeTarget {
  kind: 'sheet-range';
  sheetName: string;
  /** B7 或 A1:C2 */
  a1: string;
}

/** PPT：slidePartName 是执行身份，displayIndex 只是人类标签，两者不可互推。 */
interface PptSlideTarget {
  kind: 'ppt-slide';
  /** 0-based，只用于 UI 与对账，绝不直接作为写入坐标 */
  displayIndex: number;
  relationshipId: string;
  /** ppt/slides/slide7.xml */
  slidePartName: string;
  textFingerprint: string;
}

/** Word：document.xml 全部 <w:p> 的 0-based 序数（与写侧同谓词），指纹作安全闸。 */
interface DocxParagraphTarget {
  kind: 'docx-paragraph';
  partName: 'word/document.xml';
  paragraphIndex: number;
  textFingerprint: string;
  previousTextFingerprint?: string;
  nextTextFingerprint?: string;
}

type ArtifactLocatorTarget = SheetRangeTarget | PptSlideTarget | DocxParagraphTarget;

export interface ArtifactLocatorV1 {
  version: 1;
  artifact: {
    kind: ArtifactKind;
    filePath: string;
    revision: ArtifactRevision;
  };
  target: ArtifactLocatorTarget;
  display: { label: string; excerpt?: string };
}

export type ArtifactLocatorValidation =
  | { ok: true; locator: ArtifactLocatorV1 }
  | { ok: false; reason: string };

/** 产物 kind 与 target kind 的唯一合法配对。错配一律 fail-closed。 */
const TARGET_KIND_BY_ARTIFACT: Record<ArtifactKind, ArtifactLocatorTarget['kind']> = {
  spreadsheet: 'sheet-range',
  presentation: 'ppt-slide',
  document: 'docx-paragraph',
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const A1_REF = /^[A-Z]{1,3}[1-9][0-9]*(:[A-Z]{1,3}[1-9][0-9]*)?$/;
const SLIDE_PART_NAME = /^ppt\/slides\/slide([1-9][0-9]*)\.xml$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const DOCX_PART_NAME = 'word/document.xml';

function fail(reason: string): ArtifactLocatorValidation {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * ppt/slides/slide7.xml → 6，即 ppt_edit 的 slide_index（文件序号 - 1）。
 *
 * 这是 slidePartName 到写入坐标的唯一换算入口。displayIndex 永远不参与这个推导：
 * 用户看到的第 2 页完全可能指向 slide7.xml。
 */
export function slideIndexFromPartName(slidePartName: string): number | null {
  const matched = SLIDE_PART_NAME.exec(slidePartName);
  if (!matched) return null;
  return Number(matched[1]) - 1;
}

/**
 * 公共不变量 1：filePath 必须解析为本地源文件。
 *
 * 三道检查各有各的猎物，不是冗余的同义反复：
 * - `scheme://` 拦 http/https/file——它们同时也不以 `/` 开头，所以这道主要给准确报错；
 * - 非 `/` 开头拦相对路径；
 * - **`//` 开头拦 protocol-relative URL**（`//evil.com/a.xlsx`）——它以 `/` 开头、又没有
 *   scheme，前两道都放行。这一条是写测试时用变异验证撞出来的真洞，不是凑数。
 */
function validateLocalFilePath(filePath: unknown): string | null {
  if (!nonEmptyString(filePath)) return 'artifact.filePath 缺失';
  if (URL_SCHEME.test(filePath)) return `artifact.filePath 是 URL，不可编辑：${filePath}`;
  if (!filePath.startsWith('/')) return `artifact.filePath 不是绝对路径：${filePath}`;
  if (filePath.startsWith('//')) return `artifact.filePath 不是本地路径：${filePath}`;
  return null;
}

function validateTarget(target: unknown, expectedKind: ArtifactLocatorTarget['kind']): string | null {
  if (!isRecord(target)) return 'target 不是对象';
  if (target.kind !== expectedKind) {
    return `target.kind=${String(target.kind)} 与产物 kind 不匹配（应为 ${expectedKind}）`;
  }

  switch (expectedKind) {
    case 'sheet-range': {
      if (!nonEmptyString(target.sheetName)) return 'sheet-range 缺少 sheetName';
      if (!nonEmptyString(target.a1) || !A1_REF.test(target.a1)) {
        return `sheet-range 的 a1 非法：${String(target.a1)}`;
      }
      return null;
    }
    case 'ppt-slide': {
      if (!isIndex(target.displayIndex)) return 'ppt-slide 的 displayIndex 非法';
      if (!nonEmptyString(target.relationshipId)) return 'ppt-slide 缺少 relationshipId';
      if (!nonEmptyString(target.slidePartName) || slideIndexFromPartName(target.slidePartName) === null) {
        return `ppt-slide 的 slidePartName 非法：${String(target.slidePartName)}`;
      }
      if (typeof target.textFingerprint !== 'string') return 'ppt-slide 缺少 textFingerprint';
      return null;
    }
    case 'docx-paragraph': {
      if (target.partName !== DOCX_PART_NAME) {
        return `docx-paragraph 的 partName 非法：${String(target.partName)}`;
      }
      if (!isIndex(target.paragraphIndex)) return 'docx-paragraph 的 paragraphIndex 非法';
      if (typeof target.textFingerprint !== 'string') return 'docx-paragraph 缺少 textFingerprint';
      for (const key of ['previousTextFingerprint', 'nextTextFingerprint'] as const) {
        if (target[key] !== undefined && typeof target[key] !== 'string') {
          return `docx-paragraph 的 ${key} 非法`;
        }
      }
      return null;
    }
  }
}

/**
 * 运行时校验 locator。**这是安全边界**——renderer 的判断不算数（web 侧 envelope.context
 * 是 passthrough 后直接 cast 的，见 agentBodySchemas.ts），host 必须自己再验一遍。
 *
 * 任一项不合法一律 fail-closed，不做 best-effort 修补：宁可让用户重新点一次，
 * 也不拿一个半信半疑的坐标去改人家的文档。
 */
export function validateArtifactLocatorV1(input: unknown): ArtifactLocatorValidation {
  if (!isRecord(input)) return fail('locator 不是对象');
  if (input.version !== 1) return fail(`locator.version 不是 1：${String(input.version)}`);

  const artifact = input.artifact;
  if (!isRecord(artifact)) return fail('locator.artifact 不是对象');

  const kind = artifact.kind;
  if (typeof kind !== 'string' || !(kind in TARGET_KIND_BY_ARTIFACT)) {
    return fail(`artifact.kind 非法：${String(kind)}`);
  }
  const artifactKind = kind as ArtifactKind;

  const pathError = validateLocalFilePath(artifact.filePath);
  if (pathError) return fail(pathError);

  const revision = artifact.revision;
  if (!isRecord(revision)) return fail('artifact.revision 缺失');
  if (revision.algorithm !== 'sha256') return fail(`revision.algorithm 非法：${String(revision.algorithm)}`);
  if (typeof revision.value !== 'string' || !SHA256_HEX.test(revision.value)) {
    return fail('revision.value 不是 64 位 sha256 十六进制');
  }

  const targetError = validateTarget(input.target, TARGET_KIND_BY_ARTIFACT[artifactKind]);
  if (targetError) return fail(targetError);

  const display = input.display;
  if (!isRecord(display)) return fail('locator.display 缺失');
  if (!nonEmptyString(display.label)) return fail('display.label 缺失');
  if (display.excerpt !== undefined && typeof display.excerpt !== 'string') {
    return fail('display.excerpt 非法');
  }

  return { ok: true, locator: input as unknown as ArtifactLocatorV1 };
}
