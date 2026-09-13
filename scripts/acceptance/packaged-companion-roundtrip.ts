/**
 * Simulated LAN companion client against a live packaged-host invitation.
 * Reads the invitation from a 0600 file (never argv) and writes a sanitized
 * result. Pairing uses the production LanCompanionClient handshake path.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { LanCompanionClient, type LanPost } from '../../packages/mobile/src/platform/lanCompanionClient';
import { parseInvitation } from '../../src/shared/companion/lanProtocol';
import { createIdentity } from '../../src/shared/companion/noiseChannel';

function readArg(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function writeResult(outFile: string | undefined, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (outFile) writeFileSync(outFile, text);
  process.stdout.write(text);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const invitationFile = readArg(args, '--invitation-file');
  const outFile = readArg(args, '--out');
  if (!invitationFile) {
    writeResult(outFile, {
      ok: false,
      attempted: true,
      paired: false,
      error: '--invitation-file is required',
      approval: {
        status: 'NOT_RUN',
        reason: 'pairing did not start',
      },
    });
    process.exitCode = 1;
    return;
  }

  const raw = readFileSync(invitationFile, 'utf8');
  parseInvitation(raw);
  const post: LanPost = async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return JSON.parse(text) as unknown;
  };
  const client = new LanCompanionClient(createIdentity(), post);
  try {
    const binding = await client.pair(raw);
    const sync = await client.request({ action: 'sync', epoch: binding.scopeEpoch, afterSeq: 0 }) as {
      events?: unknown[];
      nextSeq?: number;
    };
    writeResult(outFile, {
      ok: true,
      attempted: true,
      paired: true,
      deviceId: binding.deviceId,
      scopeEpoch: binding.scopeEpoch,
      scope: binding.scope,
      endpoint: binding.endpoint,
      syncNextSeq: sync?.nextSeq ?? null,
      syncEventCount: Array.isArray(sync?.events) ? sync.events.length : null,
      approval: {
        status: 'NOT_RUN',
        reason: 'isolated packaged profile has no pending permission island; a real approval card is only published after an agent tool call',
      },
    });
  } catch (error) {
    writeResult(outFile, {
      ok: false,
      attempted: true,
      paired: false,
      error: error instanceof Error ? error.message : String(error),
      approval: {
        status: 'NOT_RUN',
        reason: 'pairing did not complete, so approval was not attempted',
      },
    });
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

await main();
