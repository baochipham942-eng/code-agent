import './remote-only.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = 'src/stores/mobileStore.ts';
const source = readFileSync(file, 'utf8');
const needle = 'await port.set(value);';
if (source.split(needle).length !== 2) throw new Error('PERSISTENCE_MUTATION_TARGET_CHANGED');
mkdirSync('.reports', { recursive: true });
try {
  writeFileSync(file, source.replace(needle, 'await Promise.resolve(); // mutation: drop durable write'));
  const result = spawnSync('npm', ['test'], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync('.reports/persistence-mutation.log', output);
  if (result.status === 0 || !output.includes('cold starts a new conversation') || !output.includes('AssertionError')) {
    throw new Error('PERSISTENCE_MUTATION_NOT_KILLED');
  }
  console.log('MUTATION_KILLED: removing durable writes makes restart-preservation assertions fail');
} finally { writeFileSync(file, source); }
