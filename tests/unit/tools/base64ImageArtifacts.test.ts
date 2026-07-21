import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { persistBase64ImageMetadata } from '../../../src/host/tools/artifacts/base64ImageArtifacts';

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

describe('persistBase64ImageMetadata', () => {
  it('persists generic imageBase64 metadata as a file artifact and removes the inline payload', async () => {
    const workingDirectory = await mkdtemp(path.join(tmpdir(), 'code-agent-base64-image-'));

    const result = await persistBase64ImageMetadata({
      success: true,
      output: 'created image',
      metadata: {
        imageBase64: ONE_BY_ONE_PNG_BASE64,
        prompt: 'tiny image',
      },
    }, {
      sourceTool: 'custom_image_tool',
      workingDirectory,
      sessionId: 'session-1',
    });

    expect(result.outputPath).toMatch(/\.code-agent\/artifacts\/images\/custom_image_tool-\d+\.png$/);
    expect(result.metadata?.imageBase64).toBeUndefined();
    expect(result.metadata?.imagePath).toBe(result.outputPath);
    expect(result.metadata?.imageBase64Persisted).toBe(true);

    const artifact = result.metadata?.artifact as Record<string, unknown>;
    expect(artifact).toMatchObject({
      kind: 'image',
      sourceTool: 'custom_image_tool',
      sessionId: 'session-1',
      path: result.outputPath,
      mimeType: 'image/png',
    });
    expect(typeof artifact.sha256).toBe('string');

    const saved = await readFile(String(result.outputPath));
    expect(saved.length).toBeGreaterThan(0);
  });

  it('supports data URLs and keeps existing artifacts in the artifact list', async () => {
    const workingDirectory = await mkdtemp(path.join(tmpdir(), 'code-agent-base64-image-'));
    const existing = {
      artifactId: 'artifact-doc',
      kind: 'text',
      sourceTool: 'custom_image_tool',
      createdAt: '2026-01-01T00:00:00.000Z',
      path: '/tmp/report.md',
    };

    const result = await persistBase64ImageMetadata({
      success: true,
      metadata: {
        imageDataUrl: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`,
        artifact: existing,
      },
    }, {
      sourceTool: 'custom_image_tool',
      workingDirectory,
    });

    expect(result.metadata?.imageDataUrl).toBeUndefined();
    expect(result.metadata?.artifact).toBe(existing);
    const artifacts = result.metadata?.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: 'image',
      path: result.outputPath,
      metadata: {
        autoPersisted: true,
        sourceMetadataKey: 'imageDataUrl',
      },
    });
  });

  it('omits inline base64 when an image path already exists without writing a duplicate file', async () => {
    const workingDirectory = await mkdtemp(path.join(tmpdir(), 'code-agent-base64-image-'));

    const result = await persistBase64ImageMetadata({
      success: true,
      metadata: {
        imageBase64: ONE_BY_ONE_PNG_BASE64,
        imagePath: '/tmp/already-written.png',
      },
    }, {
      sourceTool: 'image_tool',
      workingDirectory,
    });

    expect(result.outputPath).toBeUndefined();
    expect(result.metadata?.imageBase64).toBeUndefined();
    expect(result.metadata?.imagePath).toBe('/tmp/already-written.png');
    expect(result.metadata?.imageBase64Persisted).toBe(false);
    expect(result.metadata?.imageBase64Omitted).toBe(true);
  });

  it('persists failed or ambiguous tool screenshots and never leaves inline base64 behind', async () => {
    const workingDirectory = await mkdtemp(path.join(tmpdir(), 'code-agent-base64-image-'));

    const result = await persistBase64ImageMetadata({
      success: false,
      error: 'delivery unknown',
      metadata: {
        imageBase64: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`,
        computerUseActionResultV1: {
          delivery: 'unknown',
          verification: 'inconclusive',
          overall: 'ambiguous',
        },
      },
    }, {
      sourceTool: 'cua_stateful_computer_use',
      workingDirectory,
      sessionId: 'session-failed',
    });

    expect(result.success).toBe(false);
    expect(result.metadata?.imageBase64).toBeUndefined();
    expect(result.metadata?.imageBase64Persisted).toBe(true);
    expect(result.outputPath).toMatch(/\.png$/);
    expect(result.metadata?.computerUseActionResultV1).toMatchObject({
      delivery: 'unknown',
      overall: 'ambiguous',
    });
  });
});
