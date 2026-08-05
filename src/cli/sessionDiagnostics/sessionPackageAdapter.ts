import type BetterSqlite3 from 'better-sqlite3';
import {
  buildSessionPackage,
  buildSessionTranscriptJsonl,
} from '../../host/session/spine/packageBuilder';

export type SessionPackagePrivacy = 'shareable' | 'full_local';

interface PackageBuilderModule {
  buildSessionTranscriptJsonl(
    sessionId: string,
    options: { db: BetterSqlite3.Database; privacyLevel: SessionPackagePrivacy },
  ): string;
  buildSessionPackage(
    sessionId: string,
    options: { db: BetterSqlite3.Database; privacyLevel: SessionPackagePrivacy },
  ): Promise<{ buffer: Buffer; suggestedFileName: string }>;
}

export async function loadSessionPackageBuilder(): Promise<PackageBuilderModule> {
  return { buildSessionPackage, buildSessionTranscriptJsonl };
}
