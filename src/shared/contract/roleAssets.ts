// ============================================================================
// Role Assets - 渲染端 / 主进程共享类型（持久化角色资产）
// ============================================================================
//
// 主进程 src/main/services/roleAssets/ 是单一真理源。
// 这里只暴露跨进程序列化后的角色面板类型，供 IPC + 渲染端共用。

import type { AgentSource } from './agentRegistry';

/** 角色面板列表条目（设计 §7：卡片 = 名字/记忆条数/最近工作） */
export interface RolePanelEntry {
  /** 角色 ID = agents/<id>.md 的 frontmatter name = roles/<id>/ 目录名 */
  roleId: string;
  /** 角色描述（来自 agent 定义；无定义时为空） */
  description: string;
  /** agent 定义来源；角色目录存在但 agent 定义缺失时为 'orphan' */
  source: AgentSource | 'orphan';
  /** 角色记忆条数 */
  memoryCount: number;
  /** 最近一条工作履历（原始行） */
  lastWork: string | null;
}

/** 角色面板的单条记忆 */
export interface RolePanelMemory {
  filename: string;
  name: string;
  description: string;
  content: string;
  updatedAt: string;
}

/** 角色详情（设计 §7：定义 / 记忆 / 履历） */
export interface RolePanelDetail {
  roleId: string;
  /** agents/<id>.md 原始内容（只读展示）；定义文件缺失时为 null */
  definition: string | null;
  /** agent 定义文件路径（编辑跳转用） */
  definitionPath: string;
  /** 角色记忆（可删可编辑） */
  memories: RolePanelMemory[];
  /** 工作履历（产物清单，最新在后） */
  history: string[];
}
