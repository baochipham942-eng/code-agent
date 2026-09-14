/**
 * N-BGSPAWN-DURABLE ai-review 修复：变异验收的退出码语义。
 * mutation 模式下「断言全过」意味着变异未被抓到、验收无效，必须非零退出；
 * mutation 模式断言转红才是预期（退出 0）。非变异模式照常 pass→0 / fail→1。
 */
export function resolveMutationAcceptanceExitCode(pass: boolean, mutation: string | undefined): number {
  if (mutation) return pass ? 1 : 0;
  return pass ? 0 : 1;
}
