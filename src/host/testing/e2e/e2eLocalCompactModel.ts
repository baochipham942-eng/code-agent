export function shouldUseE2ELocalCompactModel(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_E2E === '1' && env.CODE_AGENT_E2E_LOCAL_COMPACT_MODEL === '1';
}

export function buildE2ELocalCompactSummary(prompt: string): string {
  const promptDigest = Buffer.from(prompt).toString('base64').slice(0, 24);
  return [
    'E2E local compact summary.',
    `Prompt digest: ${promptDigest}`,
    'Earlier conversation turns were compacted by the compact model boundary during app-host smoke.',
  ].join('\n');
}
