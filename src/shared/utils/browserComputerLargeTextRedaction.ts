const LARGE_TEXT_TOOL_NAMES = new Set([
  'Edit',
  'edit_file',
  'Write',
  'write_file',
  'Append',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function summarizeLargeText(value: string, head = 160, tail = 80): string {
  if (value.length <= head + tail + 32) {
    return value;
  }
  const omitted = value.length - head - tail;
  return `${value.slice(0, head)}...[${omitted} chars omitted]...${value.slice(-tail)}`;
}

function summarizeEditEntries(edits: unknown): unknown {
  if (!Array.isArray(edits)) {
    return edits;
  }
  return edits.map((edit) => {
    if (!isRecord(edit)) {
      return edit;
    }
    const summarized: Record<string, unknown> = { ...edit };
    if (typeof edit.old_text === 'string') {
      summarized.old_text = summarizeLargeText(edit.old_text);
      summarized.old_text_length = edit.old_text.length;
    }
    if (typeof edit.new_text === 'string') {
      summarized.new_text = summarizeLargeText(edit.new_text);
      summarized.new_text_length = edit.new_text.length;
    }
    return summarized;
  });
}

export function sanitizeLargeTextToolArguments(
  toolName: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!args || !LARGE_TEXT_TOOL_NAMES.has(toolName)) {
    return args;
  }

  const safeArgs: Record<string, unknown> = { ...args };

  if (typeof args.content === 'string') {
    const summarized = summarizeLargeText(args.content);
    safeArgs.content = summarized;
    safeArgs.content_length = args.content.length;
    if (summarized !== args.content) {
      safeArgs.content_lines = args.content.split('\n').length;
    }
  }

  if (Array.isArray(args.edits)) {
    safeArgs.edits = summarizeEditEntries(args.edits);
  }

  if (typeof args.old_text === 'string') {
    safeArgs.old_text = summarizeLargeText(args.old_text);
    safeArgs.old_text_length = args.old_text.length;
  }

  if (typeof args.new_text === 'string') {
    safeArgs.new_text = summarizeLargeText(args.new_text);
    safeArgs.new_text_length = args.new_text.length;
  }

  return safeArgs;
}
