/** Shared directory incarnation test. APFS device numbers may change on remount. */
export function folderIdentityMatches(
  stored: { ino?: string | null; birthtimeNs?: string | null },
  current: { ino?: string | null; birthtimeNs?: string | null },
): boolean {
  return Boolean(stored.ino && current.ino && stored.birthtimeNs && current.birthtimeNs
    && stored.ino === current.ino && stored.birthtimeNs === current.birthtimeNs);
}
