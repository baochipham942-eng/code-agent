export const PYTHON_RUNTIME_VERSION = '3.14.5'; // bump via lock only

export const PYPI_INDEX_URL = 'https://pypi.org/simple';
export const TUNA_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';

// Directory listings of the GitHub and astral download prefixes return 404.
// Probe the concrete uv 0.11.16 artifact so a dead prefix cannot force the mirror.
export const PYTHON_DOWNLOAD_PROBE_URL = 'https://releases.astral.sh/github/python-build-standalone/releases/download/20260510/cpython-3.14.5%2B20260510-aarch64-apple-darwin-install_only_stripped.tar.gz';

export const PYTHON_INSTALL_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone/';

export const PROBE_TIMEOUT_MS = 3000;
export const PROBE_SLOW_TTFB_MS = 1500;

export const PYTHON_ENV_ASSET_ID = 'python-env';
export const PYTHON_ENV_LABEL = 'Python data runtime';

export const PROJECT_FILES = ['pyproject.toml', 'uv.lock', '.python-version', 'requirements.lock.txt'] as const;
