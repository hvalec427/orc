#!/bin/sh
set -e

REPO="hvalec427/orc"

# The repo is private, so everything goes through the GitHub CLI's login.
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  echo "Error: orc's repo is private; install the GitHub CLI and run 'gh auth login' first."
  exit 1
fi

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  FILE="orc-darwin-arm64"
else
  FILE="orc-darwin-x64"
fi

# `dev` → rolling dev build; `nightly` → newest nightly; a version string → that
# exact tag; else latest stable.
if [ "$1" = "dev" ]; then
  VERSION="dev"
elif [ "$1" = "nightly" ]; then
  # GitHub's /releases list isn't newest-first — version-sort and take the highest.
  VERSION=$(gh api "repos/$REPO/releases?per_page=30" --jq '.[].tag_name' | grep nightly | sort -V | tail -1)
elif [ -n "$1" ]; then
  VERSION="$1"
else
  VERSION=$(gh api "repos/$REPO/releases/latest" --jq '.tag_name')
fi

if [ -z "$VERSION" ]; then
  echo "Error: could not resolve a release from $REPO"
  exit 1
fi

# The channel this build belongs to; `orc update` stays on it.
case "$VERSION" in
  dev) CHANNEL="dev" ;;
  *-dev.*) CHANNEL="dev" ;;
  *-nightly.*) CHANNEL="nightly" ;;
  *) CHANNEL="stable" ;;
esac

# Install over the orc already on PATH if there is one, so we never leave a
# stale copy shadowing the new version; otherwise default to /usr/local/bin.
EXISTING=$(command -v orc 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  INSTALL_PATH="$EXISTING"
else
  INSTALL_PATH="/usr/local/bin/orc"
fi
INSTALL_DIR=$(dirname "$INSTALL_PATH")

echo "Installing orc $VERSION ($ARCH) to $INSTALL_PATH..."
gh release download "$VERSION" -R "$REPO" -p "$FILE" -O /tmp/orc --clobber
chmod +x /tmp/orc
# Strip the macOS quarantine flag so Gatekeeper doesn't block the (un-notarized)
# binary with "Apple could not verify ... free of malware". No-op off macOS.
xattr -d com.apple.quarantine /tmp/orc 2>/dev/null || true

# Only use sudo when the target directory isn't writable.
if [ -w "$INSTALL_DIR" ]; then
  mv /tmp/orc "$INSTALL_PATH"
else
  sudo mv /tmp/orc "$INSTALL_PATH"
fi

echo "Done — orc $VERSION ($CHANNEL channel) installed to $INSTALL_PATH"

# Warn if some other orc earlier in PATH would still win.
RESOLVED=$(command -v orc 2>/dev/null || true)
if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$INSTALL_PATH" ]; then
  echo "Warning: 'orc' still resolves to $RESOLVED, which shadows the new install."
  echo "Remove that copy or fix your PATH, then run: hash -r"
fi
