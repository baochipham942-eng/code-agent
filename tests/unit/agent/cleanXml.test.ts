// ============================================================================
// cleanXmlResidues Tests
// Only removes XML protocol tags (containing underscores), preserves HTML tags
// ============================================================================

import { describe, it, expect } from 'vitest';
import { cleanXmlResidues } from '../../../src/main/agent/antiPattern/cleanXml';

describe('cleanXmlResidues', () => {
  // --------------------------------------------------------------------------
  // String cleaning — protocol tags (with underscores) are removed
  // --------------------------------------------------------------------------
  describe('string values — protocol tags removed', () => {
    it('should remove tags with underscores (model-generated protocol tags)', () => {
      expect(cleanXmlResidues('<arg_key>value</arg_key>')).toBe('value');
    });

    it('should remove tool_call tags', () => {
      expect(cleanXmlResidues('code</tool_call>')).toBe('code');
    });

    it('should remove function_call tags', () => {
      expect(cleanXmlResidues('<function_call>ls</function_call>')).toBe('ls');
    });

    it('should remove self-closing protocol tags', () => {
      expect(cleanXmlResidues('text <line_break/> more')).toBe('text  more');
    });

    it('should remove multi-segment underscore tags', () => {
      expect(cleanXmlResidues('<arg_key_name>val</arg_key_name>')).toBe('val');
    });

    it('should handle multiple protocol tags', () => {
      expect(cleanXmlResidues('<tool_input>a</tool_input> <tool_output>b</tool_output>')).toBe('a b');
    });

    it('should trim whitespace after cleaning', () => {
      expect(cleanXmlResidues('  <tool_call>hello</tool_call>  ')).toBe('hello');
    });
  });

  // --------------------------------------------------------------------------
  // String cleaning — regular HTML/XML tags are preserved
  // --------------------------------------------------------------------------
  describe('string values — regular tags preserved', () => {
    it('should preserve simple HTML tags (no underscores)', () => {
      expect(cleanXmlResidues('<div>hello</div>')).toBe('<div>hello</div>');
    });

    it('should preserve self-closing HTML tags', () => {
      expect(cleanXmlResidues('text <br/> more')).toBe('text <br/> more');
    });

    it('should preserve tags with attributes', () => {
      expect(cleanXmlResidues('<div class="foo">content</div>')).toBe('<div class="foo">content</div>');
    });

    it('should preserve nested HTML tags', () => {
      expect(cleanXmlResidues('<outer><inner>text</inner></outer>')).toBe('<outer><inner>text</inner></outer>');
    });

    it('should return clean string unchanged', () => {
      expect(cleanXmlResidues('hello world')).toBe('hello world');
    });

    it('should handle empty string', () => {
      expect(cleanXmlResidues('')).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // Array cleaning
  // --------------------------------------------------------------------------
  describe('array values', () => {
    it('should clean protocol tags in arrays', () => {
      const input = ['<arg_key>a</arg_key>', '<tool_call>b</tool_call>'];
      expect(cleanXmlResidues(input)).toEqual(['a', 'b']);
    });

    it('should handle mixed arrays', () => {
      const input = ['<tool_input>text</tool_input>', 42, true];
      expect(cleanXmlResidues(input)).toEqual(['text', 42, true]);
    });

    it('should handle nested arrays', () => {
      const input = [['<arg_key>inner</arg_key>']];
      expect(cleanXmlResidues(input)).toEqual([['inner']]);
    });

    it('should handle empty arrays', () => {
      expect(cleanXmlResidues([])).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Object cleaning
  // --------------------------------------------------------------------------
  describe('object values', () => {
    it('should clean protocol tag values in objects', () => {
      const input = { key: '<arg_key>value</arg_key>' };
      expect(cleanXmlResidues(input)).toEqual({ key: 'value' });
    });

    it('should clean nested objects', () => {
      const input = {
        outer: {
          inner: '<tool_result>deep</tool_result>',
        },
      };
      expect(cleanXmlResidues(input)).toEqual({
        outer: { inner: 'deep' },
      });
    });

    it('should handle mixed value types', () => {
      const input = {
        str: '<arg_key>text</arg_key>',
        num: 42,
        bool: true,
        arr: ['<tool_call>item</tool_call>'],
      };
      expect(cleanXmlResidues(input)).toEqual({
        str: 'text',
        num: 42,
        bool: true,
        arr: ['item'],
      });
    });
  });

  // --------------------------------------------------------------------------
  // Primitive pass-through
  // --------------------------------------------------------------------------
  describe('primitive values', () => {
    it('should pass through numbers', () => {
      expect(cleanXmlResidues(42)).toBe(42);
    });

    it('should pass through booleans', () => {
      expect(cleanXmlResidues(true)).toBe(true);
      expect(cleanXmlResidues(false)).toBe(false);
    });

    it('should pass through null', () => {
      expect(cleanXmlResidues(null)).toBeNull();
    });

    it('should pass through undefined', () => {
      expect(cleanXmlResidues(undefined)).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Real-world model output residues
  // --------------------------------------------------------------------------
  describe('real-world model residues', () => {
    it('should clean tool arguments with XML protocol wrapper', () => {
      const input = {
        command: '<bash_command>ls -la</bash_command>',
        file_path: '<file_path>/home/user/test.txt</file_path>',
      };
      expect(cleanXmlResidues(input)).toEqual({
        command: 'ls -la',
        file_path: '/home/user/test.txt',
      });
    });

    it('should clean partial XML protocol residues at end of strings', () => {
      const result = cleanXmlResidues('echo "hello"</tool_call>');
      expect(result).toBe('echo "hello"');
    });

    it('should not strip legitimate HTML in tool output', () => {
      const input = '<html><body>content</body></html>';
      expect(cleanXmlResidues(input)).toBe('<html><body>content</body></html>');
    });
  });
});
