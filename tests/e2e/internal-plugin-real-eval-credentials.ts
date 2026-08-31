import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface ModelsConfig {
  default?: string;
  providers?: Record<string, unknown>;
}

async function seedChild(sourceDir: string, targetDir: string): Promise<void> {
  process.env.CODE_AGENT_DATA_DIR = targetDir;
  process.env.CODE_AGENT_CLI_MODE = '1';
  const { getSecureStorage, readModelCredentialsFromDataDir } = await import(
    '../../src/host/services/core/secureStorage'
  );
  const sourceConfig = JSON.parse(
    fs.readFileSync(path.join(sourceDir, 'config.json'), 'utf8'),
  ) as { models?: ModelsConfig };
  if (!sourceConfig.models?.default || !sourceConfig.models.providers) {
    throw new Error(`Real-eval source has no usable models config: ${sourceDir}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, 'config.json'),
    `${JSON.stringify({ models: sourceConfig.models }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const credentials = readModelCredentialsFromDataDir(sourceDir);
  const defaultCredential = `apikey.${sourceConfig.models.default}`;
  if (!credentials[defaultCredential]) {
    throw new Error(`Real-eval source is missing ${defaultCredential}`);
  }
  const secureStorage = getSecureStorage();
  for (const [key, value] of Object.entries(credentials)) {
    secureStorage.set(key as Parameters<typeof secureStorage.set>[0], value);
  }
  if (secureStorage.get(defaultCredential as Parameters<typeof secureStorage.get>[0])
    !== credentials[defaultCredential]) {
    throw new Error(`Real-eval target could not read back ${defaultCredential}`);
  }
  fs.writeFileSync(
    path.join(targetDir, 'REAL-EVAL-CREDENTIAL-SOURCE.txt'),
    [
      `${new Date().toISOString()} selectively imported local real-eval model configuration.`,
      `source=${sourceDir}`,
      `defaultProvider=${sourceConfig.models.default}`,
      `credentialKeys=${Object.keys(credentials).length}`,
      'included=models, apikey.*, serviceBaseUrl.*',
      'excluded=login state, sessions, approval policy, exec policy, history database',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({
    targetDir,
    defaultProvider: sourceConfig.models.default,
    credentialKeys: Object.keys(credentials).length,
    readBack: true,
  }));
}

export function prepareRealEvalCredentials(sourceDir: string, targetDir: string): void {
  const tsxCli = path.resolve(import.meta.dirname, '../../node_modules/tsx/dist/cli.mjs');
  const result = execFileSync(
    process.execPath,
    [tsxCli, import.meta.filename, '--seed-child', sourceDir, targetDir],
    {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env,
        CODE_AGENT_DATA_DIR: targetDir,
        CODE_AGENT_CLI_MODE: '1',
      },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const proofLine = result.trim().split('\n').at(-1) ?? '';
  const proof = JSON.parse(proofLine) as { readBack?: boolean; credentialKeys?: number };
  if (proof.readBack !== true || !proof.credentialKeys) {
    throw new Error(`Real-eval credential seed did not prove target read-back: ${result}`);
  }
}

if (process.argv[2] === '--seed-child') {
  const sourceDir = process.argv[3];
  const targetDir = process.argv[4];
  if (!sourceDir || !targetDir) throw new Error('Real-eval credential seed needs source and target');
  void seedChild(sourceDir, targetDir).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
