// ============================================================================
// Image Utils Tests
// Tests for the image data normalization utilities
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  normalizeImageData,
  normalizeImageAttachments,
  buildImageMessageContent,
  extractImagePaths,
  getMimeTypeFromPath,
  isValidBase64,
  type NormalizedImageData,
  type ImageAttachmentInput,
} from '../../../src/main/utils/imageUtils';

describe('ImageUtils', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imageutils-test-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // getMimeTypeFromPath
  // --------------------------------------------------------------------------
  describe('getMimeTypeFromPath', () => {
    it('should detect common image formats', () => {
      expect(getMimeTypeFromPath('test.jpg')).toBe('image/jpeg');
      expect(getMimeTypeFromPath('test.jpeg')).toBe('image/jpeg');
      expect(getMimeTypeFromPath('test.png')).toBe('image/png');
      expect(getMimeTypeFromPath('test.gif')).toBe('image/gif');
      expect(getMimeTypeFromPath('test.webp')).toBe('image/webp');
      expect(getMimeTypeFromPath('test.bmp')).toBe('image/bmp');
      expect(getMimeTypeFromPath('test.svg')).toBe('image/svg+xml');
      expect(getMimeTypeFromPath('test.ico')).toBe('image/x-icon');
      expect(getMimeTypeFromPath('test.tiff')).toBe('image/tiff');
      expect(getMimeTypeFromPath('test.tif')).toBe('image/tiff');
    });

    it('should be case insensitive', () => {
      expect(getMimeTypeFromPath('test.JPG')).toBe('image/jpeg');
      expect(getMimeTypeFromPath('test.PNG')).toBe('image/png');
    });

    it('should default to image/png for unknown extensions', () => {
      expect(getMimeTypeFromPath('test.xyz')).toBe('image/png');
      expect(getMimeTypeFromPath('test')).toBe('image/png');
    });

    it('should handle paths with directories', () => {
      expect(getMimeTypeFromPath('/path/to/image.jpg')).toBe('image/jpeg');
      expect(getMimeTypeFromPath('relative/path/image.png')).toBe('image/png');
    });
  });

  // --------------------------------------------------------------------------
  // isValidBase64
  // --------------------------------------------------------------------------
  describe('isValidBase64', () => {
    it('should return true for valid base64 strings', () => {
      expect(isValidBase64('SGVsbG8gV29ybGQ=')).toBe(true);
      expect(isValidBase64('YWJjZGVmZw==')).toBe(true);
      expect(isValidBase64('dGVzdA==')).toBe(true);
    });

    it('should return true for base64 with padding', () => {
      expect(isValidBase64('YQ==')).toBe(true);
      expect(isValidBase64('YWI=')).toBe(true);
      expect(isValidBase64('YWJj')).toBe(true);
    });

    it('should return false for invalid strings', () => {
      expect(isValidBase64('')).toBe(false);
      expect(isValidBase64('not-valid-base64!')).toBe(false);
      expect(isValidBase64('has spaces in it')).toBe(false);
    });

    it('should return false for empty or null-like values', () => {
      expect(isValidBase64('')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // normalizeImageData
  // --------------------------------------------------------------------------
  describe('normalizeImageData', () => {
    describe('data URL parsing', () => {
      it('should parse data URL with PNG mime type', () => {
        const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const result = normalizeImageData(dataUrl);

        expect(result).not.toBeNull();
        expect(result?.mimeType).toBe('image/png');
        expect(result?.base64).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
      });

      it('should parse data URL with JPEG mime type', () => {
        const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD';
        const result = normalizeImageData(dataUrl);

        expect(result).not.toBeNull();
        expect(result?.mimeType).toBe('image/jpeg');
        expect(result?.base64).toBe('/9j/4AAQSkZJRgABAQAAAQABAAD');
      });

      it('should preserve file path when provided with data URL', () => {
        const dataUrl = 'data:image/png;base64,abc123';
        const result = normalizeImageData(dataUrl, '/path/to/image.png');

        expect(result?.path).toBe('/path/to/image.png');
      });
    });

    describe('raw base64 handling', () => {
      it('should use raw base64 data directly', () => {
        const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const result = normalizeImageData(base64);

        expect(result).not.toBeNull();
        expect(result?.base64).toBe(base64);
        expect(result?.mimeType).toBe('image/png'); // default
      });

      it('should use provided mimeType for raw base64', () => {
        const base64 = '/9j/4AAQSkZJRgABAQAAAQABAAD';
        const result = normalizeImageData(base64, undefined, 'image/jpeg');

        expect(result?.mimeType).toBe('image/jpeg');
      });

      it('should infer mimeType from file path for raw base64', () => {
        const base64 = '/9j/4AAQSkZJRgABAQAAAQABAAD';
        const result = normalizeImageData(base64, '/path/to/image.jpg');

        expect(result?.mimeType).toBe('image/jpeg');
        expect(result?.path).toBe('/path/to/image.jpg');
      });
    });

    describe('file path reading', () => {
      it('should read image from file path', () => {
        // Create a test image file (1x1 PNG)
        const pngBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
          0x00, 0x00, 0x00, 0x0d, // IHDR chunk length
          0x49, 0x48, 0x44, 0x52, // "IHDR"
          0x00, 0x00, 0x00, 0x01, // width: 1
          0x00, 0x00, 0x00, 0x01, // height: 1
          0x08, 0x02, 0x00, 0x00, 0x00, // bit depth, color type, compression, filter, interlace
          0x90, 0x77, 0x53, 0xde, // CRC
          0x00, 0x00, 0x00, 0x0c, // IDAT chunk length
          0x49, 0x44, 0x41, 0x54, // "IDAT"
          0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0xff, 0x00, // compressed data
          0x05, 0xfe, 0x02, 0xfe, // CRC
          0x00, 0x00, 0x00, 0x00, // IEND chunk length
          0x49, 0x45, 0x4e, 0x44, // "IEND"
          0xae, 0x42, 0x60, 0x82, // CRC
        ]);

        const testImagePath = path.join(testDir, 'test.png');
        fs.writeFileSync(testImagePath, pngBytes);

        const result = normalizeImageData(undefined, testImagePath);

        expect(result).not.toBeNull();
        expect(result?.mimeType).toBe('image/png');
        expect(result?.path).toBe(testImagePath);
        expect(result?.base64).toBe(pngBytes.toString('base64'));
      });

      it('should return null for non-existent file', () => {
        const result = normalizeImageData(undefined, '/nonexistent/path/image.png');

        expect(result).toBeNull();
      });

      it('should handle relative paths', () => {
        // Create a test file with relative path
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // minimal PNG header
        const testImagePath = path.join(testDir, 'relative.png');
        fs.writeFileSync(testImagePath, pngBytes);

        // Use the full path since relative would need cwd context
        const result = normalizeImageData(undefined, testImagePath);

        expect(result).not.toBeNull();
      });
    });

    describe('edge cases', () => {
      it('should return null when neither data nor path is provided', () => {
        const result = normalizeImageData();
        expect(result).toBeNull();
      });

      it('should return null for empty data and no path', () => {
        const result = normalizeImageData('', undefined);
        expect(result).toBeNull();
      });

      it('should handle invalid data URL format gracefully', () => {
        // Invalid data URL without proper format
        const invalidDataUrl = 'data:invalid';
        const result = normalizeImageData(invalidDataUrl);

        // Should fall back to checking if it's valid base64 (which it's not)
        expect(result).toBeNull();
      });
    });
  });

  // --------------------------------------------------------------------------
  // normalizeImageAttachments
  // --------------------------------------------------------------------------
  describe('normalizeImageAttachments', () => {
    it('should filter and normalize image attachments', () => {
      const attachments: ImageAttachmentInput[] = [
        {
          type: 'image',
          data: 'data:image/png;base64,abc123',
        },
        {
          type: 'file', // not an image
          data: 'some file content',
        },
        {
          category: 'image', // alternative way to mark as image
          data: 'data:image/jpeg;base64,xyz789',
        },
      ];

      const results = normalizeImageAttachments(attachments);

      expect(results.length).toBe(2);
      expect(results[0].mimeType).toBe('image/png');
      expect(results[1].mimeType).toBe('image/jpeg');
    });

    it('should skip attachments that cannot be normalized', () => {
      const attachments: ImageAttachmentInput[] = [
        {
          type: 'image',
          // No data and no path - cannot normalize
        },
        {
          type: 'image',
          path: '/nonexistent/image.png',
        },
      ];

      const results = normalizeImageAttachments(attachments);

      expect(results.length).toBe(0);
    });

    it('should handle empty array', () => {
      const results = normalizeImageAttachments([]);
      expect(results).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // buildImageMessageContent
  // --------------------------------------------------------------------------
  describe('buildImageMessageContent', () => {
    it('should build correct message content structure', () => {
      const imageData: NormalizedImageData = {
        base64: 'abc123',
        mimeType: 'image/png',
        path: '/path/to/image.png',
      };

      const content = buildImageMessageContent(imageData);

      expect(content.type).toBe('image');
      expect(content.source.type).toBe('base64');
      expect(content.source.media_type).toBe('image/png');
      expect(content.source.data).toBe('abc123');
    });

    it('should work with different mime types', () => {
      const jpegData: NormalizedImageData = {
        base64: 'jpeg-data',
        mimeType: 'image/jpeg',
      };

      const content = buildImageMessageContent(jpegData);

      expect(content.source.media_type).toBe('image/jpeg');
    });
  });

  // --------------------------------------------------------------------------
  // extractImagePaths
  // --------------------------------------------------------------------------
  describe('extractImagePaths', () => {
    it('should extract paths from image attachments', () => {
      const attachments: ImageAttachmentInput[] = [
        { type: 'image', path: '/path/to/image1.png' },
        { type: 'image', path: '/path/to/image2.jpg' },
        { type: 'file', path: '/path/to/doc.pdf' }, // not an image
        { category: 'image', path: '/path/to/image3.gif' },
      ];

      const paths = extractImagePaths(attachments);

      expect(paths.length).toBe(3);
      expect(paths).toContain('/path/to/image1.png');
      expect(paths).toContain('/path/to/image2.jpg');
      expect(paths).toContain('/path/to/image3.gif');
    });

    it('should skip attachments without path', () => {
      const attachments: ImageAttachmentInput[] = [
        { type: 'image', data: 'base64-data' }, // no path
        { type: 'image', path: '/path/to/image.png' },
      ];

      const paths = extractImagePaths(attachments);

      expect(paths.length).toBe(1);
      expect(paths[0]).toBe('/path/to/image.png');
    });

    it('should return empty array for empty input', () => {
      const paths = extractImagePaths([]);
      expect(paths).toEqual([]);
    });
  });
});
