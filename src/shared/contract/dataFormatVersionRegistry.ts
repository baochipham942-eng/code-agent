export interface DataFormatMigration {
  fromVersion: number;
  toVersion: number;
  migrate: (value: unknown) => unknown;
}

export const SESSION_EXPORT_ENVELOPE_VERSION = 2 as const;
export const FORK_LINEAGE_ENVELOPE_VERSION = 1 as const;
export const PORTABLE_CONVERSATION_HISTORY_VERSION = 1 as const;
export const PORTABLE_WORKSPACE_EVIDENCE_VERSION = 1 as const;

const SESSION_SPINE_PACKAGE_VERSION = 2 as const;

export const DATA_FORMAT_VERSION_REGISTRY = {
  sessionExportEnvelope: {
    currentVersion: SESSION_EXPORT_ENVELOPE_VERSION,
    migrations: [],
  },
  forkLineageEnvelope: {
    currentVersion: FORK_LINEAGE_ENVELOPE_VERSION,
    migrations: [],
  },
  portableConversationHistory: {
    currentVersion: PORTABLE_CONVERSATION_HISTORY_VERSION,
    migrations: [],
  },
  portableWorkspaceEvidence: {
    currentVersion: PORTABLE_WORKSPACE_EVIDENCE_VERSION,
    migrations: [],
  },
  sessionSpinePackageManifest: {
    currentVersion: SESSION_SPINE_PACKAGE_VERSION,
    migrations: null,
  },
} as const satisfies Record<
  string,
  {
    currentVersion: number;
    migrations: readonly DataFormatMigration[] | null;
  }
>;

type ImportableDataFormat = Exclude<
  keyof typeof DATA_FORMAT_VERSION_REGISTRY,
  'sessionSpinePackageManifest'
>;

const FORMAT_LABELS: Record<ImportableDataFormat, string> = {
  sessionExportEnvelope: 'session export envelope',
  forkLineageEnvelope: 'fork lineage envelope',
  portableConversationHistory: 'portable conversation history',
  portableWorkspaceEvidence: 'portable workspace evidence',
};

export class DataFormatVersionError extends Error {
  readonly name = 'DataFormatVersionError';
}

function readVersion(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, 'version')
    ? record.version as number
    : 0;
}

export function migrateDataFormatToCurrent(
  format: ImportableDataFormat,
  value: unknown,
): unknown {
  const definition = DATA_FORMAT_VERSION_REGISTRY[format] as {
    currentVersion: number;
    migrations: readonly DataFormatMigration[];
  };
  const label = FORMAT_LABELS[format];
  let version = readVersion(value);

  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    throw new DataFormatVersionError(
      `${label} has invalid version ${String(version)}; expected a non-negative integer`,
    );
  }
  if ((version as number) > definition.currentVersion) {
    throw new DataFormatVersionError(
      `${label} has unknown version ${String(version)}; current version is ${definition.currentVersion}`,
    );
  }

  let migrated = value;
  while ((version as number) < definition.currentVersion) {
    const migration = definition.migrations.find((candidate) => (
      candidate.fromVersion === version
      && candidate.toVersion === (version as number) + 1
    ));
    if (!migration) {
      throw new DataFormatVersionError(
        `${label} version ${String(version)} has no registered migration to version ${definition.currentVersion}`,
      );
    }
    migrated = migration.migrate(migrated);
    version = readVersion(migrated);
    if (version !== migration.toVersion) {
      throw new DataFormatVersionError(
        `${label} migration ${migration.fromVersion}->${migration.toVersion} returned version ${String(version)}`,
      );
    }
  }

  return migrated;
}
