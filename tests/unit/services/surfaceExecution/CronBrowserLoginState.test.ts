import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import {
  filterBrowserStorageStateForOrigin,
  importBrowserStorageStateForOrigin,
} from '../../../../src/host/services/surfaceExecution/CronBrowserLoginState';

describe('cron browser login state origin fence', () => {
  it('keeps only the requested origin cookies and Web Storage', () => {
    const filtered = filterBrowserStorageStateForOrigin({
      cookies: [
        { name: 'target', value: 'yes', domain: 'example.test', path: '/' },
        { name: 'leading-dot-host', value: 'yes', domain: '.example.test', path: '/' },
        { name: 'subdomain', value: 'no', domain: 'sub.example.test', path: '/' },
        { name: 'other', value: 'no', domain: 'other.test', path: '/' },
      ],
      origins: [
        { origin: 'https://example.test', localStorage: [{ name: 'session', value: 'yes' }] },
        { origin: 'https://other.test', localStorage: [{ name: 'session', value: 'no' }] },
      ],
    }, 'https://example.test/path');

    expect(filtered).toEqual({
      cookies: [
        { name: 'target', value: 'yes', domain: 'example.test', path: '/' },
        { name: 'leading-dot-host', value: 'yes', domain: '.example.test', path: '/' },
      ],
      origins: [
        { origin: 'https://example.test', localStorage: [{ name: 'session', value: 'yes' }] },
      ],
    });
  });

  it('imports the filtered state and never passes a second origin to the target', async () => {
    const exported = {
      cookies: [
        { name: 'target', value: 'yes', domain: 'example.test', path: '/' },
        { name: 'other', value: 'no', domain: 'other.test', path: '/' },
      ],
      origins: [
        { origin: 'https://example.test', localStorage: [{ name: 'session', value: 'yes' }] },
        { origin: 'https://other.test', localStorage: [{ name: 'session', value: 'no' }] },
      ],
    };
    const source = {
      exportStorageState: vi.fn(async (filePath: string) => {
        await fs.promises.writeFile(filePath, JSON.stringify(exported));
        return { path: filePath, accountState: {} };
      }),
    } as unknown as BrowserService;
    let imported: Record<string, unknown> | undefined;
    const target = {
      importStorageState: vi.fn(async (filePath: string) => {
        imported = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as Record<string, unknown>;
        return {};
      }),
    } as unknown as BrowserService;

    await expect(importBrowserStorageStateForOrigin(source, target, 'https://example.test'))
      .resolves.toBe(true);
    expect(target.importStorageState).toHaveBeenCalledOnce();
    expect(imported).toEqual({
      cookies: [{ name: 'target', value: 'yes', domain: 'example.test', path: '/' }],
      origins: [{ origin: 'https://example.test', localStorage: [{ name: 'session', value: 'yes' }] }],
    });
    expect(JSON.stringify(imported)).not.toContain('other.test');
  });
});
