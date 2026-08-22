#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { z } from 'zod';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const schemaModulePath = path.join(repoRoot, 'src/shared/contract/agentEventSchemas.ts');
const generatedPath = path.join(repoRoot, 'src/shared/contract/generated/agent-events.schema.json');
const write = process.argv.includes('--write');
const unsupportedArgs = process.argv.slice(2).filter((arg) => arg !== '--write');

if (unsupportedArgs.length > 0) {
  console.error(`[agent-event-schema-gate] ✗ unsupported arguments: ${unsupportedArgs.join(' ')}`);
  process.exit(1);
}
if (!fs.existsSync(schemaModulePath)) {
  console.error('[agent-event-schema-gate] ✗ source schema module is missing');
  process.exit(1);
}

const schemaModule = await tsImport(pathToFileURL(schemaModulePath).href, import.meta.url);
const schema = schemaModule.AgentEventEnvelopeSchema;
if (!schema || typeof schema.safeParse !== 'function') {
  console.error('[agent-event-schema-gate] ✗ AgentEventEnvelopeSchema export is missing or invalid');
  process.exit(1);
}

const jsonSchema = z.toJSONSchema(schema, {
  target: 'draft-2020-12',
  reused: 'ref',
});
const generated = `${JSON.stringify(jsonSchema, null, 2)}\n`;

if (write) {
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(generatedPath, generated, 'utf8');
  console.log(`[agent-event-schema-gate] ✓ wrote ${path.relative(repoRoot, generatedPath)}`);
  process.exit(0);
}

if (!fs.existsSync(generatedPath)) {
  console.error('[agent-event-schema-gate] ✗ generated schema is missing; run with --write');
  process.exit(1);
}

const committed = fs.readFileSync(generatedPath, 'utf8');
if (committed !== generated) {
  let firstDifference = 0;
  const limit = Math.min(committed.length, generated.length);
  while (firstDifference < limit && committed[firstDifference] === generated[firstDifference]) {
    firstDifference += 1;
  }
  console.error(`[agent-event-schema-gate] ✗ schema drift at byte ${firstDifference}; run node scripts/agent-event-schema-gate.mjs --write`);
  process.exit(1);
}

console.log('[agent-event-schema-gate] ✓ committed schema matches AgentEventEnvelopeSchema');
