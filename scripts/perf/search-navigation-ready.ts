export function searchListGeometrySignature(scrollHeight: number, scrollTop: number): string {
  return `${scrollHeight}:${Math.round(scrollTop)}`;
}

export function isSearchNavigationReady(input: {
  baselineSignature: string;
  previousSignature: string | null;
  scrollHeight: number;
  scrollTop: number;
}): boolean {
  const signature = searchListGeometrySignature(input.scrollHeight, input.scrollTop);
  return signature !== input.baselineSignature && signature === input.previousSignature;
}
