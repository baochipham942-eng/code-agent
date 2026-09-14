import { companionFileMime, COMPANION_LIMITS } from '../../../../src/shared/constants/companion';
import { base64ToBytes } from './fileCache';
import type { FilePorts, PickedFile } from './ports';

/** JPEG in @capacitor/camera EncodingType. Avoid importing the package from tests. */
const CAMERA_JPEG_ENCODING = 0;

const CAMERA_FORMAT_EXT: Record<string, string> = {
  jpeg: '.jpg',
  jpg: '.jpg',
  png: '.png',
  gif: '.gif',
  webp: '.webp',
  heic: '.heic',
  heif: '.heic',
};

const CAMERA_DENIED_CODES = new Set(['OS-PLUG-CAMR-0003', 'CAMERA_DENIED']);
const CAMERA_CANCEL_CODES = new Set([
  'OS-PLUG-CAMR-0006', 'OS-PLUG-CAMR-0007', 'OS-PLUG-CAMR-0010', 'USER_CANCELLED',
]);

export type CameraPermissionState = string;

export type CameraPhotoResult = {
  type?: number | string;
  uri?: string;
  path?: string;
  webPath?: string;
  thumbnail?: string;
  metadata?: { format?: string; size?: number };
  format?: string;
  base64String?: string;
  dataUrl?: string;
};

export interface CameraBridge {
  checkPermissions(): Promise<{ camera: CameraPermissionState }>;
  requestPermissions(options?: { permissions: Array<'camera' | 'photos'> }): Promise<{ camera: CameraPermissionState }>;
  takePhoto?(options: Record<string, unknown>): Promise<CameraPhotoResult>;
  getPhoto?(options: Record<string, unknown>): Promise<CameraPhotoResult>;
}

export function toPickedFile(name: string, bytes: Uint8Array): PickedFile {
  if (bytes.byteLength > COMPANION_LIMITS.fileMaxBytes) throw new Error('UPLOAD_TOO_LARGE');
  // 扩展名权威：归不了的是空串，upload 再以 COMPANION_FILE_TYPE_DENIED 落 chip，与既有 picker 一致。
  const mime = companionFileMime(name, '') ?? '';
  return { name, mimeType: mime, size: bytes.byteLength, bytes };
}

function cameraFileName(format: string): string {
  const ext = CAMERA_FORMAT_EXT[format.toLowerCase()];
  if (!ext) throw new Error('COMPANION_FILE_TYPE_DENIED');
  return `photo${ext}`;
}

function cameraPermissionBlocked(state: string): boolean {
  return state === 'denied' || state === 'restricted';
}

function cameraPermissionReady(state: string): boolean {
  return state === 'granted' || state === 'limited';
}

function pluginCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String((error as { code: unknown }).code);
  return '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map a camera plugin failure so denial/cancel never become an upload error. */
function cameraErrorOutcome(error: unknown): 'denied' | 'cancelled' | null {
  const code = pluginCode(error);
  const message = errorMessage(error);
  if (CAMERA_DENIED_CODES.has(code) || message === 'CAMERA_DENIED') return 'denied';
  if (CAMERA_CANCEL_CODES.has(code) || /cancel/i.test(message)) return 'cancelled';
  return null;
}

function bytesFromCameraResult(
  photo: CameraPhotoResult,
  uriBase64?: string,
): { bytes: Uint8Array; format: string } {
  if (photo.type === 1 || photo.type === 'Video') throw new Error('COMPANION_FILE_TYPE_DENIED');
  const format = photo.metadata?.format ?? photo.format ?? 'jpeg';
  if (photo.base64String) return { bytes: base64ToBytes(photo.base64String), format };
  if (photo.dataUrl) {
    const raw = photo.dataUrl.includes(',') ? photo.dataUrl.slice(photo.dataUrl.indexOf(',') + 1) : photo.dataUrl;
    return { bytes: base64ToBytes(raw), format };
  }
  if (uriBase64) return { bytes: base64ToBytes(uriBase64), format };
  // Web takePhoto puts the full image in thumbnail when there is no native file.
  if (photo.thumbnail && !photo.uri && !photo.path) return { bytes: base64ToBytes(photo.thumbnail), format };
  throw new Error('EMPTY_PHOTO');
}

function cameraFileRef(photo: CameraPhotoResult): string | undefined {
  return photo.uri ?? photo.path ?? photo.webPath;
}

async function capturePhoto(camera: CameraBridge): Promise<CameraPhotoResult> {
  if (typeof camera.takePhoto === 'function') {
    return camera.takePhoto({
      quality: 90,
      saveToGallery: false,
      includeMetadata: true,
      encodingType: CAMERA_JPEG_ENCODING,
      editable: 'no',
      webUseInput: true,
    });
  }
  if (typeof camera.getPhoto === 'function') {
    return camera.getPhoto({
      quality: 90,
      allowEditing: false,
      resultType: 'base64',
      source: 'CAMERA',
      saveToGallery: false,
      webUseInput: true,
    });
  }
  throw new Error('CAMERA_UNAVAILABLE');
}

export async function pickFromCamera(
  camera: CameraBridge,
  readUri: (uri: string) => Promise<string>,
): Promise<PickedFile | null> {
  const current = await camera.checkPermissions();
  if (cameraPermissionBlocked(current.camera)) throw new Error('CAMERA_DENIED');
  if (!cameraPermissionReady(current.camera)) {
    const next = await camera.requestPermissions({ permissions: ['camera'] });
    if (cameraPermissionBlocked(next.camera) || !cameraPermissionReady(next.camera)) throw new Error('CAMERA_DENIED');
  }
  try {
    const photo = await capturePhoto(camera);
    const ref = cameraFileRef(photo);
    const uriBase64 = ref ? await readUri(ref) : undefined;
    const { bytes, format } = bytesFromCameraResult(photo, uriBase64);
    return toPickedFile(cameraFileName(format), bytes);
  } catch (error) {
    const outcome = cameraErrorOutcome(error);
    if (outcome === 'denied') throw new Error('CAMERA_DENIED', { cause: error });
    if (outcome === 'cancelled' || errorMessage(error) === 'EMPTY_PHOTO' || errorMessage(error) === 'CAMERA_UNAVAILABLE') return null;
    throw error;
  }
}

export type AttachOutcome = 'picked' | 'cancelled' | 'denied' | 'too-large' | 'type-denied';

export async function pickAttachment(
  pick: FilePorts['pick'],
  kind: 'image' | 'file' | 'camera',
  upload: (file: PickedFile) => void | Promise<void>,
): Promise<AttachOutcome> {
  try {
    const file = await pick(kind);
    if (!file) return 'cancelled';
    await upload(file);
    return 'picked';
  } catch (error) {
    const code = errorMessage(error);
    if (code === 'CAMERA_DENIED') return 'denied';
    if (code === 'UPLOAD_TOO_LARGE') return 'too-large';
    if (code === 'COMPANION_FILE_TYPE_DENIED') return 'type-denied';
    throw error;
  }
}
