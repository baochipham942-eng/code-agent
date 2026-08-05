import type BetterSqlite3 from 'better-sqlite3';

export type SessionPackagePrivacy = 'shareable' | 'full_local';

interface PackageBuilderModule {
  buildSessionTranscriptJsonl(
    sessionId: string,
    options: { db: BetterSqlite3.Database; privacyLevel: SessionPackagePrivacy },
  ): Promise<string>;
  buildSessionPackage(
    sessionId: string,
    options: { db: BetterSqlite3.Database; privacyLevel: SessionPackagePrivacy },
  ): Promise<{ buffer: Buffer; suggestedFileName: string }>;
}

/**
 * Delayed boundary to Slice B. Keeping the module path non-literal lets Slice C
 * typecheck independently until the packageBuilder dependency is merged.
 */
export async function loadSessionPackageBuilder(): Promise<PackageBuilderModule> {
  const modulePath = '../../host/session/spine/packageBuilder';
  return import(modulePath) as Promise<PackageBuilderModule>;
}
