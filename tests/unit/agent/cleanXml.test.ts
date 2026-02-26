// ============================================================================
// cleanXmlResidues Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { cleanXmlResidues } from '../../../src/main/agent/antiPattern/cleanXml';

describe('cleanXmlResidues', () => {
  // --------------------------------------------------------------------------
  // String cleaning
  // --------------------------------------------------------------------------
  describe('string values', () => {
    it('should remove simple XML tags', () => {
      expect(cleanXmlResidues('<tag>hello</tag>')).toBe('hello');
    });

    it('should remove self-closing tags', () => {
      expect(cleanXmlResidues('text <br/> more')).toBe('text  more');
    });

    it('should remove tags with underscores (model-generated)', () => {
      expect(cleanXmlResidues('<arg_key>value</arg_key>')).toBe('value');
    });

    it('should remove tool_call tags', () => {
      expect(cleanXmlResidues('code</tool_call>')).toBe('code');
    });

    it('should remove tags with attributes', () => {
      expect(cleanXmlResidues('<div class="foo">content</div>')).toBe('content');
    });

    it('should handle nested tags', () => {
      expect(cleanXmlResidues('<outer><inner>text</inner></outer>')).toBe('text');
    });

    it('should trim whitespace after cleaning', () => {
      expect(cleanXmlResidues('  <tag>hello</tag>  ')).toBe('hello');
    });

    it('should return clean string unchanged', () => {
      expect(cleanXmlResidues('hello world')).toBe('hello world');
    });

    it('should handle empty string', () => {
      expect(cleanXmlResidues('')).toBe('');
    });

    it('should preserve content between tags', () => {
      expect(cleanXmlResidues('before<tag>middle</tag>after')).toBe('beforemiddleafter');
    });
  });

  // --------------------------------------------------------------------------
  // Array cleaning
  // --------------------------------------------------------------------------
  describe('array values', () => {
    it('should clean strings in arrays', () => {
      const input = ['<tag>a</tag>', '<tag>b</tag>'];
      expect(cleanXmlResidues(input)).toEqual(['a', 'b']);
    });

    it('should handle mixed arrays', () => {
      const input = ['<tag>text</tag>', 42, true];
      expect(cleanXmlResidues(input)).toEqual(['text', 42, true]);
    });

    it('should handle nested arrays', () => {
      const input = [['<tag>inner</tag>']];
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
    it('should clean string values in objects', () => {
      const input = { key: '<tag>value</tag>' };
      expect(cleanXmlResidues(input)).toEqual({ key: 'value' });
    });

    it('should clean nested objects', () => {
      const input = {
        outer: {
          inner: '<tag>deep</tag>',
        },
      };
      expect(cleanXmlResidues(input)).toEqual({
        outer: { inner: 'deep' },
      });
    });

    it('should handle mixed value types', () => {
      const input = {
        str: '<tag>text</tag>',
        num: 42,
        bool: true,
        arr: ['<tag>item</tag>'],
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
    it('should clean tool arguments with XML wrapper', () => {
      const input = {
        command: '<bash_command>ls -la</bash_command>',
        file_path: '<file_path>/home/user/test.txt</file_path>',
      };
      expect(cleanXmlResidues(input)).toEqual({
        command: 'ls -la',
        file_path: '/home/user/test.txt',
      });
    });

    it('should clean partial XML residues at end of strings', () => {
      const result = cleanXmlResidues('echo "hello"</tool_call>');
      expect(result).toBe('echo "hello"');
    });
  });
});
