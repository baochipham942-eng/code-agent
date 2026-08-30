// ============================================================================
// captureConsoleOutput — 捕获 async fn 执行期间的 console.* 输出
// Ink 界面里 slash 命令（handleCommand）走 console.log/terminalOutput 打印，
// 直接写会冲乱 Ink 布局；捕获后交给 Ink 渲染层当系统消息展示。
// 只 patch console 四个方法，不碰 process.stdout.write——Ink 自身渲染帧走后者。
// ============================================================================

export async function captureConsoleOutput(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const capture = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await fn();
  } finally {
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  return chunks.join('\n');
}
