export const WEB_SERVER_DEFAULTS = {
  HOST: '127.0.0.1',
  PORT: 8180,
  HEALTH_PATH: '/api/health',
  WORKSPACE_FILE_PATH: '/api/workspace/file',
  DEV_AUTH_TOKEN_FILE: '.dev-token',
} as const;
