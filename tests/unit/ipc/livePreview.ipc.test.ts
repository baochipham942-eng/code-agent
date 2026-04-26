import { describe, expect, it } from 'vitest';
import {
  resolveLivePreviewSourceLocation,
  validateLivePreviewDevServerUrl,
} from '../../../src/main/ipc/livePreview.ipc';
import { getDevServerManager } from '../../../src/main/services/infra/devServerManager';

describe('livePreview IPC helpers', () => {
  it('accepts only dev server URLs that match renderer frame-src', () => {
    expect(validateLivePreviewDevServerUrl('http://localhost:5173/')).toEqual({
      ok: true,
      url: 'http://localhost:5173/',
    });
    expect(validateLivePreviewDevServerUrl('https://localhost:5173/app')).toEqual({
      ok: true,
      url: 'https://localhost:5173/app',
    });
    expect(validateLivePreviewDevServerUrl('http://127.0.0.1:5173/')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:5173/',
    });

    expect(validateLivePreviewDevServerUrl('http://0.0.0.0:5173/')).toMatchObject({ ok: false });
    expect(validateLivePreviewDevServerUrl('http://192.168.1.8:5173/')).toMatchObject({ ok: false });
    expect(validateLivePreviewDevServerUrl('file:///tmp/index.html')).toMatchObject({ ok: false });
  });

  it('keeps resolved source files inside the project root', () => {
    const root = process.cwd();
    const resolved = resolveLivePreviewSourceLocation({
      file: 'src/renderer/App.tsx',
      projectRoot: root,
    });

    expect(resolved.absolute).toBe(`${root}/src/renderer/App.tsx`);
    expect(resolved.relative).toBe('src/renderer/App.tsx');
  });

  it('rejects source paths outside the project root', () => {
    expect(() => resolveLivePreviewSourceLocation({
      file: '../outside.ts',
      projectRoot: process.cwd(),
    })).toThrow('路径逃逸');
  });

  it('prefers the managed dev server project path when a session id is provided', () => {
    const manager = getDevServerManager();
    const originalGet = manager.get.bind(manager);
    const projectPath = `${process.cwd()}/.test-live-preview-project`;

    (manager as unknown as {
      get: typeof manager.get;
    }).get = (sessionId: string) => sessionId === 'dev-session-1'
      ? {
          sessionId,
          projectPath,
          framework: 'vite',
          packageManager: 'npm',
          status: 'ready',
          url: 'http://localhost:5173',
          pid: null,
          startedAt: 1,
        }
      : null;

    try {
      const resolved = resolveLivePreviewSourceLocation({
        file: 'src/App.tsx',
        projectRoot: process.cwd(),
        devServerSessionId: 'dev-session-1',
      });

      expect(resolved.absolute).toBe(`${projectPath}/src/App.tsx`);
      expect(resolved.relative).toBe('src/App.tsx');
    } finally {
      (manager as unknown as {
        get: typeof manager.get;
      }).get = originalGet;
    }
  });
});
