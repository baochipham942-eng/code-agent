import path from 'path';

/**
 * ESM evaluates static dependencies before eval-ci.ts can parse argv. Resolve the
 * process-scoped data directory here so product modules never observe the host default.
 */
const dataDirIndex = process.argv.indexOf('--data-dir');
const dataDir = dataDirIndex >= 0 ? process.argv[dataDirIndex + 1] : undefined;

if (dataDir?.trim()) {
  process.env.CODE_AGENT_DATA_DIR = path.resolve(process.cwd(), dataDir);
}
