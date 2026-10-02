// CLI for N-JEV-WARDEN-EVAL. --self-check loads only the offline metrics module.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--self-check')) {
    const { runSelfCheck } = await import('./jev-warden-eval-metrics');
    const failures = runSelfCheck();
    if (failures.length > 0) {
      for (const failure of failures) console.error(`self-check FAIL: ${failure}`);
      process.exit(1);
    }
    console.log('self-check OK');
    return;
  }
  const partFlag = args.indexOf('--part');
  const part = partFlag >= 0 ? args[partFlag + 1] : undefined;
  if (part === 'A') {
    const { runPartA } = await import('./jev-warden-eval-parta');
    await runPartA();
    return;
  }
  if (part === 'B') {
    const { runPartB } = await import('./jev-warden-eval-partb');
    await runPartB();
    return;
  }
  console.error('usage: jev-warden-eval.ts --self-check | --part A | --part B');
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
