#!/bin/bash
# One-command install for OmniNote macOS (free build, no Apple Developer ID).
# For README / Release notes: curl -fsSL <raw-url>/scripts/install-mac.sh | bash
#
# Downloads latest .dmg, copies to /Applications, clears quarantine, ad-hoc signs.
set -euo pipefail

REPO="${REPO:-rajv2er/omninote}"
APP="/Applications/OmniNote.app"

echo "Fetching latest OmniNote release ..."
JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")
DMG_URL=$(echo "$JSON" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -n 1 | cut -d '"' -f 4)

if [ -z "${DMG_URL:-}" ]; then
  echo "Could not find a .dmg in the latest release."
  exit 1
fi

TMP_DMG="/tmp/OmniNote.dmg"
echo "Downloading $DMG_URL ..."
curl -fL "$DMG_URL" -o "$TMP_DMG"

echo "Mounting ..."
MNT=$(hdiutil attach -nobrowse -mountpoint /tmp/OmniNote-mnt "$TMP_DMG" | tail -1 | cut -f 3-)
# fallback parse
if [ -z "${MNT:-}" ]; then MNT="/tmp/OmniNote-mnt"; fi

echo "Copying to $APP (may ask for password) ..."
rm -rf "$APP"
cp -R "$MNT"/OmniNote.app "$APP"

echo "Detaching ..."
hdiutil detach "$MNT" || true

echo "Clearing quarantine + ad-hoc signing ..."
xattr -dr com.apple.quarantine "$APP" || true
codesign --force --deep -s - "$APP"
codesign --verify --verbose "$APP"

echo ""
echo "Done. Open OmniNote from Finder."
