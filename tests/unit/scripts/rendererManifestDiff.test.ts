import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRendererManifestDiff,
  extractRendererManifestPayload,
  formatRendererManifestDiffMarkdown,
} from '../../../scripts/renderer-manifest-diff.mjs';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-manifest-diff-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('renderer manifest diff', () => {
  it('compares field changes and required shell capabilities', () => {
    const baseManifest = extractRendererManifestPayload({
      version: '0.16.93',
      minShellVersion: '0.16.93',
      contentHash: 'a'.repeat(64),
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: [
        'domain:update/check',
        'domain:mcp/listTools',
      ],
      requiredRuntimeAssets: ['onnxruntime-vad'],
      requiredResources: ['resources/browser-relay-extension'],
    });
    const headManifest = extractRendererManifestPayload({
      version: '0.17.0',
      minShellVersion: '0.16.93',
      contentHash: 'b'.repeat(64),
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: [
        'domain:mcp/listTools',
        'domain:workspace/openPath',
      ],
      requiredRuntimeAssets: ['playwright-browser-runtime'],
      requiredResources: ['resources/browser-relay-extension', 'resources/new-worker'],
    });

    const diff = buildRendererManifestDiff({ baseManifest, headManifest });

    expect(diff.fieldChanges).toEqual([
      { field: 'version', base: '0.16.93', head: '0.17.0' },
      { field: 'contentHash', base: 'a'.repeat(64), head: 'b'.repeat(64) },
    ]);
    expect(diff.addedRequiredShellCapabilities).toEqual(['domain:workspace/openPath']);
    expect(diff.removedRequiredShellCapabilities).toEqual(['domain:update/check']);
    expect(diff.addedRequiredRuntimeAssets).toEqual(['playwright-browser-runtime']);
    expect(diff.removedRequiredRuntimeAssets).toEqual(['onnxruntime-vad']);
    expect(diff.addedRequiredResources).toEqual(['resources/new-worker']);
    expect(diff.removedRequiredResources).toEqual([]);
    expect(formatRendererManifestDiffMarkdown(diff)).toContain('Required shell capabilities: 2 -> 2');
    expect(formatRendererManifestDiffMarkdown(diff)).toContain('Required runtime assets: 1 -> 1');
    expect(formatRendererManifestDiffMarkdown(diff)).toContain('Required resources: 1 -> 2');
  });

  it('reports rollback manifest changes without archive fields', () => {
    const baseManifest = extractRendererManifestPayload({
      version: '0.17.0',
      minShellVersion: '0.16.93',
      contentHash: 'c'.repeat(64),
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: ['domain:mcp/listTools'],
      requiredRuntimeAssets: ['playwright-browser-runtime'],
      requiredResources: ['resources/browser-relay-extension'],
    });
    const headManifest = extractRendererManifestPayload({
      version: '0.17.0',
      minShellVersion: '0.16.93',
      rollbackToBuiltin: true,
      rollbackReason: 'bad overlay',
    });

    const diff = buildRendererManifestDiff({ baseManifest, headManifest });

    expect(diff.fieldChanges).toEqual([
      { field: 'contentHash', base: 'c'.repeat(64), head: '' },
      {
        field: 'bundleUrl',
        base: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
        head: '',
      },
      { field: 'rollbackToBuiltin', base: 'false', head: 'true' },
      { field: 'rollbackReason', base: '', head: 'bad overlay' },
    ]);
    expect(diff.removedRequiredShellCapabilities).toEqual(['domain:mcp/listTools']);
    expect(diff.removedRequiredRuntimeAssets).toEqual(['playwright-browser-runtime']);
    expect(diff.removedRequiredResources).toEqual(['resources/browser-relay-extension']);
  });

  it('formats first-publish diffs when no base manifest exists', () => {
    const headManifest = extractRendererManifestPayload({
      version: '0.17.0',
      minShellVersion: '0.16.93',
      contentHash: 'd'.repeat(64),
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check'],
      requiredRuntimeAssets: ['playwright-browser-runtime'],
      requiredResources: ['resources/browser-relay-extension'],
    });

    const diff = buildRendererManifestDiff({ baseManifest: null, headManifest });

    expect(diff.basePresent).toBe(false);
    expect(diff.addedRequiredShellCapabilities).toEqual(['domain:update/check']);
    expect(diff.addedRequiredRuntimeAssets).toEqual(['playwright-browser-runtime']);
    expect(diff.addedRequiredResources).toEqual(['resources/browser-relay-extension']);
    expect(formatRendererManifestDiffMarkdown(diff)).toContain('Current latest: not found');
  });

  it('writes JSON output-friendly diff objects', () => {
    const output = path.join(tmp, 'diff.json');
    const headManifest = extractRendererManifestPayload({
      version: '0.17.0',
      minShellVersion: '0.16.93',
      contentHash: 'e'.repeat(64),
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
    });
    const diff = buildRendererManifestDiff({ baseManifest: null, headManifest });

    fs.writeFileSync(output, JSON.stringify(diff, null, 2));

    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({
      basePresent: false,
      headVersion: '0.17.0',
    });
  });
});
