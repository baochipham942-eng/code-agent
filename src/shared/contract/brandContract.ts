// ============================================================================
// Brand Contract（我的品牌契约 · CD-Parity §1）—— 纯类型 + normalize + 纯查询
// ----------------------------------------------------------------------------
// 用户把「我的品牌」（色板/字体/气质 + Keep/Change/Do-not-copy）固化成一份可复用
// 契约，强制注入每一次设计生成。本文件只含纯逻辑（无 fs/IPC），可单测；
// registry 读写在 src/host/services/design/brandRegistry.ts。
//
// tokens 复用现有 DirectionTokens 形状（palette+fonts+posture+refs），从而能直接
// hydrate 进 brief.directionTokens，复用现成三处注入/护栏（workbenchTurnContext /
// selfCritique / critique/prompt）。
// ============================================================================

import type { DirectionTokens } from '../../design/direction-tokens';
import { normalizeDirectionTokens, normalizeStringList } from './designBrief';

export interface BrandContract {
  /** registry key（从 name 派生 slug + 短后缀） */
  id: string;
  /** 展示名，如 'Porsche 数字化' */
  name: string;
  /** 复用 DirectionTokens 形状（palette + fonts + posture + refs） */
  tokens: DirectionTokens;
  /** 必须复刻：'圆角克制，大量留白' */
  keep: string[];
  /** 可调整：'主色可在深浅间浮动' */
  change: string[];
  /** 禁止：'不要渐变按钮，不要 emoji 图标' */
  doNotCopy: string[];
  /** 可选 logo 路径（落在 registry 目录内） */
  logoPath?: string;
  /** 来源：参考图提取 or 手填表单 */
  source: 'reference' | 'manual';
  createdAt: number;
  updatedAt: number;
}

/** registry 索引里的轻量元数据（列表用，不含完整 tokens/约束） */
export interface BrandMeta {
  id: string;
  name: string;
  updatedAt: number;
}

/** registry 索引文件 index.json 的结构 */
export interface BrandRegistryIndex {
  activeId?: string;
  brands: BrandMeta[];
}

/** brief 注入用的 prompt 相关切片（keep/change/doNotCopy + logo），完整 tokens 经 directionTokens 走。 */
export interface BrandBriefProjection {
  keep: string[];
  change: string[];
  doNotCopy: string[];
  logoPath?: string;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 校验/归一一份 BrandContract。tokens 走与 normalizeDesignBrief.directionTokens 完全相同的
 * 形状规则（normalizeDirectionTokens）。要求 id + name + 合法 tokens，缺一即 undefined。
 * 三桶字符串数组 trim + 去重 + 去空，默认 []。source 仅 reference/manual。
 * 纯函数，可单测。
 */
export function normalizeBrandContract(value: unknown): BrandContract | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<BrandContract>;

  const id = normalizeText(raw.id);
  const name = normalizeText(raw.name);
  if (!id || !name) return undefined;

  const tokens = normalizeDirectionTokens(raw.tokens);
  if (!tokens) return undefined;

  const keep = normalizeStringList(raw.keep) ?? [];
  const change = normalizeStringList(raw.change) ?? [];
  const doNotCopy = normalizeStringList(raw.doNotCopy) ?? [];
  const logoPath = normalizeText(raw.logoPath);
  const source: BrandContract['source'] = raw.source === 'reference' ? 'reference' : 'manual';

  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;

  const result: BrandContract = {
    id,
    name,
    tokens,
    keep,
    change,
    doNotCopy,
    source,
    createdAt,
    updatedAt,
  };
  if (logoPath) result.logoPath = logoPath;
  return result;
}

/**
 * 取 brand 的 prompt 相关切片（喂进 brief.brandContract）。纯查询，可单测。
 */
export function brandContractToBriefProjection(brand: BrandContract): BrandBriefProjection {
  const projection: BrandBriefProjection = {
    keep: [...brand.keep],
    change: [...brand.change],
    doNotCopy: [...brand.doNotCopy],
  };
  if (brand.logoPath) projection.logoPath = brand.logoPath;
  return projection;
}
