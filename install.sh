#!/usr/bin/env bash
set -euo pipefail

DEFAULT_VERSION="latest"
REPOSITORY="https://github.com/jakerains/scormplayer"
VERSION="${SCORMPLAYER_VERSION:-$DEFAULT_VERSION}"
INSTALL_DIR="${SCORMPLAYER_INSTALL_DIR:-$HOME/.local/share/scormplayer/standalone}"
BIN_DIR="${SCORMPLAYER_BIN_DIR:-$HOME/.local/bin}"
NODE_BASE="${SCORMPLAYER_NODE_BASE_URL:-https://nodejs.org/dist}"
fail() { printf 'SCORM Player: %s\n' "$*" >&2; exit 1; }
for tool in curl tar awk; do command -v "$tool" >/dev/null || fail "$tool is required."; done
if command -v sha256sum >/dev/null; then
  checksum() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null; then
  checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
else fail "sha256sum or shasum is required."; fi

case "$(uname -s)" in Darwin) PLATFORM=darwin ;; Linux) PLATFORM=linux ;; *) fail "The Bash installer supports macOS and Linux. Use npm on other platforms." ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) fail "This installer supports arm64 and x64." ;; esac
if [[ "$VERSION" == latest ]]; then
  release_url=$(curl -fsSL --retry 2 -o /dev/null -w '%{url_effective}' "$REPOSITORY/releases/latest")
  VERSION="${release_url##*/}"
fi
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid release version: $VERSION"
mkdir -p "$INSTALL_DIR/versions" "$BIN_DIR"
INSTALL_DIR=$(cd "$INSTALL_DIR" && pwd -P)
BIN_DIR=$(cd "$BIN_DIR" && pwd -P)
launcher="$BIN_DIR/scormplayer"
if [[ -e "$launcher" || -L "$launcher" ]]; then
  [[ -f "$launcher" && ! -L "$launcher" ]] && grep -q '^# SCORM Player standalone launcher$' "$launcher" || fail "$launcher already exists and was preserved. Choose another SCORMPLAYER_BIN_DIR."
fi
work=$(mktemp -d "$INSTALL_DIR/.install.XXXXXX")
trap 'rm -rf "$work"' EXIT
download() { curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 "$1" -o "$2"; }
verify() {
  [[ "$2" =~ ^[a-f0-9]{64}$ ]] || fail "Missing or invalid checksum for $1"
  [[ "$(checksum "$1")" == "$2" ]] || fail "Checksum mismatch for $1"
}
safe_archive() {
  tar -tzf "$1" > "$work/entries"
  awk -v root="$2" 'index($0,root"/") != 1 || $0 ~ /(^|\/)\.\.(\/|$)/ { bad=1 } END { exit bad }' "$work/entries" || fail "Unexpected archive paths."
}
asset="scormplayer-${VERSION#v}-standalone.tar.gz"
base="${SCORMPLAYER_RELEASE_BASE_URL:-$REPOSITORY/releases/download}/$VERSION"
printf 'Downloading SCORM Player %s from GitHub…\n' "$VERSION"
download "$base/$asset" "$work/$asset"
download "$base/SHA256SUMS" "$work/SHA256SUMS"
hash=$(awk -v name="$asset" '$2 == name { print $1 }' "$work/SHA256SUMS")
verify "$work/$asset" "$hash"
[[ -z "${SCORMPLAYER_EXPECTED_SHA256:-}" || "$hash" == "$SCORMPLAYER_EXPECTED_SHA256" ]] || fail "Release checksum changed during update."
safe_archive "$work/$asset" scormplayer
mkdir "$work/extract"
tar -xzf "$work/$asset" -C "$work/extract"

node="${SCORMPLAYER_NODE:-$(command -v node || true)}"
compatible_node() { [[ -n "$node" ]] && "$node" -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&(b>22||(b===22&&c>=2)))?0:1)' >/dev/null 2>&1; }
if ! compatible_node; then
  printf 'Downloading a private Node.js 24 runtime…\n'
  download "$NODE_BASE/latest-v24.x/SHASUMS256.txt" "$work/node-checksums"
  node_file=$(awk -v suffix="-$PLATFORM-$ARCH.tar.gz" 'index($2,"node-v24.")==1 && substr($2,length($2)-length(suffix)+1)==suffix {print $2}' "$work/node-checksums")
  [[ "$node_file" =~ ^node-v24\.[0-9]+\.[0-9]+-(darwin|linux)-(arm64|x64)\.tar\.gz$ ]] || fail "A compatible Node runtime was not found."
  node_version="${node_file#node-}"; node_version="${node_version%%-*}"
  download "$NODE_BASE/$node_version/$node_file" "$work/$node_file"
  node_hash=$(awk -v name="$node_file" '$2 == name {print $1}' "$work/node-checksums")
  verify "$work/$node_file" "$node_hash"
  node_folder="${node_file%.tar.gz}"
  safe_archive "$work/$node_file" "$node_folder"
  mkdir -p "$INSTALL_DIR/runtime"
  if [[ ! -d "$INSTALL_DIR/runtime/$node_folder" ]]; then
    tar -xzf "$work/$node_file" -C "$work/extract"
    mv "$work/extract/$node_folder" "$INSTALL_DIR/runtime/$node_folder"
  fi
  node="$INSTALL_DIR/runtime/$node_folder/bin/node"
fi
compatible_node || fail "Node.js 22.22.2+ is required for the bundled MCP."
node=$("$node" -p 'process.execPath')
bundle="$INSTALL_DIR/versions/$VERSION-${hash:0:12}"
"$node" "$work/extract/scormplayer/bin/scormplayer.mjs" --version --json >/dev/null
"$node" -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({kind:"standalone",installDir:process.argv[2],binDir:process.argv[3]}))' "$work/extract/scormplayer/.standalone-install.json" "$INSTALL_DIR" "$BIN_DIR"
if [[ ! -d "$bundle" ]]; then mv "$work/extract/scormplayer" "$bundle"; fi
{
  printf '#!/usr/bin/env bash\n# SCORM Player standalone launcher\n'
  printf 'export PATH=%q:"$PATH"\n' "$(dirname "$node")"
  printf 'exec %q %q "$@"\n' "$node" "$bundle/bin/scormplayer.mjs"
} > "$work/launcher"
chmod 755 "$work/launcher"
mv "$work/launcher" "$launcher"
printf 'Installed SCORM Player %s. Run: scormplayer\n' "$VERSION"
path_line=$(printf 'export PATH=%q:"$PATH"' "$BIN_DIR")
case "${SHELL:-}" in
  */bash)
    # Login Bash reads the first readable login profile, not .bashrc. Use the
    # existing file so creating .bash_profile cannot mask someone's .profile.
    login_profile="$HOME/.bash_profile"
    for candidate in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
      if [[ -r "$candidate" ]]; then login_profile="$candidate"; break; fi
    done
    profiles=("$HOME/.bashrc" "$login_profile") ;;
  */zsh) profiles=("$HOME/.zshrc") ;;
  *) profiles=("$HOME/.profile") ;;
esac
# Persist PATH even if this shell already has a temporary PATH addition.
for profile in "${profiles[@]}"; do
  if ! grep -Fqx "$path_line" "$profile" 2>/dev/null; then
    printf '\n# SCORM Player user commands\n%s\n' "$path_line" >> "$profile"
  fi
done
case ":$PATH:" in *":$BIN_DIR:"*) ;; *)
  printf 'Open a new terminal, or run: export PATH=%q:"$PATH"\n' "$BIN_DIR" ;;
esac
printf 'Open a course: scormplayer ./my-course.zip\nOptional AI setup: scormplayer setup\nTo update: scormplayer update\n'
