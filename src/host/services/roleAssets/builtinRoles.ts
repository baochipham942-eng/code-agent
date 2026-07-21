// ============================================================================
// Builtin Roles — 预设持久化角色（设计 §6.1，MVP 第一批 2 个）
// ============================================================================
//
// 随产品分发，开箱即用：
//   研究员     — 调研、信息收集、报告产出（web/search 工具组 + 调研类 skills）
//   数据分析师 — 数据处理、看板、周报（Excel/chart 工具组 + 数据类 skills）
//
// 分发方式：首次启动时写入用户目录（幂等，已存在不覆盖——用户可自由编辑）：
//   ~/.code-agent/agents/<角色名>.md   ← 角色定义（Claude Code 兼容格式，零侵入）
//   ~/.code-agent/roles/<角色名>/       ← 角色资产骨架（MEMORY.md / memories/ / history.md）
//
// "定义是出厂设置，记忆是使用痕迹"——定义文件创建后归用户所有，本函数不覆盖；
// 角色记忆永远是用户自己积累的。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SkillCategory } from '../../../shared/contract/skillRepository';
import { parseAgentMd } from '../../agent/hybrid/agentMdLoader';
import { getAgentsMdDir } from '../../config/configPaths';
import { createLogger } from '../infra/logger';
import { ensureRoleAssetDirs } from './roleAssetService';

const logger = createLogger('BuiltinRoles');

// ----------------------------------------------------------------------------
// 角色定义
// ----------------------------------------------------------------------------

/** 预设角色视觉元数据（P2-1 + E1 Role Pack 展示合同，与技能包共用 SkillCategory 分类体系） */
export interface BuiltinRoleVisual {
  /** lucide 图标名（curated，前端按名渲染） */
  icon: string;
  /** 产物分类（复用 SkillCategory 子集） */
  category: SkillCategory;
  /** 展示名（花名，与 roleId 一致或更口语） */
  displayName: string;
  /** 职业（如"资深产品经理"，展示在花名旁） */
  profession: string;
  /** 能力标签（3 个左右，发现页卡片展示） */
  tags: string[];
  /** 快捷开场 prompt（一句话真实 cowork 场景，点击即发） */
  quickPrompts: string[];
}

export interface BuiltinRoleDefinition {
  /** 角色 ID = agents/<id>.md 文件名 = roles/<id>/ 目录名 */
  id: string;
  /** agents/<id>.md 的完整内容（frontmatter + system prompt） */
  agentMd: string;
  /**
   * 视觉化 metadata（P2-1）：随产品分发，不写入用户 agent 定义文件，
   * 由 roles IPC 在构建 RolePanelEntry 时按 id 回填。
   */
  visual: BuiltinRoleVisual;
}

export const BUILTIN_ROLE_IDS = ['研究员', '数据分析师'] as const;

export const BUILTIN_ROLES: BuiltinRoleDefinition[] = [
  {
    id: '研究员',
    agentMd: `---
name: 研究员
description: 调研、信息收集、报告产出专家
tools: [Glob, Grep, Read, ListDirectory, Write, WebSearch, WebFetch, ReadDocument, MemoryRead, MemoryWrite, TaskManager]
skills: [literature-review, paper-distillation]
model: balanced
max-iterations: 20
---

你是一名专业研究员，负责调研、信息收集和报告产出。

## 核心能力
1. **信息检索**：用 WebSearch / WebFetch 搜集一手信息，交叉验证多个来源
2. **文献阅读**：用 ReadDocument 读 PDF / Word，提炼关键论点
3. **结构化输出**：调研结论以结构化报告呈现（背景 → 发现 → 证据 → 结论）

## 工作准则
- 信息必须注明来源，区分事实与推断
- 多源交叉验证，单一来源的结论标注"待验证"
- 调研中发现的可复用知识（领域口径、靠谱信源、用户偏好）值得写入角色记忆

## 输出格式
调研报告包含：摘要（3 句以内）、关键发现（带来源）、证据清单、结论与建议。
`,
    visual: {
      icon: 'Microscope',
      category: 'research',
      displayName: '研究员',
      profession: '研究员',
      tags: ['信息检索', '文献阅读', '调研报告'],
      quickPrompts: [
        '帮我调研一下这个主题，产出一份带来源的报告',
        '帮我读一下这份 PDF，提炼关键论点',
      ],
    },
  },
  {
    id: '数据分析师',
    agentMd: `---
name: 数据分析师
description: 数据处理、看板、周报专家
tools: [Read, Write, Bash, Glob, Grep, ListDirectory, read_xlsx, excel_generate, ExcelAutomate, chart_generate, MemoryRead, MemoryWrite, TaskManager]
skills: [data-analysis-helper, data-cleaning, xlsx]
model: balanced
max-iterations: 20
---

你是一名专业数据分析师，负责数据处理、看板搭建和周报产出。

## 核心能力
1. **数据读取**：用 read_xlsx / ExcelAutomate 读取和处理表格数据
2. **数据清洗**：识别缺失值、异常值、口径不一致问题
3. **可视化**：用 chart_generate 生成图表，用 excel_generate 产出报表

## 工作准则
- 数据口径优先：分析前先确认指标定义（如 GMV 是否含退款）
- 结论必须可追溯到数据，不做无依据的推断
- 用户的业务口径、报表模板偏好、常用指标定义值得写入角色记忆

## 输出格式
分析报告包含：数据概览、关键指标、异常点、趋势判断、建议动作。
`,
    visual: {
      icon: 'BarChart3',
      category: 'data-analysis',
      displayName: '数据分析师',
      profession: '数据分析师',
      tags: ['数据清洗', '图表看板', '周报'],
      quickPrompts: [
        '帮我分析这份表格，找出关键指标和异常点',
        '把这些数据做成图表和一页结论',
      ],
    },
  },
];

/** 预设角色视觉 metadata 按 id 查表（P2-1：roles IPC 回填 RolePanelEntry 用） */
const BUILTIN_ROLE_VISUAL_BY_ID = new Map<string, BuiltinRoleVisual>(
  BUILTIN_ROLES.map((role) => [role.id, role.visual]),
);

/** 取预设角色视觉 metadata；非预设角色返回 undefined（前端兜底默认 icon + "其他"分类） */
export function getBuiltinRoleVisual(roleId: string): BuiltinRoleVisual | undefined {
  return BUILTIN_ROLE_VISUAL_BY_ID.get(roleId);
}

// ----------------------------------------------------------------------------
// Role Pack 校验（E1 §8.5：纯 prompt 无 skill 的包校验失败，不能上架）
// ----------------------------------------------------------------------------

export interface RolePackIssue {
  roleId: string;
  issue: string;
}

/**
 * 校验单个预设 Role Pack：
 * - agentMd frontmatter 可解析，且 frontmatter name 与 id 一致
 * - frontmatter skills 非空（禁纯 prompt 空壳包）
 * - 每个 skill 名都能在 knownSkillNames（内置 skill 全集）里解析——
 *   内置包不得依赖需安装的外部 skill，否则破坏开箱即用
 * - visual 的 tags / quickPrompts 非空（E2 发现页展示合同）
 *
 * knownSkillNames 由调用方注入（测试/上架点传 BUILTIN_SKILLS 名字集），
 * 本模块不反向依赖 skills 数据层。
 */
export function validateBuiltinRolePack(
  role: BuiltinRoleDefinition,
  knownSkillNames: ReadonlySet<string>,
): RolePackIssue[] {
  const issues: RolePackIssue[] = [];
  const push = (issue: string) => issues.push({ roleId: role.id, issue });

  const parsed = parseAgentMd(role.agentMd, `${role.id}.md`);
  if (!parsed) {
    push('agentMd frontmatter 无法解析');
    return issues;
  }
  if (parsed.name !== role.id) {
    push(`frontmatter name "${parsed.name}" 与 roleId "${role.id}" 不一致`);
  }
  if (!parsed.skills || parsed.skills.length === 0) {
    push('未绑定任何 skill（纯 prompt 空壳包）');
  } else {
    for (const skillName of parsed.skills) {
      if (!knownSkillNames.has(skillName)) {
        push(`skill "${skillName}" 不在内置 skill 全集中（内置包不得依赖需安装的 skill）`);
      }
    }
  }
  if (role.visual.tags.length === 0) {
    push('visual.tags 为空');
  }
  if (role.visual.quickPrompts.length === 0) {
    push('visual.quickPrompts 为空');
  }
  return issues;
}

// ----------------------------------------------------------------------------
// 安装（幂等）
// ----------------------------------------------------------------------------

export interface InstallBuiltinRolesResult {
  /** 本次新写入的 agent 定义 */
  installedAgents: string[];
  /** 本次新创建的角色资产目录 */
  installedRoleDirs: string[];
}

/**
 * 安装预设角色到用户目录（幂等）：
 * - agents/<id>.md 不存在才写（用户编辑过的定义不覆盖）
 * - roles/<id>/ 骨架不存在才建（角色记忆永远归用户）
 *
 * 调用时机：应用启动、agentRegistry 初始化之前（desktop 与 webServer 两条路径都要调）。
 * 任何失败只记日志，不阻塞启动。
 */
export async function installBuiltinRoles(): Promise<InstallBuiltinRolesResult> {
  const result: InstallBuiltinRolesResult = { installedAgents: [], installedRoleDirs: [] };
  const agentsDir = getAgentsMdDir().user;

  try {
    await fs.mkdir(agentsDir, { recursive: true });
  } catch (err) {
    logger.warn('Failed to create agents dir, skip builtin roles install', { error: String(err) });
    return result;
  }

  for (const role of BUILTIN_ROLES) {
    // 1. agent 定义（不存在才写）
    const agentMdPath = path.join(agentsDir, `${role.id}.md`);
    try {
      const alreadyExists = await fs.access(agentMdPath).then(() => true, () => false);
      if (!alreadyExists) {
        await fs.writeFile(agentMdPath, role.agentMd, 'utf-8');
        result.installedAgents.push(role.id);
      }
    } catch (err) {
      logger.warn('Failed to install builtin role agent definition', { roleId: role.id, error: String(err) });
    }

    // 2. 角色资产骨架（ensureRoleAssetDirs 本身幂等）
    try {
      const { isPersistentRole } = await import('./roleAssetService');
      const existed = await isPersistentRole(role.id);
      await ensureRoleAssetDirs(role.id);
      if (!existed) {
        result.installedRoleDirs.push(role.id);
      }
    } catch (err) {
      logger.warn('Failed to install builtin role asset dirs', { roleId: role.id, error: String(err) });
    }
  }

  if (result.installedAgents.length > 0 || result.installedRoleDirs.length > 0) {
    logger.info('Builtin roles installed', result);
  }
  return result;
}
