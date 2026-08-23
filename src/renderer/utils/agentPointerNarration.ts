import type { AgentPointerEvent } from '@shared/contract';

export interface AgentPointerNarrationCopy {
  navigateTarget: string;
  navigate: string;
  clickTarget: string;
  click: string;
  inputTarget: string;
  input: string;
  waitTarget: string;
  wait: string;
  browseTarget: string;
  browse: string;
  dragTarget: string;
  drag: string;
  blockedTarget: string;
  blocked: string;
}

const COORDINATE_LABEL = /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?(?:\s*(?:px|%))?$/i;
const INTERNAL_REFERENCE = /^(?:axpath|targetref|windowref|refid|snapshotid|nodeid)\b/i;
const XPATH_OR_DOM_PATH = /^(?:\/\/|\/?html(?:\/|\s*>))/i;
const CSS_SYNTAX = /^(?:[#.]|\[|\*)|::|:(?:nth|first|last|has|not|is|where|hover|focus|active)\b|\[[^\]]*(?:=|\^=|\$=|\*=)[^\]]*\]|\s[>+~]\s/i;
const BARE_DOM_ELEMENT = /^(?:html|body|main|section|article|div|span|button|input|textarea|select|option|form|label|a|img|svg|path|ul|ol|li|table|tr|td|th|iframe)$/i;

function readableUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return null;
  }
}

/** Renderer-only guard: internal browser locators must never become user-facing narration. */
function getReadableAgentPointerTarget(event: AgentPointerEvent): string | null {
  if (event.targetSource === 'coordinate') return null;
  const raw = event.targetLabel?.trim();
  if (!raw) return null;

  const url = readableUrl(raw);
  if (url) return url.slice(0, 72);

  if (
    COORDINATE_LABEL.test(raw)
    || INTERNAL_REFERENCE.test(raw)
    || XPATH_OR_DOM_PATH.test(raw)
    || CSS_SYNTAX.test(raw)
    || BARE_DOM_ELEMENT.test(raw)
  ) {
    return null;
  }

  return raw.length > 72 ? `${raw.slice(0, 69)}...` : raw;
}

function withTarget(template: string, target: string): string {
  return template.replace('{target}', target);
}

export function getAgentPointerNarration(
  event: AgentPointerEvent,
  copy: AgentPointerNarrationCopy,
): string {
  const target = getReadableAgentPointerTarget(event);
  const format = (targetTemplate: string, fallback: string) => (
    target ? withTarget(targetTemplate, target) : fallback
  );

  switch (event.phase) {
    case 'navigate':
      return format(copy.navigateTarget, copy.navigate);
    case 'click':
      return format(copy.clickTarget, copy.click);
    case 'type':
      return format(copy.inputTarget, copy.input);
    case 'wait':
      return format(copy.waitTarget, copy.wait);
    case 'drag':
      return format(copy.dragTarget, copy.drag);
    case 'failed':
    case 'blocked':
      return format(copy.blockedTarget, copy.blocked);
    default:
      return format(copy.browseTarget, copy.browse);
  }
}
