import {
  existsSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';

export interface DevSurfaceExecutionConversationSeed {
  conversationId: string;
  evidenceAssetRef: string;
  outputHtmlAssetRef: string;
  outputImageAssetRef: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
    throw new Error(`${name} is required and must be at most 1024 characters.`);
  }
  return value.trim();
}

export function readDevSurfaceExecutionConversationSeed(
  value: unknown,
  workspace = process.cwd(),
): DevSurfaceExecutionConversationSeed {
  if (!isRecord(value)
    || Object.keys(value).some((key) => ![
      'conversationId',
      'evidenceAssetRef',
      'outputHtmlAssetRef',
      'outputImageAssetRef',
    ].includes(key))) {
    throw new Error('Seed body accepts only owner-scoped conversation and acceptance artifact refs.');
  }
  const conversationId = readRequiredString(value.conversationId, 'conversationId');
  const evidenceRoot = realpathSync(resolve(workspace, 'docs/acceptance/surface-execution'));
  const readArtifact = (input: unknown, name: string): string => {
    const requested = resolve(readRequiredString(input, name));
    if (!existsSync(requested) || lstatSync(requested).isSymbolicLink()) {
      throw new Error(`${name} must be an existing regular acceptance artifact.`);
    }
    const artifact = realpathSync(requested);
    if (!lstatSync(artifact).isFile()
      || (artifact !== evidenceRoot && !artifact.startsWith(`${evidenceRoot}${sep}`))) {
      throw new Error(`${name} must stay inside docs/acceptance/surface-execution.`);
    }
    return artifact;
  };
  return {
    conversationId,
    evidenceAssetRef: readArtifact(value.evidenceAssetRef, 'evidenceAssetRef'),
    outputHtmlAssetRef: readArtifact(value.outputHtmlAssetRef, 'outputHtmlAssetRef'),
    outputImageAssetRef: readArtifact(value.outputImageAssetRef, 'outputImageAssetRef'),
  };
}
