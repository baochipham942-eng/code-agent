// 判定 bundle 里每个 Mach-O 是否已由 Developer ID 签名。
//
// 存在理由：签名那两趟是「Pass1 按扩展名（*.dylib/*.node/*.so）+ Pass2 按 basename 白名单」。
// 一个既没有这些扩展名、basename 又不在白名单里的可执行文件会两趟都漏，以未签名状态进 bundle，
// 然后 Apple 公证判 Invalid——2026-07-15 的 poppler `pdftoppm` 就是这么漏的（v0.27.2 首次随包）。
// 那条路径的代价是 12 分钟编译 + 一轮公证往返，且审回只说 Invalid、不指名是哪个文件。
// 这里在签名后、公证前把账对平：任何 Mach-O 没有 Developer ID 签名就 fail-closed 并指名道姓。

export const DEVELOPER_ID_AUTHORITY = 'Authority=Developer ID Application:';

// `file -b` 的输出形如 "Mach-O 64-bit executable arm64" / "Mach-O 64-bit dynamically linked shared library arm64"。
// 通用二进制是 "Mach-O universal binary with N architectures"。三者都要签。
export function isMachO(fileTypeDescription) {
  return typeof fileTypeDescription === 'string' && fileTypeDescription.includes('Mach-O');
}

// codesign 对未签名文件会打 "code object is not signed at all"，对签名的则列出 Authority 链。
// 只认 Developer ID Application：ad-hoc 签名（Authority=(unsigned) 或无 Authority 行）过不了公证。
export function hasDeveloperIdSignature(codesignOutput) {
  return typeof codesignOutput === 'string' && codesignOutput.includes(DEVELOPER_ID_AUTHORITY);
}

// entries: [{ path, fileType, codesignOutput }]
// 返回未签名的 Mach-O 列表；调用方据此 fail-closed。
export function findUnsignedMachO(entries) {
  return entries
    .filter((entry) => isMachO(entry.fileType) && !hasDeveloperIdSignature(entry.codesignOutput))
    .map((entry) => entry.path);
}
