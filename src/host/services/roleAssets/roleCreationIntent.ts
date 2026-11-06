/**
 * Host-side direct-create intent check. The caller must pass the latest real
 * user-authored message; tool arguments are deliberately not part of this API.
 */
const DIRECT_CREATE_NEGATION = /(?:不要|别|不想|暂不|先不|不用|无需|不必|不是)/;
const DIRECT_CREATE_NEGATION_WINDOW = 4;

function hasNegatedDirectCreate(text: string): boolean {
  for (const match of text.matchAll(/直接(?:帮我)?(?:创建|新建|建立)/g)) {
    const precedingText = text.slice(
      Math.max(0, match.index - DIRECT_CREATE_NEGATION_WINDOW),
      match.index,
    );
    if (DIRECT_CREATE_NEGATION.test(precedingText)) return true;
  }
  return false;
}

export function shouldCreateRoleDirectly(userText: string): boolean {
  const text = userText.trim();
  if (!text) return false;
  if (hasNegatedDirectCreate(text)) return false;
  if (/(?:不要|别|不想|暂不|先不)(?:直接)?(?:创建|新建|建立)/.test(text)) return false;
  if (/(?:要不要|是否|能不能|该不该)(?:直接)?(?:创建|新建|建立)/.test(text)) return false;
  if (/直接(?:创建|新建|建立).{0,8}(?:还是|吗|？|\?)/.test(text)) return false;

  const explicitlySkipsConfirmation =
    /直接(?:帮我)?(?:创建|新建|建立)/.test(text)
    || /(?:不用|无需|不必|别)(?:再)?(?:问(?:我)?(?:问题)?|询问(?:我)?|确认(?:一下)?)/.test(text);
  if (explicitlySkipsConfirmation) return true;

  if (!/^\s*\/create-role(?:\s|$)/i.test(text)) return false;
  const givesName = /(?:名字|名称)\s*(?:叫|是|为|[:：])\s*[「『“"']?[^\s，。；;]{1,32}/.test(text);
  const givesDuties = /(?:职责|职能|任务|负责|帮我|主要(?:做|处理))\s*(?:是|为|[:：])?\s*.{2,}/.test(text);
  return givesName && givesDuties;
}
