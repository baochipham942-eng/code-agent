import type BetterSqlite3 from 'better-sqlite3';
import { DurableRunRepository } from '../repositories';
import { applyDurableRunMigrationDraft } from './migrations/durableRun';

export abstract class DurableRunDatabaseSupport {
  private durableRunRepository?: DurableRunRepository;
  protected abstract ensureDb(): void;

  protected applyDurableRunMigration(db: BetterSqlite3.Database): void {
    applyDurableRunMigrationDraft(db);
  }

  protected initializeDurableRunRepository(db: BetterSqlite3.Database): void {
    this.durableRunRepository = new DurableRunRepository(db);
  }

  getDurableRunRepository(): DurableRunRepository {
    this.ensureDb();
    if (!this.durableRunRepository) {
      throw new Error('Durable Run persistence is unavailable');
    }
    return this.durableRunRepository;
  }
}
