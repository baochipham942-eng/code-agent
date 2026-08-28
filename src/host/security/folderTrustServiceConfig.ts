let configuredOptions: { defaultProjectConfigTrust?: boolean } = {};

export function configureFolderTrustService(
  options: { defaultProjectConfigTrust?: boolean },
): void {
  configuredOptions = { ...options };
}

export function getFolderTrustServiceOptions(): { defaultProjectConfigTrust?: boolean } {
  return configuredOptions;
}
