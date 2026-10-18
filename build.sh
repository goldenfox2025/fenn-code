#!/usr/bin/env bash
# One-step local build for macOS and Linux.
#   ./build.sh              build a runnable app folder (fastest)
#   ./build.sh --installer  also build the installers (dmg/zip on macOS, AppImage/deb on Linux)
#   ./build.sh --run        build, then start the app
set -euo pipefail
cd "$(dirname "$0")"

installer=0; run=0
for a in "$@"; do
  case "$a" in
    --installer) installer=1 ;;
    --run) run=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nBuild failed: %s\n' "$1" >&2; exit 1; }

step "Checking Node.js"
command -v node >/dev/null || fail "Node.js is not installed. Get version 22 or newer from https://nodejs.org"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || fail "Node.js $(node -v) is too old; version 22 or newer is needed."
echo "Node.js $(node -v)"

# Behind a proxy, let Node's own downloads (Electron) use it too.
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]; then
  export NODE_USE_ENV_PROXY=1
  echo "Using the proxy from HTTPS_PROXY/HTTP_PROXY"
fi

step "Installing dependencies"
npm install --no-audit --no-fund || fail "npm install did not finish. If you are behind a proxy, set HTTPS_PROXY first."

step "Building"
npx electron-vite build || fail "the build step failed (see above)."

step "Packaging"
if [ "$installer" = 1 ]; then
  npx electron-builder --publish never || fail "packaging failed (see above)."
else
  npx electron-builder --dir --publish never || fail "packaging failed (see above)."
fi

case "$(uname -s)" in
  Darwin) app=$(ls -d release/mac*/"Fenn Code.app" 2>/dev/null | head -1) ;;
  *) app=$(ls -d release/linux*-unpacked/fenn-code 2>/dev/null | head -1) ;;
esac

printf '\nDone.\n'
[ -n "${app:-}" ] && echo "App: $PWD/$app"
if [ "$installer" = 1 ]; then
  echo "Installers:"
  ls -1 release/*.dmg release/*.zip release/*.AppImage release/*.deb 2>/dev/null | sed "s|^|  $PWD/|" || true
fi

if [ "$run" = 1 ] && [ -n "${app:-}" ]; then
  step "Starting Fenn Code"
  if [ "$(uname -s)" = Darwin ]; then open "$app"; else "./$app" >/dev/null 2>&1 & fi
fi
