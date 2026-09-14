import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';
import { bytesToBase64 } from '../../../packages/mobile/src/platform/fileCache';
import {
  pickAttachment, pickFromCamera, toPickedFile, type CameraBridge,
} from '../../../packages/mobile/src/platform/cameraPick';
import { ensureAndroidCameraPermission } from '../../../packages/mobile/scripts/configure-lan.mjs';
import { unlinkedSpmPlugins } from '../../../packages/mobile/scripts/ios-package.mjs';

type CameraPhotoResult = Awaited<ReturnType<NonNullable<CameraBridge['takePhoto']>>>;

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]);
const jpegB64 = bytesToBase64(jpegBytes);

function camera(state: string, opts: {
  request?: string;
  photo?: CameraPhotoResult;
  takeError?: unknown;
} = {}): CameraBridge & { checkPermissions: ReturnType<typeof vi.fn>; requestPermissions: ReturnType<typeof vi.fn>; takePhoto: ReturnType<typeof vi.fn> } {
  return {
    checkPermissions: vi.fn(async () => ({ camera: state })),
    requestPermissions: vi.fn(async () => ({ camera: opts.request ?? 'granted' })),
    takePhoto: vi.fn(async () => {
      if (opts.takeError) throw opts.takeError;
      return opts.photo ?? { format: 'jpeg', base64String: jpegB64 };
    }),
  };
}

describe('拍照结果归一化成 PickedFile（扩展名权威）', () => {
  it('uses the filename extension, not a declared MIME, and sizes from bytes', () => {
    const picked = toPickedFile('photo.jpg', jpegBytes);
    expect(picked).toEqual({ name: 'photo.jpg', mimeType: 'image/jpeg', size: jpegBytes.byteLength, bytes: jpegBytes });
    expect(toPickedFile('shot.PNG', jpegBytes).mimeType).toBe('image/png');
  });

  it('rejects oversized captures before upload starts', () => {
    const huge = new Uint8Array(COMPANION_LIMITS.fileMaxBytes + 1);
    expect(() => toPickedFile('photo.jpg', huge)).toThrow('UPLOAD_TOO_LARGE');
  });

  it('names a jpeg capture photo.jpg so companionFileMime can accept it', async () => {
    const picked = await pickFromCamera(camera('granted'), async () => { throw new Error('uri unused'); });
    expect(picked).toEqual({ name: 'photo.jpg', mimeType: 'image/jpeg', size: jpegBytes.byteLength, bytes: jpegBytes });
  });

  it('reads getPhoto path / webPath the same as takePhoto uri', async () => {
    const full = new Uint8Array([1, 2, 3, 4, 5]);
    for (const photo of [{ path: '/tmp/p.jpg', format: 'jpeg' }, { webPath: 'https://localhost/p.jpg', format: 'jpeg' }] as const) {
      const picked = await pickFromCamera(camera('granted', { photo }), async ref => {
        expect(['/tmp/p.jpg', 'https://localhost/p.jpg']).toContain(ref);
        return bytesToBase64(full);
      });
      expect(picked?.bytes).toEqual(full);
    }
  });

  it('falls back to getPhoto with base64 resultType when takePhoto is absent', async () => {
    const port = camera('granted');
    delete (port as { takePhoto?: unknown }).takePhoto;
    port.getPhoto = vi.fn(async () => ({ format: 'jpeg', base64String: jpegB64 }));
    const picked = await pickFromCamera(port, async () => '');
    expect(port.getPhoto).toHaveBeenCalledWith(expect.objectContaining({ resultType: 'base64', source: 'CAMERA' }));
    expect(picked?.name).toBe('photo.jpg');
  });

  it('reads native uri bytes instead of the thumbnail', async () => {
    const full = new Uint8Array([1, 2, 3, 4, 5]);
    const thumb = new Uint8Array([9]);
    const picked = await pickFromCamera(camera('granted', {
      photo: { uri: 'file:///tmp/p.jpg', thumbnail: bytesToBase64(thumb), format: 'jpeg' },
    }), async uri => { expect(uri).toBe('file:///tmp/p.jpg'); return bytesToBase64(full); });
    expect(picked?.bytes).toEqual(full);
    expect(picked?.size).toBe(5);
  });

  it('maps heic metadata to .heic', async () => {
    const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18]);
    const picked = await pickFromCamera(camera('granted', {
      photo: { metadata: { format: 'heic' }, base64String: bytesToBase64(heic) },
    }), async () => '');
    expect(picked?.name).toBe('photo.heic');
    expect(picked?.mimeType).toBe('image/heic');
  });
});

describe('cameraPrompt / cameraDenied 权限分流', () => {
  it('does not re-prompt after a denial, and does not start an upload', async () => {
    const port = camera('denied');
    await expect(pickFromCamera(port, async () => '')).rejects.toThrow('CAMERA_DENIED');
    expect(port.requestPermissions).not.toHaveBeenCalled();
    expect(port.takePhoto).not.toHaveBeenCalled();
  });

  it('requests once when the OS is still in prompt, then captures', async () => {
    const port = camera('prompt');
    const picked = await pickFromCamera(port, async () => '');
    expect(port.requestPermissions).toHaveBeenCalledWith({ permissions: ['camera'] });
    expect(port.takePhoto).toHaveBeenCalledOnce();
    expect(picked?.name).toBe('photo.jpg');
  });

  it('skips the prompt when already granted', async () => {
    const port = camera('granted');
    await pickFromCamera(port, async () => '');
    expect(port.requestPermissions).not.toHaveBeenCalled();
    expect(port.takePhoto).toHaveBeenCalledOnce();
  });

  it('maps a plugin denial code to CAMERA_DENIED, not an upload error', async () => {
    const port = camera('granted', { takeError: { code: 'OS-PLUG-CAMR-0003', message: 'denied' } });
    await expect(pickFromCamera(port, async () => '')).rejects.toThrow('CAMERA_DENIED');
  });

  it('treats cancel and missing hardware as no file, not an upload failure', async () => {
    await expect(pickFromCamera(camera('granted', { takeError: { code: 'OS-PLUG-CAMR-0006', message: 'cancelled' } }), async () => '')).resolves.toBeNull();
    await expect(pickFromCamera(camera('granted', { takeError: { code: 'OS-PLUG-CAMR-0007', message: 'no camera' } }), async () => '')).resolves.toBeNull();
  });

  it('pickAttachment routes denial away from upload()', async () => {
    const upload = vi.fn();
    const pick = vi.fn(async () => { throw new Error('CAMERA_DENIED'); });
    expect(await pickAttachment(pick, 'camera', upload)).toBe('denied');
    expect(upload).not.toHaveBeenCalled();
  });

  it('pickAttachment maps size and type failures without calling them upload progress', async () => {
    const upload = vi.fn();
    expect(await pickAttachment(async () => { throw new Error('UPLOAD_TOO_LARGE'); }, 'camera', upload)).toBe('too-large');
    expect(await pickAttachment(async () => { throw new Error('COMPANION_FILE_TYPE_DENIED'); }, 'image', upload)).toBe('type-denied');
    expect(upload).not.toHaveBeenCalled();
  });

  it('pickAttachment uploads a normalized file and reports picked', async () => {
    const file = toPickedFile('photo.jpg', jpegBytes);
    const upload = vi.fn(async () => {});
    expect(await pickAttachment(async () => file, 'camera', upload)).toBe('picked');
    expect(upload).toHaveBeenCalledWith(file);
  });
});

describe('iOS SPM fail-closed gate covers @capacitor/camera', () => {
  const pkg = JSON.parse(readFileSync('packages/mobile/package.json', 'utf8')) as { dependencies: Record<string, string> };
  const buildScript = readFileSync('packages/mobile/scripts/build-ios.mjs', 'utf8');
  const configure = readFileSync('packages/mobile/scripts/configure-lan.mjs', 'utf8');

  it('pins a concrete Capacitor 8 camera version', () => {
    expect(pkg.dependencies['@capacitor/camera']).toBe('8.2.4');
  });

  it('fails the iOS build when Package.swift omitted the installed camera plugin', () => {
    const packageSwift = `.package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app")`;
    expect(unlinkedSpmPlugins(packageSwift, ['@capacitor/app', '@capacitor/camera'])).toEqual(['@capacitor/camera']);
    expect(buildScript).toContain('installedIosPlugins()');
    expect(buildScript).toContain('IOS_PLUGINS_NOT_LINKED');
  });

  it('camera usage string covers scan and capture; Android declares CAMERA', () => {
    expect(configure).toMatch(/NSCameraUsageDescription[\s\S]*photograph materials/);
    expect(ensureAndroidCameraPermission('<manifest></manifest>')).toContain('android.permission.CAMERA');
    expect(ensureAndroidCameraPermission('<manifest><uses-permission android:name="android.permission.CAMERA" /></manifest>'))
      .toBe('<manifest><uses-permission android:name="android.permission.CAMERA" /></manifest>');
  });
});
