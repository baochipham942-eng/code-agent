import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');

describe('macOS Dock and AppleEvent quit guard', () => {
  it('installs applicationShouldTerminate on the existing NSApplication delegate', () => {
    expect(main).toContain('install_mac_application_terminate_guard(app);');
    expect(main).toContain('class_addMethod(');
    expect(main).toContain('sel!(applicationShouldTerminate:)');
    expect(main).toContain('c"Q@:@".as_ptr()');
  });

  it('defers AppKit termination and routes the request through the shared guard flow', () => {
    const hook = /unsafe extern "C-unwind" fn mac_application_should_terminate[\s\S]*?\n\}/.exec(
      main
    );
    expect(hook, 'applicationShouldTerminate hook anchor missing').not.toBeNull();
    expect(hook![0]).toContain('NSApplicationTerminateReply::TerminateLater');
    expect(hook![0]).toContain('spawn_quit_guard_flow(');
    expect(hook![0]).toContain('QuitFlowOrigin::MacApplicationTerminate');
    expect(main).toContain('replyToApplicationShouldTerminate(should_terminate)');

    // The worker must call the existing pure decision function. This prevents a
    // second Dock/AppleEvent-specific busy/idle policy from drifting from ⌘Q.
    expect(main).toContain('quit_guard::decide_quit(outcome, coordinator.current_skip())');
  });

  it('keeps system shutdown fail-open and performs graceful cleanup on approved quit', () => {
    expect(main).toContain('if coordinator.current_skip().is_some() || coordinator.exit_allowed()');
    expect(main).toContain('if plan.cleanup_server {');
    expect(main).toContain('cleanup_server(&app);');
  });
});
