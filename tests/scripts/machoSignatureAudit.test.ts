import { describe, expect, it } from 'vitest';
import { findUnsignedMachO, hasDeveloperIdSignature, isMachO } from '../../scripts/lib/macho-signature-audit.mjs';

// 真实 codesign -dvv 输出的形状（签名的走 stdout+stderr，未签名的只在 stderr 打一行）。
const SIGNED = [
  'Executable=/Applications/Agent Neo.app/Contents/MacOS/agent-neo',
  'Identifier=com.agentneo.app',
  'Authority=Developer ID Application: Agent Neo project',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
].join('\n');
const UNSIGNED = 'code object is not signed at all';
// ad-hoc 签名有签名结构但没有 Developer ID 授权链 —— 公证照样拒。
const AD_HOC = ['Identifier=pdftoppm', 'Signature=adhoc'].join('\n');

describe('bundle Mach-O signature audit', () => {
  it('recognises executables, dylibs and universal binaries as Mach-O', () => {
    expect(isMachO('Mach-O 64-bit executable arm64')).toBe(true);
    expect(isMachO('Mach-O 64-bit dynamically linked shared library arm64')).toBe(true);
    expect(isMachO('Mach-O universal binary with 2 architectures')).toBe(true);
    // 非 darwin 的 .node 预编译产物也会随包，它们不该被要求 Developer ID 签名。
    expect(isMachO('PE32+ executable (DLL) (console) x86-64, for MS Windows')).toBe(false);
    expect(isMachO('ELF 64-bit LSB shared object, x86-64')).toBe(false);
    expect(isMachO('ASCII text')).toBe(false);
  });

  it('accepts only a Developer ID authority chain', () => {
    expect(hasDeveloperIdSignature(SIGNED)).toBe(true);
    expect(hasDeveloperIdSignature(UNSIGNED)).toBe(false);
    // ad-hoc 有签名却没有 Developer ID，是最容易被误判成「已签」的形态。
    expect(hasDeveloperIdSignature(AD_HOC)).toBe(false);
  });

  // 复刻 2026-07-15 的真实形态：签名两趟按「扩展名 + basename 白名单」枚举，
  // poppler 的 22 个 dylib 被 Pass1 覆盖，唯独 bin/pdftoppm 两趟都漏，
  // 于是整包被 Apple 判 Invalid，而审回并不指名是哪个文件。
  it('picks out the one unsigned executable among signed libraries', () => {
    const entries = [
      { path: 'lib/libpoppler.162.0.0.dylib', fileType: 'Mach-O 64-bit dynamically linked shared library arm64', codesignOutput: SIGNED },
      { path: 'lib/libjpeg.8.3.2.dylib', fileType: 'Mach-O 64-bit dynamically linked shared library arm64', codesignOutput: SIGNED },
      { path: 'bin/pdftoppm', fileType: 'Mach-O 64-bit executable arm64', codesignOutput: UNSIGNED },
    ];

    expect(findUnsignedMachO(entries)).toEqual(['bin/pdftoppm']);
  });

  it('ignores non-Mach-O payload so cross-platform prebuilds never trip the gate', () => {
    const entries = [
      { path: 'compliance/THIRD_PARTY_NOTICES.txt', fileType: 'ASCII text', codesignOutput: UNSIGNED },
      { path: 'vendor/win32/tree-sitter.node', fileType: 'PE32+ executable (DLL) (console) x86-64, for MS Windows', codesignOutput: UNSIGNED },
    ];

    expect(findUnsignedMachO(entries)).toEqual([]);
  });

  it('reports every unsigned binary at once', () => {
    // 一次列全：否则每补一个 basename 就要再烧 12 分钟编译 + 一轮公证才看到下一个。
    const entries = ['bin/pdftoppm', 'bin/pdftocairo'].map((path) => ({
      path,
      fileType: 'Mach-O 64-bit executable arm64',
      codesignOutput: UNSIGNED,
    }));

    expect(findUnsignedMachO(entries)).toEqual(['bin/pdftoppm', 'bin/pdftocairo']);
  });

  it('passes a fully signed bundle', () => {
    const entries = [
      { path: 'bin/pdftoppm', fileType: 'Mach-O 64-bit executable arm64', codesignOutput: SIGNED },
      { path: 'lib/libpoppler.162.0.0.dylib', fileType: 'Mach-O 64-bit dynamically linked shared library arm64', codesignOutput: SIGNED },
    ];

    expect(findUnsignedMachO(entries)).toEqual([]);
  });
});
