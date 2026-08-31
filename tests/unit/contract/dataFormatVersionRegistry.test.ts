import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DATA_FORMAT_VERSION_REGISTRY } from '../../../src/shared/contract/dataFormatVersionRegistry';

describe('session data format version registry', () => {
  it('declares one current version and migration chain per importable format', () => {
    expect(DATA_FORMAT_VERSION_REGISTRY).toEqual({
      sessionExportEnvelope: { currentVersion: 2, migrations: [] },
      forkLineageEnvelope: { currentVersion: 1, migrations: [] },
      portableConversationHistory: { currentVersion: 1, migrations: [] },
      portableWorkspaceEvidence: { currentVersion: 1, migrations: [] },
      sessionSpinePackageManifest: { currentVersion: 2, migrations: null },
    });
  });

  it('keeps the spine manifest wired to the registry instead of a packageVersion literal', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/host/session/spine/packageBuilder.ts'),
      'utf8',
    );

    expect(source.includes(
      'packageVersion: DATA_FORMAT_VERSION_REGISTRY.sessionSpinePackageManifest.currentVersion',
    )).toBe(true);
    expect(source).not.toMatch(/packageVersion:\s*2\b/u);
  });

  it('keeps portable conversation history schema and version ownership out of host types', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'src/host/services/sessionFork/portability/conversationHistoryTypes.ts',
      ),
      'utf8',
    );

    expect(source).not.toContain("'neo.conversation-history' as const");
    expect(source).not.toMatch(/PORTABLE_CONVERSATION_HISTORY_VERSION\s*=\s*1\b/u);
  });
});
