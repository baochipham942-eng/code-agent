// keytar mock - 避免原生模块在 vitest 中 SIGSEGV
export async function getPassword() { return null; }
export async function setPassword() {}
export async function deletePassword() { return true; }
export async function findCredentials() { return []; }
