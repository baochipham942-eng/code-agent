// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Plus } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { IconButton } from '../../../src/renderer/components/primitives/IconButton';

describe('IconButton icon sizing', () => {
  it('constrains a classless lucide svg to the fixed-size icon wrapper', () => {
    render(<IconButton size="sm" aria-label="Add" icon={<Plus />} />);

    const button = screen.getByRole('button', { name: 'Add' });
    const svg = button.querySelector('svg');
    const wrapper = svg?.parentElement;

    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('width')).toBe('24');
    expect(wrapper?.tagName).toBe('SPAN');
    expect(wrapper?.classList.contains('w-3.5')).toBe(true);
    expect(wrapper?.classList.contains('h-3.5')).toBe(true);
    expect(wrapper?.classList.contains('[&>svg]:h-full')).toBe(true);
    expect(wrapper?.classList.contains('[&>svg]:w-full')).toBe(true);
  });
});
