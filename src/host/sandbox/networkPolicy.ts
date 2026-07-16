export const NETWORK_COMMANDS = [
  'curl',
  'wget',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'bun',
  'git',
  'gh',
  'pip',
  'pip3',
  'uv',
  'uvx',
  'brew',
  'cargo',
  'go',
  'gem',
  'bundle',
  'mvn',
  'gradle',
  'docker',
  'podman',
  'ssh',
  'scp',
  'rsync',
] as const;

export interface SandboxNetworkPolicyInput {
  command: string;
  redline?: boolean;
}

const NETWORK_COMMAND_PATTERN = new RegExp(
  `(?:^|[\\s;&|()])(?:sudo\\s+|command\\s+|env\\s+)?(?:${NETWORK_COMMANDS
    .map((cmd) => cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?=$|[\\s;&|()])`,
);

export function resolveSandboxNetworkPolicy(input: SandboxNetworkPolicyInput): boolean {
  if (input.redline) return false;
  return NETWORK_COMMAND_PATTERN.test(input.command);
}
