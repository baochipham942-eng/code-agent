import { execFileSync } from 'node:child_process';

const E2E_PORT_BASE = 20_000;
const E2E_PORT_SPAN = 20_000;

type ResolveE2eWebPortOptions = {
  explicitPort?: string;
  pid?: number;
  isPortInUse?: (port: number) => boolean;
};

function portIsInUse(port: number): boolean {
  try {
    return execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .length > 0;
  } catch {
    // lsof exits 1 when no process owns the port.
    return false;
  }
}

/** Keep concurrent E2E invocations off each other's web-server port. */
export function resolveE2eWebPort({
  explicitPort,
  pid = process.pid,
  isPortInUse = portIsInUse,
}: ResolveE2eWebPortOptions = {}): number {
  if (explicitPort) return Number(explicitPort);

  let port = E2E_PORT_BASE + (Math.abs(Math.trunc(pid)) % E2E_PORT_SPAN);
  for (let attempts = 0; attempts < E2E_PORT_SPAN; attempts += 1) {
    if (!isPortInUse(port)) return port;
    port = port === E2E_PORT_BASE + E2E_PORT_SPAN - 1 ? E2E_PORT_BASE : port + 1;
  }

  throw new Error('No free E2E web port available');
}
