#!/usr/bin/env tsx

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { JSONSchema } from '../../src/shared/contract';
import { assertSupportedJsonSchema } from '../../src/host/tools/outputSchema';

interface RatchetBaseline {
  minimumToolCount: number;
  maxMissingOutputSchemas: number;
}

interface SchemaLike {
  name: string;
  inputSchema: unknown;
  outputSchema?: JSONSchema;
  category: string;
  permissionLevel: string;
}

const repoRoot = path.resolve(import.meta.dirname, '../..');
const baselinePath = path.join(import.meta.dirname, 'tool-output-schema-ratchet-baseline.json');
const defaultScanRoots = [
  'src/host/tools/modules',
  'src/host/plugins/builtin',
];

function readBaseline(): RatchetBaseline {
  const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Partial<RatchetBaseline>;
  if (!Number.isInteger(raw.minimumToolCount) || raw.minimumToolCount! < 1) {
    throw new Error('baseline.minimumToolCount must be a positive integer');
  }
  if (!Number.isInteger(raw.maxMissingOutputSchemas) || raw.maxMissingOutputSchemas! < 0) {
    throw new Error('baseline.maxMissingOutputSchemas must be a non-negative integer');
  }
  return raw as RatchetBaseline;
}

function collectSchemaFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) return collectSchemaFiles(candidate);
    return entry.isFile() && entry.name.endsWith('.schema.ts') ? [candidate] : [];
  });
}

function isToolSchema(value: unknown): value is SchemaLike {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string'
    && record.inputSchema !== null
    && typeof record.inputSchema === 'object'
    && typeof record.category === 'string'
    && typeof record.permissionLevel === 'string';
}

async function main(): Promise<void> {
  const baseline = readBaseline();
  const configuredRoots = process.env.TOOL_OUTPUT_SCHEMA_SCAN_ROOTS
    ?.split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const scanRoots = (configuredRoots?.length ? configuredRoots : defaultScanRoots)
    .map((entry) => path.resolve(repoRoot, entry));
  const files = [...new Set(scanRoots.flatMap(collectSchemaFiles))].sort();

  if (files.length === 0) {
    console.error('[tool-output-schema] scanned 0 schema files; scan roots are blind:');
    scanRoots.forEach((root) => console.error(`  - ${root}`));
    process.exitCode = 1;
    return;
  }

  const schemas: Array<{ schema: SchemaLike; file: string }> = [];
  for (const file of files) {
    const exports = await import(pathToFileURL(file).href);
    for (const value of Object.values(exports)) {
      if (!isToolSchema(value)) continue;
      schemas.push({ schema: value, file });
    }
  }

  if (schemas.length === 0) {
    console.error(`[tool-output-schema] scanned ${files.length} files but discovered 0 tools`);
    process.exitCode = 1;
    return;
  }

  let failed = false;
  if (schemas.length < baseline.minimumToolCount) {
    failed = true;
    console.error(
      `[tool-output-schema] discovered ${schemas.length} schema declarations, below baseline minimum ${baseline.minimumToolCount}; scan coverage shrank`,
    );
  }

  const missing = schemas
    .filter(({ schema }) => schema.outputSchema === undefined)
    .sort((a, b) => a.schema.name.localeCompare(b.schema.name));
  if (missing.length > 0) {
    console.error(`[tool-output-schema] tools missing outputSchema (${missing.length}):`);
    missing.forEach(({ schema, file }) => {
      console.error(`  - ${schema.name} (${path.relative(repoRoot, file)})`);
    });
  }
  if (missing.length > baseline.maxMissingOutputSchemas) {
    failed = true;
    console.error(
      `[tool-output-schema] missing count ${missing.length} exceeds ratchet ${baseline.maxMissingOutputSchemas}`,
    );
  }

  for (const { schema, file } of schemas) {
    if (!schema.outputSchema) continue;
    try {
      assertSupportedJsonSchema(schema.outputSchema, `${schema.name}.outputSchema`);
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tool-output-schema] unsupported schema in ${path.relative(repoRoot, file)}: ${message}`);
    }
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }

  const uniqueToolNames = new Set(schemas.map(({ schema }) => schema.name)).size;
  console.log(`[tool-output-schema] PASS: ${schemas.length} schema declarations (${uniqueToolNames} unique tool names) across ${files.length} files, ${missing.length} missing`);
}

await main();
