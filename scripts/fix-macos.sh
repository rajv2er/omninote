#!/bin/bash
# Fix OmniNote on macOS for free (no Apple Developer ID) builds.
# Use when Finder says: "OmniNote is damaged and can't be opened."
#
# What it does:
#   1. xattr -dr com.apple.quarantine  -> removes Gatekeeper quarantine flag
#      (set on anything downloaded from the internet)
#   2. codesign --force --deep -s -    -> valid ad-hoc signature in place.
#      v0.1.0 shipped with a broken signature, so xattr alone was not enough.
#      Future builds set APPLE_SIGNING_IDENTITY="-" in CI, so step 2 is a no-op fallback.
#
# Usage:
#   bash scripts/fix-macos.sh [/Applications/OmniNote.app]
set -euo pipefail

APP="${1:-/Applications/OmniNote.app}"

if [ ! -d "$APP" ]; then
  echo "Not found: $APP"
  echo "Drag OmniNote from the .dmg to Applications first, then re-run."
  exit 1
fi

echo "Fixing $APP ..."
xattr -dr com.apple.quarantine "$APP" || true
codesign --force --deep -s - "$APP"

echo "Verifying ..."
codesign --verify --verbose "$APP"
echo ""
echo "Done. Open OmniNote from Finder / Launchpad now."
echo "If macOS still blocks it: System Settings > Privacy & Security > Open Anyway."
