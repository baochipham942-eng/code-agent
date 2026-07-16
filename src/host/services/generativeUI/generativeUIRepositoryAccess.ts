import { getDatabase } from '../core/databaseService';
import { GenerativeUIRepository } from '../core/repositories/GenerativeUIRepository';

export function getGenerativeUIRepository(): GenerativeUIRepository {
  const db = getDatabase().getDb();
  if (!db) throw new Error('Database not initialized');
  return new GenerativeUIRepository(db);
}
