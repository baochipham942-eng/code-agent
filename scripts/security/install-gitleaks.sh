#!/usr/bin/env bash
# Install pinned gitleaks v8.30.1 from the official release tarball.
# Checksums are the sha256 lines from gitleaks_8.30.1_checksums.txt.
# Not a package.json dependency. Local PATH may omit the binary.

set -euo pipefail

VERSION=8.30.1
PREFIX="${1:-/usr/local/bin}"

os=$(uname -s)
arch=$(uname -m)
case "${os}-${arch}" in
  Linux-x86_64)
    asset=linux_x64
    sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    ;;
  Linux-aarch64|Linux-arm64)
    asset=linux_arm64
    sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
    ;;
  Darwin-arm64)
    asset=darwin_arm64
    sum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5
    ;;
  Darwin-x86_64)
    asset=darwin_x64
    sum=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709
    ;;
  *)
    echo "install-gitleaks: unsupported platform ${os}-${arch}" >&2
    exit 2
    ;;
esac

url="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${asset}.tar.gz"
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

curl -fsSL "$url" -o "$tmpdir/gitleaks.tar.gz"
actual=$(openssl dgst -sha256 "$tmpdir/gitleaks.tar.gz" | awk '{print $NF}')
if [ "$actual" != "$sum" ]; then
  echo "install-gitleaks: checksum mismatch for ${asset}" >&2
  exit 1
fi

tar -xzf "$tmpdir/gitleaks.tar.gz" -C "$tmpdir"
mkdir -p "$PREFIX"
install -m 0755 "$tmpdir/gitleaks" "$PREFIX/gitleaks"

got=$("$PREFIX/gitleaks" version)
if [ "$got" != "$VERSION" ]; then
  echo "install-gitleaks: version mismatch (got ${got}, want ${VERSION})" >&2
  exit 1
fi

echo "install-gitleaks: ${VERSION} ${asset} -> ${PREFIX}/gitleaks"
