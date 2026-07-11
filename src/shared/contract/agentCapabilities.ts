export interface CapabilityManifest {
  fileRead: boolean;
  fileWrite: boolean;
  shell: boolean;
  network: boolean;
  credential: boolean;
  childProcess: boolean;
}
