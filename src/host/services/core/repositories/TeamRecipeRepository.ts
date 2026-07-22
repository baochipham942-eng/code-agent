import type BetterSqlite3 from 'better-sqlite3';
import type { SkillCategory } from '@shared/contract/skillRepository';
import type { TeamRecipe, TeamRecipeMember } from '@shared/contract/teamRecipe';

type SQLiteRow = Record<string, unknown>;

export type TeamRecipeSource = 'builtin' | 'user' | 'cloud';

export interface StoredTeamRecipe extends TeamRecipe {
  source: TeamRecipeSource;
  packVersion?: string;
  createdAt: number;
  updatedAt: number;
}

function parseMembers(value: unknown): TeamRecipeMember[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as TeamRecipeMember[] : [];
  } catch {
    return [];
  }
}

function rowToRecipe(row: SQLiteRow): StoredTeamRecipe {
  const leadRoleId = row.lead_role_id as string | null;
  const leadBriefTemplate = row.lead_brief_template as string | null;
  return {
    id: row.id as string,
    source: row.source as TeamRecipeSource,
    name: row.name as string,
    description: (row.description as string | null) ?? '',
    category: row.category as SkillCategory,
    members: parseMembers(row.members_json),
    lead: leadRoleId === null && leadBriefTemplate === null
      ? undefined
      : { roleId: leadRoleId ?? '', briefTemplate: leadBriefTemplate ?? '' },
    packVersion: (row.pack_version as string | null) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export class TeamRecipeRepository {
  constructor(private db: BetterSqlite3.Database) {}

  list(source?: TeamRecipeSource): StoredTeamRecipe[] {
    const rows = source
      ? this.db.prepare('SELECT * FROM team_recipes WHERE source = ? ORDER BY updated_at DESC').all(source)
      : this.db.prepare('SELECT * FROM team_recipes ORDER BY updated_at DESC').all();
    return (rows as SQLiteRow[]).map(rowToRecipe);
  }

  get(id: string): StoredTeamRecipe | undefined {
    const row = this.db.prepare('SELECT * FROM team_recipes WHERE id = ?').get(id) as SQLiteRow | undefined;
    return row ? rowToRecipe(row) : undefined;
  }

  create(recipe: StoredTeamRecipe): void {
    this.db.prepare(`
      INSERT INTO team_recipes
        (id, source, name, description, category, lead_role_id, lead_brief_template, members_json, pack_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recipe.id, recipe.source, recipe.name, recipe.description || null, recipe.category,
      recipe.lead?.roleId ?? null, recipe.lead?.briefTemplate ?? null, JSON.stringify(recipe.members),
      recipe.packVersion ?? null, recipe.createdAt, recipe.updatedAt,
    );
  }

  update(recipe: StoredTeamRecipe): boolean {
    const result = this.db.prepare(`
      UPDATE team_recipes
      SET name = ?, description = ?, category = ?, lead_role_id = ?, lead_brief_template = ?,
          members_json = ?, pack_version = ?, updated_at = ?
      WHERE id = ?
    `).run(
      recipe.name, recipe.description || null, recipe.category, recipe.lead?.roleId ?? null,
      recipe.lead?.briefTemplate ?? null, JSON.stringify(recipe.members), recipe.packVersion ?? null,
      recipe.updatedAt, recipe.id,
    );
    return result.changes > 0;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM team_recipes WHERE id = ?').run(id).changes > 0;
  }
}
