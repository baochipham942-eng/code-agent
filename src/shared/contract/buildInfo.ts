export interface BuildInfo {
  appName: string;
  branch: string | null;
  commit: string | null;
  commitShort: string | null;
  dirty: boolean | null;
  worktree: string | null;
  builtAt: string;
}
