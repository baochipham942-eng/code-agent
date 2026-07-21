import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Surface Execution durable restart acceptance', () => {
  it('reopens the production session store across distinct child processes without metadata injection', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'scripts/acceptance/surface-execution-durable-restart-smoke.ts',
    ), 'utf8');
    const persistPhase = source.slice(
      source.indexOf('async function persistPhase'),
      source.indexOf('async function recoverPhase'),
    );
    const recoverPhase = source.slice(
      source.indexOf('async function recoverPhase'),
      source.indexOf('function runChildPhase'),
    );
    const childRunner = source.slice(
      source.indexOf('function runChildPhase'),
      source.indexOf('async function main'),
    );

    expect(persistPhase).toContain('await initDatabase()');
    expect(persistPhase).toContain('sessionManager.createSession');
    expect(persistPhase).toContain('sessionStore: sessionManager');
    expect(persistPhase).toContain('sessionManager.getSession(conversationId');
    expect(persistPhase).toContain('new SurfaceExecutionRuntime({ runRegistry: registry })');
    expect(persistPhase).toContain('runtime.prepareBrowserSession({ identity })');
    expect(persistPhase).toContain('runtime.recordBrowserObservation({');
    expect(persistPhase).toContain('runtime.grants.issue({');
    expect(persistPhase).toContain("status: 'failed'");
    expect(persistPhase).toContain("action: 'adjust_fixture'");
    expect(persistPhase).toContain('Independent verification passed after the fixture adjustment');
    expect(persistPhase).toContain('await service.flushPersistence(conversationId)');
    expect(persistPhase).toContain('await sessionManager.exportSession(conversationId)');
    expect(recoverPhase).toContain('await initDatabase()');
    expect(recoverPhase).toContain('sessionManager.getSession(conversationId');
    expect(recoverPhase).toContain('productionSessionStoreReopened: true');
    expect(recoverPhase).toContain('freshObservationCaptured: true');
    expect(source).toContain('providerImplementationDefersExact');
    expect(childRunner).toContain('CODE_AGENT_DATA_DIR: dataDir');
    expect(childRunner).toContain("'--conversation-id'");
    expect(childRunner).toContain("'--surface-session-id'");
    expect(source).toContain('const campaignProof = surfaceAcceptanceCampaignProofFields();');
    expect(source.match(/\.\.\.campaignProof,/g)).toHaveLength(1);
    expect(source).toContain("const checkpointArtifactPath = join(outputDir, 'durable-checkpoint-evidence.json')");
    expect(source).toContain('checkpoint: {');
    expect(source).toContain('sha256: sha256File(checkpointArtifactPath)');
    expect(source).toContain('bytes: statSync(checkpointArtifactPath).size');
    expect(source).toContain('p2Acceptance: recoverDetails.p2Acceptance');
    expect(source).toContain("fileURLToPath(new URL('./surface-execution-replay-import-child.ts', import.meta.url))");
    expect(source).toContain("const replayDataDir = resolve(mkdtempSync(join(tmpdir(), 'code-agent-surface-replay-data-')))");
    expect(source).toContain('sourceExportPath: persistDetails.sourceExport.path');
    expect(source).toContain("const replayResultPath = join(outputDir, 'replay-import-process.json')");
    expect(source).toContain('sourceSemanticSha256: replayed.semantics.sourceSha256');
    expect(source).toContain('replaySemanticSha256: replayed.semantics.replaySha256');
    expect(source).toContain('assertAcceptanceCanaryAbsent(CANARY, [dataDir, replayDataDir, outputDir])');
    expect(source).not.toContain('snapshotConversation: () => live');
    expect(source).not.toContain('observer?.');
    expect(source).not.toContain('function createProjection');
    expect(source).not.toContain('createSessionStore');
    expect(source).not.toContain('CheckpointFileV1');
    expect(source).not.toContain("'--checkpoint'");
    expect(recoverPhase).not.toContain('checkpoint.metadata');
  });
});
