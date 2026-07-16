/** Return the stable zero-based ordinal for a neo_ui fence at a Markdown source offset. */
export function neoUIOrdinalAtOffset(content: string, offset?: number): number {
  if (typeof offset !== 'number') return 0;
  const matches = [...content.matchAll(/```neo_ui\s*\n/g)];
  let ordinal = 0;
  for (let index = 0; index < matches.length; index += 1) {
    if ((matches[index].index ?? Number.MAX_SAFE_INTEGER) > offset) break;
    ordinal = index;
  }
  return ordinal;
}
