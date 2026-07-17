import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../../../src/renderer/components/primitives/Button';
import { IconButton } from '../../../src/renderer/components/primitives/IconButton';

const globalCss = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/styles/global.css'),
  'utf8',
);

describe('primitive focus styles', () => {
  it('does not suppress the generic focus-visible outline on buttons', () => {
    expect(globalCss).not.toMatch(
      /button:focus-visible,\s*\[role=["']button["']\]:focus-visible\s*{\s*outline:\s*none;\s*}/,
    );
  });

  it.each([
    [
      'Button',
      renderToStaticMarkup(<Button>Save</Button>),
    ],
    [
      'IconButton',
      renderToStaticMarkup(
        <IconButton aria-label="Save" icon={<span aria-hidden="true">S</span>} />,
      ),
    ],
  ])('%s uses the shared focus-visible ring', (_name, html) => {
    expect(html).toContain('focus-visible:ring-2');
    expect(html).toContain('focus-visible:ring-[var(--focus-ring)]');
  });
});
