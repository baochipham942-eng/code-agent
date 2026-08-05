// 地址栏展示：常态只显示域名，聚焦/编辑展开完整 URL。

export function extractBrowserHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

/** 地址栏 input 的展示值：聚焦时完整 URL，失焦时优先域名。 */
export function formatAddressBarDisplay(input: {
  raw: string;
  focused: boolean;
}): string {
  if (input.focused) return input.raw;
  const host = extractBrowserHostname(input.raw);
  return host || input.raw;
}
