/** encodeURIComponent，再把 markdown 链接里会断句的 ( ) ! ' * 写成 %28 %29 %21 %27 %2A。 */
export function encodeRunCommand(command: string): string {
  return encodeURIComponent(command)
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('!', '%21')
    .replaceAll("'", '%27')
    .replaceAll('*', '%2A');
}

export function runHref(command: string): string {
  return `!run?cmd=${encodeRunCommand(command)}`;
}
