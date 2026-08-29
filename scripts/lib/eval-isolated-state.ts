import type { DatabaseService } from '../../src/host/services/core/databaseService';
import type { TelemetryCollector } from '../../src/host/telemetry/telemetryCollector';

export interface IsolatedEvalState {
  database: DatabaseService;
  telemetryCollector: TelemetryCollector;
}

export async function createIsolatedEvalState(dataDir: string): Promise<IsolatedEvalState> {
  const [databaseModule, collectorModule, storageModule, promptCacheModule] = await Promise.all([
    import('../../src/host/services/core/databaseService'),
    import('../../src/host/telemetry/telemetryCollector'),
    import('../../src/host/telemetry/telemetryStorage'),
    import('../../src/host/telemetry/systemPromptCache'),
  ]);
  const database = new databaseModule.DatabaseService(dataDir);
  await database.initialize();
  const sqlite = database.getDb();
  if (!sqlite) {
    database.close();
    throw new Error('无法初始化独立的评测数据目录。');
  }
  const telemetryCollector = new collectorModule.TelemetryCollector(
    new storageModule.TelemetryStorage(sqlite),
    new promptCacheModule.SystemPromptCache(database),
  );
  return { database, telemetryCollector };
}
