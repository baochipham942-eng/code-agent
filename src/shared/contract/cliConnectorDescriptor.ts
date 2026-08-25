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

export interface CliConnectorToolAction {
  zh: string;
  en: string;
}

interface CliConnectorEditableField {
  key: string;
  kind: 'string' | 'string_list';
  required?: boolean;
  multiline?: boolean;
}

export interface CliConnectorDescriptor {
  id: string;
  displayName: string;
  displayNameEn?: string;
  /** Renderer brand asset id; absent means use the existing generic icon. */
  logo?: string;
  toolNames: string[];
  /** 外部写回动作的人话名称，由权限分类、边界和审批呈现共同复用。 */
  writeActions?: Readonly<Record<string, CliConnectorToolAction>>;
  /** 审批卡允许修改的字段；字段名单只在连接器描述符声明一次。 */
  editablePermissionFields?: Readonly<Record<string, readonly CliConnectorEditableField[]>>;
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
