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

  it('不把脚本字符串里的 </body> 当闭合标签', () => {
    const source = '<!doctype html><html><head></head><body><script>const suffix = "</body>";</script></body></html>';
    const wrapped = wrapInAppValidationHtml(source);
    expect(wrapped).toContain('const suffix = "</body>";');
    expect(wrapped.match(/data-neo-in-app-driver/g)?.length).toBe(1);
    const driverAt = wrapped.indexOf('data-neo-in-app-driver');
    const scriptAt = wrapped.indexOf('const suffix');
    expect(driverAt).toBeGreaterThan(0);
    expect(scriptAt).toBeGreaterThan(driverAt);
  });

  it('不把脚本字符串里的 <head> 当真实 head', () => {
    const source = '<html><body><script>const template = "<head>";</script><button>ok</button></body></html>';
    const wrapped = wrapInAppValidationHtml(source);
    expect(wrapped).toContain('const template = "<head>";');
    const scriptAt = wrapped.indexOf('const template');
    const cspAt = wrapped.indexOf('Content-Security-Policy');
    expect(cspAt).toBeGreaterThan(0);
    expect(cspAt).toBeLessThan(scriptAt);
  });

  it('不把 style 文本里的 <head> 当真实 head', () => {
    const source = '<style>.x::before{content:"<head>"}</style><button id="ok">ok</button>';
    const wrapped = wrapInAppValidationHtml(source);
    expect(wrapped).toContain('content:"<head>"');
    const styleOpen = wrapped.indexOf('<style>');
    const styleClose = wrapped.indexOf('</style>');
    const cspAt = wrapped.indexOf('Content-Security-Policy');
    const driverAt = wrapped.indexOf('data-neo-in-app-driver');
    expect(styleOpen).toBeGreaterThan(0);
    expect(styleClose).toBeGreaterThan(styleOpen);
    expect(cspAt).toBeGreaterThan(0);
    expect(driverAt).toBeGreaterThan(0);
    expect(cspAt).toBeLessThan(styleOpen);
    expect(driverAt).toBeLessThan(styleOpen);
    expect(wrapped.slice(styleOpen, styleClose)).not.toContain('data-neo-in-app-driver');
    expect(wrapped.slice(styleOpen, styleClose)).not.toContain('Content-Security-Policy');
  });

  it('驱动插在工作台 CSP 之后、页面自带 CSP 之前，避免 script-src none 拦掉', () => {
    const source = '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></head><body><button id="ok">ok</button></body></html>';
    const wrapped = wrapInAppValidationHtml(source);
    const ours = wrapped.indexOf(IN_APP_VALIDATION_CSP);
    const driver = wrapped.indexOf('data-neo-in-app-driver');
    const theirs = wrapped.indexOf("script-src 'none'");
    expect(ours).toBeGreaterThanOrEqual(0);
    expect(driver).toBeGreaterThan(ours);
    expect(theirs).toBeGreaterThan(driver);
  });

  it('不把注释里的 </body> 当闭合标签', () => {
    const source = '<html><body>ok</body><!-- </body> --></html>';
    const wrapped = wrapInAppValidationHtml(source);
    expect(wrapped).toContain('<!-- </body> -->');
    expect(wrapped.match(/data-neo-in-app-driver/g)?.length).toBe(1);
    const commentInner = wrapped.indexOf('<!--');
    expect(wrapped.slice(commentInner, wrapped.indexOf('-->', commentInner) + 3)).not.toContain('data-neo-in-app-driver');
  });
});
