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
  var SETTLE_MS = 200;
  var POLL_MS = 80;
  var DEFAULT_EXPECT_MS = 5000;
  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function mouse(target, type, x, y) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
  }
  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return true;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return true;
  }
  async function waitFor(predicate, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(POLL_MS);
    }
    return predicate();
  }
  function nonblankCanvasCount() {
    var count = 0;
    document.querySelectorAll('canvas').forEach(function (canvas) {
      try {
        var context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context || canvas.width <= 0 || canvas.height <= 0) return;
        var pixel = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        if (pixel[3] > 8 && pixel[0] + pixel[1] + pixel[2] > 28) count += 1;
      } catch (e) {}
    });
    return count;
  }
  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg || msg.type !== 'neo-in-app-step') return;
    var step = msg.step || {};
    var action = step.action || {};
    var failures = [];
    var checks = [];
    var startedAt = Date.now();
    Promise.resolve().then(async function () {
      if (action.type === 'click') {
        var clickTarget = document.elementFromPoint(action.x, action.y);
        if (!clickTarget) failures.push('no element at (' + action.x + ', ' + action.y + ')');
        else {
          mouse(clickTarget, 'mousedown', action.x, action.y);
          mouse(clickTarget, 'mouseup', action.x, action.y);
          mouse(clickTarget, 'click', action.x, action.y);
          checks.push('clicked at (' + action.x + ', ' + action.y + ')');
        }
      } else if (action.type === 'click-selector') {
        var el = document.querySelector(action.selector);
        if (!el) failures.push('selector not found: ' + action.selector);
        else {
          var rect = el.getBoundingClientRect();
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;
          mouse(el, 'mousedown', cx, cy);
          mouse(el, 'mouseup', cx, cy);
          mouse(el, 'click', cx, cy);
          checks.push('clicked selector ' + action.selector);
        }
      } else if (action.type === 'hover') {
        var hoverEl = document.elementFromPoint(action.x, action.y);
        if (!hoverEl) failures.push('no element at (' + action.x + ', ' + action.y + ') to hover');
        else {
          mouse(hoverEl, 'mouseover', action.x, action.y);
          mouse(hoverEl, 'mouseenter', action.x, action.y);
          mouse(hoverEl, 'mousemove', action.x, action.y);
          checks.push('hovered at (' + action.x + ', ' + action.y + ')');
        }
      } else if (action.type === 'type') {
        var active = document.activeElement;
        if (!active) failures.push('no active element to receive text');
        else if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          var proto = active instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
          if (setter) setter.call(active, active.value + (action.text || ''));
          else active.value = active.value + (action.text || '');
          active.dispatchEvent(new Event('input', { bubbles: true }));
          active.dispatchEvent(new Event('change', { bubbles: true }));
          checks.push('typed ' + String(action.text || '').length + ' char(s)');
        } else {
          var text = String(action.text || '');
          for (var i = 0; i < text.length; i += 1) {
            var charInit = { key: text[i], bubbles: true, cancelable: true };
            active.dispatchEvent(new KeyboardEvent('keydown', charInit));
            active.dispatchEvent(new KeyboardEvent('keypress', charInit));
            active.dispatchEvent(new KeyboardEvent('keyup', charInit));
          }
          checks.push('typed ' + text.length + ' char(s)');
        }
      } else if (action.type === 'press') {
        var keyTarget = document.activeElement || document.body;
        var keyInit = { key: action.key, bubbles: true, cancelable: true };
        keyTarget.dispatchEvent(new KeyboardEvent('keydown', keyInit));
        keyTarget.dispatchEvent(new KeyboardEvent('keypress', keyInit));
        keyTarget.dispatchEvent(new KeyboardEvent('keyup', keyInit));
        checks.push('pressed ' + action.key);
      } else if (action.type === 'wait') {
        await delay(action.ms || 0);
        checks.push('waited ' + (action.ms || 0) + 'ms');
      }
      await delay(SETTLE_MS);
      var exp = step.expect;
      if (!exp) return;
      var expectTimeout = exp.timeoutMs != null ? exp.timeoutMs : DEFAULT_EXPECT_MS;
      if (exp.textVisible) {
        var needle = exp.textVisible;
        var ok = await waitFor(function () {
          return ((document.body && document.body.innerText) || '').toLowerCase().indexOf(String(needle).toLowerCase()) >= 0;
        }, expectTimeout);
        if (ok) checks.push('text visible: ' + needle);
        else failures.push('expected text "' + needle + '" not visible within ' + expectTimeout + 'ms');
      }
      if (exp.textHidden) {
        var hiddenNeedle = exp.textHidden;
        var hiddenOk = await waitFor(function () {
          return ((document.body && document.body.innerText) || '').toLowerCase().indexOf(String(hiddenNeedle).toLowerCase()) < 0;
        }, expectTimeout);
        if (hiddenOk) checks.push('text hidden: ' + hiddenNeedle);
        else failures.push('expected text "' + hiddenNeedle + '" not hidden within ' + expectTimeout + 'ms');
      }
      if (exp.selectorVisible) {
        var visSel = exp.selectorVisible;
        var visOk = await waitFor(function () {
          var node = document.querySelector(visSel);
          return node ? isVisible(node) : false;
        }, expectTimeout);
        if (visOk) checks.push('selector visible: ' + visSel);
        else failures.push('expected selector "' + visSel + '" not visible within ' + expectTimeout + 'ms');
      }
      if (exp.selectorHidden) {
        var hidSel = exp.selectorHidden;
        var hidOk = await waitFor(function () {
          var node = document.querySelector(hidSel);
          return !node || !isVisible(node);
        }, expectTimeout);
        if (hidOk) checks.push('selector hidden: ' + hidSel);
        else failures.push('expected selector "' + hidSel + '" not hidden within ' + expectTimeout + 'ms');
      }
      if (exp.nonblankCanvasMin && exp.nonblankCanvasMin > 0) {
        var min = exp.nonblankCanvasMin;
        var count = nonblankCanvasCount();
        if (count >= min) checks.push('nonblank canvas ' + count + ' ≥ ' + min);
        else failures.push('nonblank canvas count ' + count + ' < required ' + min);
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

function skipOpaqueHtml(lower: string, index: number): number | null {
  if (lower.startsWith('<!--', index)) {
    const end = lower.indexOf('-->', index + 4);
    return end < 0 ? lower.length : end + 3;
  }
  if (lower.startsWith('<script', index)) {
    const end = lower.indexOf('</script>', index);
    return end < 0 ? lower.length : end + 9;
  }
  if (lower.startsWith('<textarea', index)) {
    const end = lower.indexOf('</textarea>', index);
    return end < 0 ? lower.length : end + 11;
  }
  return null;
}

function findRealOpenTag(html: string, tag: 'head' | 'html'): { end: number } | null {
  const lower = html.toLowerCase();
  const needle = `<${tag}`;
  let index = 0;
  while (index < lower.length) {
    const skip = skipOpaqueHtml(lower, index);
    if (skip != null) {
      index = skip;
      continue;
    }
    const after = lower[index + needle.length];
    if (lower.startsWith(needle, index) && (after === '>' || after === ' ' || after === '\t' || after === '\n' || after === '\r')) {
      const gt = html.indexOf('>', index);
      if (gt < 0) return null;
      return { end: gt + 1 };
    }
    index += 1;
  }
  return null;
}

function injectCsp(html: string): string {
  const head = findRealOpenTag(html, 'head');
  if (head) return `${html.slice(0, head.end)}${CSP_META}${html.slice(head.end)}`;
  const root = findRealOpenTag(html, 'html');
  if (root) return `${html.slice(0, root.end)}<head>${CSP_META}</head>${html.slice(root.end)}`;
  return `<!DOCTYPE html><html><head>${CSP_META}</head><body>${html}</body></html>`;
}

function lastRealBodyClose(html: string): number {
  const lower = html.toLowerCase();
  let index = 0;
  let last = -1;
  while (index < lower.length) {
    const skip = skipOpaqueHtml(lower, index);
    if (skip != null) {
      index = skip;
      continue;
    }
    if (lower.startsWith('</body>', index)) {
      last = index;
      index += 7;
      continue;
    }
    index += 1;
  }
  return last;
}

function injectDriver(html: string): string {
  if (html.includes(IN_APP_VALIDATION_DRIVER_FLAG)) return html;
  // 多份 CSP 是 AND。驱动必须出现在我们的 meta 之后、被测页自带 CSP 之前，
  // 否则 script-src 'none' 会把末尾内联脚本直接拦掉。
  const cspAt = html.indexOf(CSP_META);
  if (cspAt >= 0) {
    const end = cspAt + CSP_META.length;
    return `${html.slice(0, end)}${DRIVER_SCRIPT}${html.slice(end)}`;
  }
  const close = lastRealBodyClose(html);
  if (close >= 0) {
    return `${html.slice(0, close)}${DRIVER_SCRIPT}${html.slice(close)}`;
  }
  return `${html}${DRIVER_SCRIPT}`;
}

/** 给被测 HTML 塞 CSP + 跨源步骤驱动。没有 <head> 就包一层。 */
export function wrapInAppValidationHtml(html: string): string {
  return injectDriver(injectCsp(html));
}
