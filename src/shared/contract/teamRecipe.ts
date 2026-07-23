import type { SkillCategory } from './skillRepository';

export interface TeamRecipeMember {
  /** member-local 唯一键，dependsOn 引用它（同角色多实例时区分）；缺省视为 roleId */
  id?: string;
  /** 可解析的持久化角色 id（roles/<id>/ 目录名，内置或用户建） */
  roleId: string;
  /** 任务模板，含 {topic} 占位，启动时（E4-2）填用户输入的主题 */
  taskTemplate: string;
  /** 依赖的其它 member（引用其 id ?? roleId）；构成 DAG，禁止环 */
  dependsOn?: string[];
}

interface TeamRecipeLead {
  /** 主理人角色（可解析的持久化角色 id） */
  roleId: string;
  /** 含 {topic} 的主理人 SOP 简报 */
  briefTemplate: string;
}

export interface TeamRecipe {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  members: TeamRecipeMember[];
  lead?: TeamRecipeLead;
  tags?: string[];
}

export interface TeamRecipeValidationError {
  recipeId: string;
  code: TeamRecipeValidationErrorCode;
  reason: string;
}

type TeamRecipeValidationErrorCode =
  | 'unresolvable-role'
  | 'empty-members'
  | 'duplicate-member-key'
  | 'missing-brief'
  | 'lead-member-collision'
  | 'unknown-dependency'
  | 'cycle'
  | 'empty-task';

/** 每个 member 的解析键（dependsOn 的引用目标） */
export function teamRecipeMemberKey(member: TeamRecipeMember): string {
  return member.id ?? member.roleId;
}

/**
 * 上架硬门：配方合法才准用。返回错误列表（空=合法），类比 validateBuiltinRolePack。
 * knownRoleIds = 当前可解析的持久化角色 id 全集（内置+用户建）。
 */
export function validateTeamRecipe(
  recipe: TeamRecipe,
  knownRoleIds: ReadonlySet<string> | readonly string[],
): TeamRecipeValidationError[] {
  const known = knownRoleIds instanceof Set ? knownRoleIds : new Set(knownRoleIds);
  const errors: TeamRecipeValidationError[] = [];
  const err = (code: TeamRecipeValidationErrorCode, reason: string) => errors.push({ recipeId: recipe.id, code, reason });

  if (recipe.lead) {
    if (!recipe.lead.roleId || !known.has(recipe.lead.roleId)) {
      err('unresolvable-role', `lead roleId 不可解析：${recipe.lead.roleId || '(空)'}`);
    }
    if (!recipe.lead.briefTemplate.trim()) {
      err('missing-brief', 'lead 的 briefTemplate 为空');
    }
  }

  if (!recipe.members.length) err('empty-members', 'members 不能为空');

  const keys = recipe.members.map(teamRecipeMemberKey);
  if (recipe.lead && keys.includes(recipe.lead.roleId)) {
    err('lead-member-collision', `lead roleId 与 member 键重复：${recipe.lead.roleId}`);
  }

  const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicateKeys.length) {
    err('duplicate-member-key', `member 键重复：${[...new Set(duplicateKeys)].join(', ')}（同角色多实例请给不同 id）`);
  }

  for (const member of recipe.members) {
    if (!member.roleId || !known.has(member.roleId)) {
      err('unresolvable-role', `member roleId 不可解析：${member.roleId || '(空)'}`);
    }
    if (!member.taskTemplate.trim()) {
      err('empty-task', `member ${teamRecipeMemberKey(member)} 的 taskTemplate 为空`);
    }
    for (const dependency of member.dependsOn ?? []) {
      if (!keys.includes(dependency)) {
        err('unknown-dependency', `member ${teamRecipeMemberKey(member)} 依赖不存在的 ${dependency}`);
      }
    }
  }

  const graph = new Map<string, string[]>();
  for (const member of recipe.members) {
    graph.set(
      teamRecipeMemberKey(member),
      (member.dependsOn ?? []).filter((dependency) => keys.includes(dependency)),
    );
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const hasCycle = (node: string): boolean => {
    color.set(node, GRAY);
    for (const next of graph.get(node) ?? []) {
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === GRAY) return true;
      if (nextColor === WHITE && hasCycle(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  };

  for (const key of keys) {
    if ((color.get(key) ?? WHITE) === WHITE && hasCycle(key)) {
      err('cycle', 'dependsOn 存在环');
      break;
    }
  }

  return errors;
}
