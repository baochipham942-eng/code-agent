import { describe, expect, it } from 'vitest';
import {
  IN_APP_VALIDATION_CSP,
  IN_APP_VALIDATION_SANDBOX,
  wrapInAppValidationHtml,
} from '../../../src/renderer/utils/inAppValidationSandbox';

describe('inAppValidationSandbox', () => {
  it('sandbox 不含 allow-same-origin', () => {
    expect(IN_APP_VALIDATION_SANDBOX.split(/\s+/)).toEqual(['allow-scripts', 'allow-forms']);
    expect(IN_APP_VALIDATION_SANDBOX).not.toContain('allow-same-origin');
  });

  it('CSP 禁 connect 且 img 不含 https，堵住外传像素', () => {
    expect(IN_APP_VALIDATION_CSP).toContain("connect-src 'none'");
    expect(IN_APP_VALIDATION_CSP).toContain("img-src 'self' data: blob:");
    expect(IN_APP_VALIDATION_CSP).not.toMatch(/img-src[^;]*https/);
  });

  it('已有 head 的文档把 CSP 插进 head，不包第二层 html', () => {
    const wrapped = wrapInAppValidationHtml('<!doctype html><html><head><title>x</title></head><body>hi</body></html>');
    expect(wrapped.match(/<html/gi)?.length).toBe(1);
    expect(wrapped).toContain('Content-Security-Policy');
    expect(wrapped).toContain('<title>x</title>');
  });

  it('片段包成完整文档并带 CSP', () => {
    const wrapped = wrapInAppValidationHtml('<button>ok</button>');
    expect(wrapped).toContain('<!DOCTYPE html>');
    expect(wrapped).toContain('Content-Security-Policy');
    expect(wrapped).toContain('<button>ok</button>');
  });

  it('注入跨源步骤驱动，父页不再依赖 contentDocument', () => {
    const wrapped = wrapInAppValidationHtml('<!doctype html><html><head></head><body>hi</body></html>');
    expect(wrapped).toContain('data-neo-in-app-driver');
    expect(wrapped).toContain('neo-in-app-step');
    expect(wrapped).toContain('function isVisible');
    expect(wrapped).toContain('nonblankCanvasCount');
    expect(wrapped).toContain('KeyboardEvent(\'keyup\'');
    expect(wrapped).toContain('waitFor');
    expect(wrapped).toContain('for (var i = 0; i < text.length');
  });
});
