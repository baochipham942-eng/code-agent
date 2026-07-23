import crypto from 'crypto';
import { getDatabase } from '../core/databaseService';
import { TeamRecipeRepository, type StoredTeamRecipe } from '../core/repositories/TeamRecipeRepository';
import { BUILTIN_ROLE_IDS, getBuiltinRoleVisual, listPersistentRoles } from '../roleAssets';
import { listAllAgents } from '../../agent/agentRegistry';
import { validateTeamRecipe, type TeamRecipe } from '@shared/contract/teamRecipe';

export type TeamRecipeWrite = Omit<TeamRecipe, 'id'>;
export interface KnownTeamRole {
  roleId: string;
  displayName: string;
  description: string;
  /** 职业（如「内容主理人」）；名册里跟在花名后，让模型和用户都知道这人是干什么的 */
  profession?: string;
}

export class TeamRecipeService {
  private get repo(): TeamRecipeRepository {
    const raw = getDatabase().getDb();
    if (!raw) throw new Error('Database not initialized');
    return new TeamRecipeRepository(raw);
  }

  async knownRoleIds(): Promise<Set<string>> {
    return new Set((await this.knownRoles()).map((role) => role.roleId));
  }

  async knownRoles(): Promise<KnownTeamRole[]> {
    const agents = listAllAgents();
    const resolvableAgentIds = new Set(agents.map((agent) => agent.id));
    const persistentRoleIds = await listPersistentRoles();
    const roleIds = new Set([...BUILTIN_ROLE_IDS, ...persistentRoleIds.filter((roleId) => resolvableAgentIds.has(roleId))]);
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const builtinRoleIds = new Set(BUILTIN_ROLE_IDS);
    return [...roleIds]
      .sort((left, right) => {
        const builtinOrder = Number(builtinRoleIds.has(right)) - Number(builtinRoleIds.has(left));
        return builtinOrder || left.localeCompare(right);
      })
      .map((roleId) => {
        const agent = agentsById.get(roleId);
        const visual = getBuiltinRoleVisual(roleId);
        return {
          roleId,
          displayName: agent?.name || visual?.displayName || roleId,
          description: agent?.description || '',
          profession: agent?.profession ?? visual?.profession,
        };
      });
  }

  list(): StoredTeamRecipe[] {
    return this.repo.list('user');
  }

  get(id: string): StoredTeamRecipe | undefined {
    return this.repo.get(id);
  }

  async create(recipe: TeamRecipeWrite, now: number = Date.now()): Promise<StoredTeamRecipe> {
    const stored: StoredTeamRecipe = {
      ...recipe,
      id: `user-${crypto.randomUUID()}`,
      source: 'user',
      createdAt: now,
      updatedAt: now,
    };
    this.assertValid(stored, await this.knownRoleIds());
    this.repo.create(stored);
    return stored;
  }

  async update(id: string, recipe: TeamRecipeWrite, now: number = Date.now()): Promise<StoredTeamRecipe | undefined> {
    const existing = this.repo.get(id);
    if (existing?.source !== 'user') return undefined;
    const stored: StoredTeamRecipe = {
      ...recipe,
      id,
      source: 'user',
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    this.assertValid(stored, await this.knownRoleIds());
    return this.repo.update(stored) ? stored : undefined;
  }

  delete(id: string): boolean {
    const existing = this.repo.get(id);
    return existing?.source === 'user' ? this.repo.delete(id) : false;
  }

  private assertValid(recipe: TeamRecipe, knownRoleIds: ReadonlySet<string>): void {
    const errors = validateTeamRecipe(recipe, knownRoleIds);
    if (errors.length > 0) throw new Error(errors.map((error) => error.reason).join('; '));
  }
}

let instance: TeamRecipeService | null = null;

export function getTeamRecipeService(): TeamRecipeService {
  if (!instance) instance = new TeamRecipeService();
  return instance;
}
