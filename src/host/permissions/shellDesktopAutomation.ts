interface ShellDesktopAutomationMatch {
  semantic: string;
}

interface GuiInputSemanticDeclaration {
  semantic: string;
  matches: (command: string) => boolean;
}

/**
 * Desktop-input declarations are intentionally based on behavior-shaped command
 * syntax, not executable names. A new GUI driver belongs here only when its
 * input grammar can be described independently of the binary or wrapper name.
 */
const GUI_INPUT_SEMANTIC_DECLARATIONS: readonly GuiInputSemanticDeclaration[] = [
  {
    semantic: 'apple-events-gui-input',
    matches: (command) => /\btell\s+(?:app(?:lication)?\s+)?["']?system\s+events["']?/i.test(command)
      && /\b(?:click\s+at|keystroke|key\s+code|scroll|mouse\s+(?:down|up))\b/i.test(command),
  },
  {
    semantic: 'coordinate-input-token-protocol',
    matches: (command) => /(?:^|[\s;&|])(?:c|dc|rc|tc|m|dd|dm|du):-?\d+,-?\d+(?=$|[\s;&|])/i.test(command)
      || /(?:^|[\s;&|])(?:kd|kp|ku|t):\S+(?=$|[\s;&|])/i.test(command),
  },
  {
    semantic: 'desktop-input-object-api',
    matches: (command) => /\b(?:mouse|pointer|cursor|keyboard)\s*\.\s*(?:click|doubleClick|rightClick|move|moveTo|drag|press|type|write|scroll)\s*\(/i.test(command),
  },
  {
    // 任意模块名 + 屏幕坐标实参 = 在驱动 GUI 输入。要求坐标数字，才不会误伤
    // element.click() / button.press() 这类没有屏幕坐标的普通调用。
    semantic: 'coordinate-input-call',
    matches: (command) => /\.\s*(?:click|doubleClick|rightClick|middleClick|move|moveTo|moveRel|drag|dragTo|dragRel|mouseDown|mouseUp|scroll)\s*\(\s*-?\d+\s*,\s*-?\d+/i.test(command),
  },
  {
    // 键盘注入的专有动词：这些名字在普通代码里不作它用，出现即是在合成按键。
    semantic: 'synthetic-keyboard-input',
    matches: (command) => /\.\s*(?:typewrite|typeWrite|hotkey|keyDown|keyUp|press_and_release|pressAndRelease)\s*\(/i.test(command),
  },
  {
    semantic: 'desktop-input-cli-grammar',
    matches: (command) => /\b(?:mouse|pointer|cursor|keyboard|key)\s+(?:click|move|move-to|drag|press|type|write|scroll)\b/i.test(command)
      || /\bmouse(?:move|down|up)\b[^\n;&|]{0,80}\b(?:click|mouse(?:down|up))\b/i.test(command),
  },
];

export function classifyShellDesktopAutomation(
  command: unknown,
): ShellDesktopAutomationMatch | null {
  if (typeof command !== 'string' || command.trim() === '') return null;
  for (const declaration of GUI_INPUT_SEMANTIC_DECLARATIONS) {
    if (declaration.matches(command)) {
      return { semantic: declaration.semantic };
    }
  }
  return null;
}
