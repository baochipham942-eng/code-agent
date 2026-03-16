// ============================================================================
// ipcService.test.ts - IPC 服务测试（mock window.electronAPI）
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ipcService } from '../../../src/renderer/services/ipcService';

// Setup window.electronAPI and window.domainAPI mocks
const mockInvoke = vi.fn();
const mockOn = vi.fn(() => () => {});
const mockOff = vi.fn();
const mockGetPathForFile = vi.fn();
const mockExtractPdfText = vi.fn();
const mockExtractExcelText = vi.fn();
const mockTranscribeSpeech = vi.fn();

const mockDomainInvoke = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();

  (globalThis as Record<string, unknown>).window = {
    electronAPI: {
      invoke: mockInvoke,
      on: mockOn,
      off: mockOff,
      getPathForFile: mockGetPathForFile,
      extractPdfText: mockExtractPdfText,
      extractExcelText: mockExtractExcelText,
      transcribeSpeech: mockTranscribeSpeech,
    },
    domainAPI: {
      invoke: mockDomainInvoke,
    },
  };
});

// ============================================================================
// invoke
// ============================================================================

describe('ipcService.invoke', () => {
  it('should call window.electronAPI.invoke with channel and args', () => {
    mockInvoke.mockReturnValue(Promise.resolve({ sessions: [] }));
    ipcService.invoke('session:list' as any);
    expect(mockInvoke).toHaveBeenCalledWith('session:list');
  });

  it('should pass through arguments', () => {
    mockInvoke.mockReturnValue(Promise.resolve(null));
    ipcService.invoke('session:load' as any, { sessionId: 'abc' } as any);
    expect(mockInvoke).toHaveBeenCalledWith('session:load', { sessionId: 'abc' });
  });

  it('should return the result from electronAPI', async () => {
    const expected = { id: '123', title: 'test' };
    mockInvoke.mockReturnValue(Promise.resolve(expected));
    const result = await ipcService.invoke('session:create' as any);
    expect(result).toEqual(expected);
  });
});

// ============================================================================
// on / off
// ============================================================================

describe('ipcService.on', () => {
  it('should register event listener', () => {
    const callback = vi.fn();
    ipcService.on('session:updated' as any, callback as any);
    expect(mockOn).toHaveBeenCalledWith('session:updated', callback);
  });

  it('should return unsubscribe function', () => {
    const unsubscribe = vi.fn();
    mockOn.mockReturnValue(unsubscribe);
    const result = ipcService.on('session:updated' as any, vi.fn() as any);
    expect(result).toBe(unsubscribe);
  });
});

describe('ipcService.off', () => {
  it('should unregister event listener', () => {
    const callback = vi.fn();
    ipcService.off('session:updated' as any, callback as any);
    expect(mockOff).toHaveBeenCalledWith('session:updated', callback);
  });
});

// ============================================================================
// isAvailable
// ============================================================================

describe('ipcService.isAvailable', () => {
  it('should return true when electronAPI exists', () => {
    expect(ipcService.isAvailable()).toBe(true);
  });

  it('should return false when electronAPI is missing', () => {
    // @ts-expect-error: testing absence
    globalThis.window = {};
    expect(ipcService.isAvailable()).toBe(false);
  });
});

// ============================================================================
// invokeDomain
// ============================================================================

describe('ipcService.invokeDomain', () => {
  it('should call domainAPI.invoke and return data on success', async () => {
    mockDomainInvoke.mockResolvedValue({ success: true, data: { id: '1' } });
    const result = await ipcService.invokeDomain('session', 'list');
    expect(mockDomainInvoke).toHaveBeenCalledWith('session', 'list', undefined);
    expect(result).toEqual({ id: '1' });
  });

  it('should pass payload to domainAPI', async () => {
    mockDomainInvoke.mockResolvedValue({ success: true, data: null });
    await ipcService.invokeDomain('session', 'create', { title: 'New' });
    expect(mockDomainInvoke).toHaveBeenCalledWith('session', 'create', { title: 'New' });
  });

  it('should throw on failure response', async () => {
    mockDomainInvoke.mockResolvedValue({
      success: false,
      error: { message: 'Not found' },
    });
    await expect(ipcService.invokeDomain('session', 'load', { sessionId: 'x' }))
      .rejects.toThrow('Not found');
  });

  it('should throw generic message when error message is empty', async () => {
    mockDomainInvoke.mockResolvedValue({ success: false, error: {} });
    await expect(ipcService.invokeDomain('session', 'delete'))
      .rejects.toThrow('session:delete failed');
  });
});

// ============================================================================
// getPathForFile
// ============================================================================

describe('ipcService.getPathForFile', () => {
  it('should delegate to electronAPI', () => {
    const file = new File(['content'], 'test.txt');
    mockGetPathForFile.mockReturnValue('/tmp/test.txt');
    const result = ipcService.getPathForFile(file);
    expect(result).toBe('/tmp/test.txt');
    expect(mockGetPathForFile).toHaveBeenCalledWith(file);
  });
});

// ============================================================================
// extractPdfText
// ============================================================================

describe('ipcService.extractPdfText', () => {
  it('should delegate to electronAPI', async () => {
    const expected = { text: 'Hello PDF', pageCount: 3 };
    mockExtractPdfText.mockResolvedValue(expected);
    const result = await ipcService.extractPdfText('/path/to/file.pdf');
    expect(result).toEqual(expected);
    expect(mockExtractPdfText).toHaveBeenCalledWith('/path/to/file.pdf');
  });
});

// ============================================================================
// transcribeSpeech
// ============================================================================

describe('ipcService.transcribeSpeech', () => {
  it('should delegate to electronAPI', async () => {
    const expected = { success: true, text: 'Hello world' };
    mockTranscribeSpeech.mockResolvedValue(expected);
    const result = await ipcService.transcribeSpeech('base64data', 'audio/webm');
    expect(result).toEqual(expected);
    expect(mockTranscribeSpeech).toHaveBeenCalledWith('base64data', 'audio/webm');
  });
});
