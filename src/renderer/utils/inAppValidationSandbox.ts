// in-app 验证 iframe：脚本可以跑，但绝不同源。
// allow-scripts + allow-same-origin 叠在 srcdoc 上 = 被测 HTML 能读 parent.document
// （N-VALIDATION-PANEL-ORIGIN-ISOLATION / #1670）。预览态 generative UI 已经是这套互斥，这里对齐。
export const IN_APP_VALIDATION_SANDBOX = 'allow-scripts allow-forms';

export const IN_APP_VALIDATION_CSP =
  "default-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data: blob:;";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${IN_APP_VALIDATION_CSP}">`;

/** 跨源后父页读不到 contentDocument；步骤靠 iframe 内驱动回 postMessage。 */
export const IN_APP_VALIDATION_DRIVER_FLAG = 'data-neo-in-app-driver';

const DRIVER_SCRIPT = `<script ${IN_APP_VALIDATION_DRIVER_FLAG}="1">
(function () {
  if (window.__neoInAppDriver) return;
  window.__neoInAppDriver = true;
  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg || msg.type !== 'neo-in-app-step') return;
    var step = msg.step || {};
    var action = step.action || {};
    var failures = [];
    var checks = [];
    var startedAt = Date.now();
    Promise.resolve().then(async function () {
      if (action.type === 'click-selector') {
        var el = document.querySelector(action.selector);
        if (!el) failures.push('selector not found: ' + action.selector);
        else { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); checks.push('clicked ' + action.selector); }
      } else if (action.type === 'type') {
        var active = document.activeElement;
        if (active && 'value' in active) {
          active.value = (active.value || '') + (action.text || '');
          active.dispatchEvent(new Event('input', { bubbles: true }));
          checks.push('typed');
        } else failures.push('no active element');
      } else if (action.type === 'wait') {
        await delay(action.ms || 0);
        checks.push('waited');
      } else if (action.type === 'click') {
        var target = document.elementFromPoint(action.x, action.y);
        if (!target) failures.push('no element at point');
        else { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: action.x, clientY: action.y })); checks.push('clicked point'); }
      } else if (action.type === 'press') {
        var keyTarget = document.activeElement || document.body;
        keyTarget.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true }));
        checks.push('pressed');
      } else if (action.type === 'hover') {
        var hoverEl = document.elementFromPoint(action.x, action.y);
        if (!hoverEl) failures.push('no element to hover');
        else { hoverEl.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window, clientX: action.x, clientY: action.y })); checks.push('hovered'); }
      }
      await delay(200);
      var exp = step.expect || {};
      var text = (document.body && document.body.innerText) || '';
      if (exp.textVisible && text.toLowerCase().indexOf(String(exp.textVisible).toLowerCase()) < 0) {
        failures.push('text not visible: ' + exp.textVisible);
      }
      if (exp.textHidden && text.toLowerCase().indexOf(String(exp.textHidden).toLowerCase()) >= 0) {
        failures.push('text not hidden: ' + exp.textHidden);
      }
      if (exp.selectorVisible && !document.querySelector(exp.selectorVisible)) {
        failures.push('selector not visible: ' + exp.selectorVisible);
      }
      if (exp.selectorHidden && document.querySelector(exp.selectorHidden)) {
        failures.push('selector not hidden: ' + exp.selectorHidden);
      }
    }).catch(function (err) {
      failures.push(String(err && err.message ? err.message : err));
    }).then(function () {
      var payload = {
        type: 'neo-in-app-result',
        id: msg.id,
        result: {
          label: step.label,
          viewport: step.viewport || 'in-app',
          action: action,
          passed: failures.length === 0,
          durationMs: Date.now() - startedAt,
          failures: failures,
          checks: checks,
        },
      };
      try { ev.source.postMessage(payload, '*'); }
      catch (e) { window.parent.postMessage(payload, '*'); }
    });
  });
})();
</script>`;

function injectCsp(html: string): string {
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${CSP_META}`);
  }
  if (/<html/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${CSP_META}</head>`);
  }
  return `<!DOCTYPE html><html><head>${CSP_META}</head><body>${html}</body></html>`;
}

function injectDriver(html: string): string {
  if (html.includes(IN_APP_VALIDATION_DRIVER_FLAG)) return html;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${DRIVER_SCRIPT}</body>`);
  }
  return `${html}${DRIVER_SCRIPT}`;
}

/** 给被测 HTML 塞 CSP + 跨源步骤驱动。没有 <head> 就包一层。 */
export function wrapInAppValidationHtml(html: string): string {
  return injectDriver(injectCsp(html));
}
