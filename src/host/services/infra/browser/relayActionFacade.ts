/**
 * ADR-041 M3 — high-level browser actions over Chrome Relay (cdp.send / tabs.*).
 */
import type { ToolExecutionResult } from '../../../tools/types';
import { browserRelayService } from '../browserRelayService';

export interface RelayActionParams {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  tabId?: string | number;
  fullPage?: boolean;
  formData?: Record<string, string>;
  width?: number;
  height?: number;
}

function asTabId(value: string | number | undefined, fallback?: number | null): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  throw new Error('tabId required for relay action (attach a Chrome tab first).');
}

async function resolveDefaultTabId(): Promise<number> {
  const state = browserRelayService.getState();
  if (state.status !== 'connected') {
    throw new Error('Browser relay extension is not connected.');
  }
  if ((state.attachedTabCount || 0) <= 0) {
    throw new Error('No attached Chrome tab. Attach one from the Neo Browser Relay extension popup.');
  }
  const tabs = await browserRelayService.listTabs() as Array<{ id?: number; attached?: boolean; active?: boolean }>;
  const list = Array.isArray(tabs) ? tabs : [];
  const attached = list.filter((tab) => tab.attached && typeof tab.id === 'number');
  const activeAttached = attached.find((tab) => tab.active);
  const pick = activeAttached || attached[0];
  if (!pick || typeof pick.id !== 'number') {
    throw new Error('No attached Chrome tab found in extension tab list.');
  }
  return pick.id;
}

async function cdp(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return browserRelayService.sendCdp(tabId, method, params);
}

async function evaluate<T = unknown>(tabId: number, expression: string): Promise<T> {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }) as { result?: { value?: T; type?: string; description?: string }; exceptionDetails?: unknown };
  if (result?.exceptionDetails) {
    throw new Error(`Relay evaluate failed: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
  }
  return result?.result?.value as T;
}

function ok(output: string, metadata?: Record<string, unknown>): ToolExecutionResult {
  return {
    success: true,
    output,
    metadata: {
      provider: 'browser-relay',
      engine: 'relay',
      ...metadata,
    },
  };
}

function fail(error: string, metadata?: Record<string, unknown>): ToolExecutionResult {
  return {
    success: false,
    error,
    metadata: {
      provider: 'browser-relay',
      engine: 'relay',
      ...metadata,
    },
  };
}

export async function executeRelayBrowserAction(params: RelayActionParams): Promise<ToolExecutionResult> {
  const action = params.action;
  try {
    if (action === 'launch') {
      await browserRelayService.ensureStarted();
      const state = browserRelayService.getState();
      return ok(
        state.status === 'connected'
          ? 'Browser relay is connected. Attach a tab in the extension popup if needed.'
          : 'Browser relay listening. Load/connect the extension, then attach a tab.',
        { relay: state },
      );
    }

    if (action === 'close') {
      // Detach all known attached tabs then leave host listening (do not stop relay server).
      const tabs = await browserRelayService.listTabs() as Array<{ id?: number; attached?: boolean }>;
      for (const tab of Array.isArray(tabs) ? tabs : []) {
        if (tab.attached && typeof tab.id === 'number') {
          await browserRelayService.detachTab(tab.id).catch(() => undefined);
        }
      }
      return ok('Detached all relay tabs (relay host still listening).');
    }

    if (action === 'list_tabs') {
      const tabs = await browserRelayService.listTabs() as Array<Record<string, unknown>>;
      const list = Array.isArray(tabs) ? tabs : [];
      if (list.length === 0) return ok('No Chrome tabs visible to the relay extension.');
      const lines = list.map((tab) => {
        const id = tab.id;
        const title = String(tab.title || '');
        const url = String(tab.url || '');
        const attached = tab.attached ? 'attached' : 'not-attached';
        return `- ${id}: ${title} (${url}) [${attached}]`;
      });
      return ok(`Chrome tabs:\n${lines.join('\n')}`, { tabCount: list.length });
    }

    if (action === 'new_tab') {
      const created = await browserRelayService.createTab(params.url || 'about:blank') as { id?: number; url?: string; title?: string };
      return ok(`New Chrome tab created: ${created?.id}\nURL: ${created?.url || params.url || 'about:blank'}`, {
        tabId: created?.id,
      });
    }

    const defaultTabId = await resolveDefaultTabId().catch(() => null);
    const tabId = asTabId(params.tabId, defaultTabId);

    switch (action) {
      case 'switch_tab':
        await browserRelayService.attachTab(tabId);
        return ok(`Attached/switched relay focus to tab ${tabId}`, { tabId });

      case 'close_tab':
        await browserRelayService.detachTab(tabId);
        return ok(`Detached relay tab ${tabId}`, { tabId });

      case 'navigate': {
        if (!params.url) return fail('url required for navigate');
        await browserRelayService.attachTab(tabId);
        await browserRelayService.navigateTab(tabId, params.url);
        const title = await evaluate<string>(tabId, 'document.title').catch(() => '');
        return ok(`Navigated tab ${tabId} to ${params.url}\nTitle: ${title}`, { tabId, url: params.url, title });
      }

      case 'back':
        await evaluate(tabId, 'history.back()');
        return ok(`Navigated back on tab ${tabId}`, { tabId });

      case 'forward':
        await evaluate(tabId, 'history.forward()');
        return ok(`Navigated forward on tab ${tabId}`, { tabId });

      case 'reload':
        await cdp(tabId, 'Page.reload', {});
        return ok(`Reloaded tab ${tabId}`, { tabId });

      case 'click': {
        if (!params.selector) return fail('selector required for click');
        const clicked = await evaluate<boolean>(
          tabId,
          `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) return false; el.scrollIntoView({block:'center', inline:'center'}); el.click(); return true; })()`,
        );
        if (!clicked) return fail(`Element not found for selector: ${params.selector}`, { tabId });
        return ok(`Clicked ${params.selector} on tab ${tabId}`, { tabId, selector: params.selector });
      }

      case 'click_text': {
        if (!params.text) return fail('text required for click_text');
        const clicked = await evaluate<boolean>(
          tabId,
          `(() => {
            const target = ${JSON.stringify(params.text)};
            const nodes = Array.from(document.querySelectorAll('a,button,input,summary,[role="button"],[onclick]'));
            const el = nodes.find((n) => (n.innerText || n.textContent || n.value || '').includes(target));
            if (!el) return false;
            el.scrollIntoView({block:'center', inline:'center'});
            el.click();
            return true;
          })()`,
        );
        if (!clicked) return fail(`No clickable element containing text: ${params.text}`, { tabId });
        return ok(`Clicked text "${params.text}" on tab ${tabId}`, { tabId });
      }

      case 'type': {
        if (!params.selector || params.text === undefined) return fail('selector and text required for type');
        const typed = await evaluate<boolean>(
          tabId,
          `(() => {
            const el = document.querySelector(${JSON.stringify(params.selector)});
            if (!el) return false;
            el.focus();
            if ('value' in el) {
              el.value = ${JSON.stringify(params.text)};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              el.textContent = ${JSON.stringify(params.text)};
            }
            return true;
          })()`,
        );
        if (!typed) return fail(`Element not found for selector: ${params.selector}`, { tabId });
        return ok(`Typed into ${params.selector} on tab ${tabId}`, { tabId, selector: params.selector });
      }

      case 'press_key': {
        if (!params.key) return fail('key required for press_key');
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: params.key, text: params.key.length === 1 ? params.key : undefined });
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: params.key });
        return ok(`Pressed ${params.key} on tab ${tabId}`, { tabId, key: params.key });
      }

      case 'scroll': {
        const amount = params.amount && params.amount > 0 ? params.amount : 300;
        const delta = params.direction === 'up' ? -amount : amount;
        await evaluate(tabId, `window.scrollBy(0, ${delta})`);
        return ok(`Scrolled ${params.direction || 'down'} ${amount}px on tab ${tabId}`, { tabId });
      }

      case 'screenshot': {
        const shot = await browserRelayService.screenshotTab(tabId, {
          format: 'jpeg',
          quality: 80,
        }) as { data?: string };
        return ok(`Screenshot captured on tab ${tabId}`, {
          tabId,
          // base64 may be large; keep only length signal
          screenshotBytes: typeof shot?.data === 'string' ? Math.floor((shot.data.length * 3) / 4) : null,
          hasScreenshot: Boolean(shot?.data),
        });
      }

      case 'get_content': {
        const content = await evaluate<{ url: string; title: string; text: string }>(
          tabId,
          `({
            url: location.href,
            title: document.title,
            text: (document.body && (document.body.innerText || document.body.textContent) || '').slice(0, 12000)
          })`,
        );
        return ok(
          `URL: ${content?.url || ''}\nTitle: ${content?.title || ''}\n\n${content?.text || ''}`,
          { tabId, url: content?.url, title: content?.title },
        );
      }

      case 'get_elements': {
        if (!params.selector) return fail('selector required for get_elements');
        const elements = await evaluate<Array<{ tag: string; text: string; href?: string }>>(
          tabId,
          `Array.from(document.querySelectorAll(${JSON.stringify(params.selector)})).slice(0, 30).map((el) => ({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.textContent || '').trim().slice(0, 120),
            href: el.href || undefined
          }))`,
        );
        return ok(JSON.stringify(elements || [], null, 2), { tabId, count: Array.isArray(elements) ? elements.length : 0 });
      }

      case 'get_dom_snapshot': {
        const snapshot = await evaluate(
          tabId,
          `(() => {
            const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 40).map((el) => ({
              level: Number(el.tagName.substring(1)),
              text: (el.innerText || '').trim().slice(0, 120)
            }));
            const interactiveElements = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]')).slice(0, 80).map((el, index) => ({
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role'),
              text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 100),
              selectorHint: el.id ? ('#' + el.id) : (el.tagName.toLowerCase() + ':nth-of-type(' + (index + 1) + ')'),
            }));
            return {
              url: location.href,
              title: document.title,
              headings,
              interactiveElements,
            };
          })()`,
        );
        return ok(JSON.stringify(snapshot, null, 2), { tabId, provider: 'browser-relay' });
      }

      case 'get_a11y_snapshot': {
        // Prefer CDP AX tree; fall back to simplified DOM interactive list.
        try {
          const ax = await cdp(tabId, 'Accessibility.getFullAXTree', {});
          return ok(JSON.stringify(ax, null, 2).slice(0, 20000), { tabId, source: 'cdp-ax' });
        } catch {
          return executeRelayBrowserAction({ ...params, action: 'get_dom_snapshot' });
        }
      }

      case 'get_workbench_state': {
        const state = browserRelayService.getState();
        const tabs = await browserRelayService.listTabs();
        return ok(JSON.stringify({ relay: state, tabs }, null, 2), { relay: state });
      }

      case 'get_account_state':
        return ok(
          'Relay engine uses the real browser session; cookie values are not exported. Attach/list tabs to operate with existing login state.',
          { provider: 'browser-relay', cookieValues: 'redacted' },
        );

      case 'fill_form': {
        if (!params.formData || typeof params.formData !== 'object') {
          return fail('formData required for fill_form');
        }
        const filled = await evaluate<number>(
          tabId,
          `(() => {
            const data = ${JSON.stringify(params.formData)};
            let count = 0;
            for (const [selector, value] of Object.entries(data)) {
              const el = document.querySelector(selector);
              if (!el) continue;
              el.focus();
              if ('value' in el) {
                el.value = String(value);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                count += 1;
              }
            }
            return count;
          })()`,
        );
        return ok(`Filled ${filled || 0} fields on tab ${tabId}`, { tabId, filled });
      }

      case 'set_viewport':
        return fail('set_viewport is not supported on relay engine (uses real browser window size).', {
          capability: 'unsupported',
        });

      case 'export_storage_state':
      case 'import_storage_state':
      case 'list_profiles':
      case 'import_profile_cookies':
      case 'clear_cookies':
      case 'upload_file':
      case 'wait_for_download':
        return fail(`${action} is managed-engine only; use engine=managed or Browser Surface for profile/cookie import.`, {
          capability: 'managed_only',
        });

      case 'wait': {
        const timeout = typeof params.amount === 'number' ? params.amount : 1000;
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(timeout, 0), 15000)));
        return ok(`Waited ${Math.min(Math.max(timeout, 0), 15000)}ms`, { tabId });
      }

      case 'get_logs':
        return ok('Relay engine does not buffer page console logs yet.', { tabId });

      default:
        return fail(`Unsupported relay action: ${action}`, { capability: 'unsupported' });
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
