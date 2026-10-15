import { PROBE_SLOW_TTFB_MS, PROBE_TIMEOUT_MS } from '../pythonEnv/constants';

export const LIBREOFFICE_RUNTIME_VERSION = '26.2.6';
const LIBREOFFICE_OFFICIAL_BASE = 'https://download.documentfoundation.org/libreoffice/stable/26.2.6/mac';
const LIBREOFFICE_MIRROR_BASE = 'https://mirrors.ustc.edu.cn/tdf/libreoffice/stable/26.2.6/mac';
export const LIBREOFFICE_RUNTIME_ASSET_ID = 'libreoffice';
export const LIBREOFFICE_RUNTIME_LABEL = 'LibreOffice document renderer';
export const LIBREOFFICE_ROOT_NAME = 'libreoffice';
export const LIBREOFFICE_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;
export const LIBREOFFICE_PROBE_SLOW_TTFB_MS = PROBE_SLOW_TTFB_MS;

export interface LibreOfficeBuild {
  arch: 'arm64' | 'x86_64';
  fileName: string;
  officialUrl: string;
  mirrorUrl: string;
  sha256: string;
  bytes: number;
}

const ARM64_FILE = 'LibreOffice_26.2.6_MacOS_aarch64.dmg';
const X64_FILE = 'LibreOffice_26.2.6_MacOS_x86-64.dmg';

const LIBREOFFICE_BUILDS: Record<'arm64' | 'x86_64', LibreOfficeBuild> = {
  arm64: {
    arch: 'arm64',
    fileName: ARM64_FILE,
    officialUrl: `${LIBREOFFICE_OFFICIAL_BASE}/aarch64/${ARM64_FILE}`,
    mirrorUrl: `${LIBREOFFICE_MIRROR_BASE}/aarch64/${ARM64_FILE}`,
    sha256: '94bb3248df074c225490a8a6d1d9dc87c7d6783dbb7a8e9f0d0c3d94348552af',
    bytes: 297798926,
  },
  x86_64: {
    arch: 'x86_64',
    fileName: X64_FILE,
    officialUrl: `${LIBREOFFICE_OFFICIAL_BASE}/x86_64/${X64_FILE}`,
    mirrorUrl: `${LIBREOFFICE_MIRROR_BASE}/x86_64/${X64_FILE}`,
    sha256: '135b8a95b8133396d54bf8e726dbc0066145efa0d785963fc3d4592acbfcfe5b',
    bytes: 308308875,
  },
};

export function buildForArch(arch: string = process.arch): LibreOfficeBuild {
  return arch === 'arm64' ? LIBREOFFICE_BUILDS.arm64 : LIBREOFFICE_BUILDS.x86_64;
}
