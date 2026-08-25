interface CliCommandDescriptor {
  args: readonly string[];
  label: string;
  profile?: 'append';
}

interface CliUrlAuthStep {
  kind: 'url';
  command: CliCommandDescriptor;
  skipIf?: CliCommandDescriptor;
  urlPattern: RegExp;
  missingUrlMessage: string;
  openUrlErrorMessage: string;
  step: 1 | 2;
}

interface CliDeviceCodeAuthStep {
  kind: 'device-code';
  command: CliCommandDescriptor;
  deviceCodeField: string;
  verificationUrlField: string;
  followUp: CliCommandDescriptor;
  deviceCodePlaceholder: string;
  missingDeviceCodeMessage: string;
  step: 1 | 2;
}

interface CliPtyUrlAuthStep {
  kind: 'pty-url';
  command: CliCommandDescriptor;
  urlPattern: RegExp;
  missingUrlMessage: string;
  openUrlErrorMessage: string;
  pollStatusAfterExit: boolean;
  pollIntervalMs: number;
  step: 1 | 2;
}

type CliAuthStep = CliUrlAuthStep | CliDeviceCodeAuthStep | CliPtyUrlAuthStep;

type CliStatusMatcher =
  | { type: 'json-path'; path: readonly string[]; equals: unknown }
  | { type: 'text'; pattern: RegExp };

interface CliStatusDescriptor {
  command: CliCommandDescriptor;
  match: CliStatusMatcher;
  identityPath?: readonly string[];
  disconnectedIdentity: string;
  connectedIdentity: string;
  user?: {
    rootPath: readonly string[];
    openIdPath?: readonly string[];
    namePath?: readonly string[];
    tenantNamePath?: readonly string[];
  };
}

interface CliErrorMapping {
  codes?: readonly string[] | '*';
  outputPattern?: RegExp;
  message: string;
  logMessage?: string;
}

export interface CliConnectorDescriptor {
  id: string;
  displayName: string;
  /** Renderer brand asset id; absent means use the existing generic icon. */
  logo?: string;
  toolNames: string[];
  loggerName: string;
  installDirectory: string;
  npmPackage: string;
  version: string;
  packageJsonVersion?: string;
  packagePath: readonly string[];
  binaryPath: readonly string[];
  binaryName: string;
  profileArguments?: readonly string[];
  env: {
    remove: readonly string[];
    add?: Readonly<Record<string, string>>;
  };
  authSteps: readonly CliAuthStep[];
  status: CliStatusDescriptor;
  logout: CliCommandDescriptor;
  missingConfigurationPattern?: RegExp;
  errorMappings: readonly CliErrorMapping[];
}
