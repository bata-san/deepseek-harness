#!/usr/bin/env bash
# Build a signed APK and publish it to dist/ for the gateway's self-update endpoint
# (<server>/harness/app/version.json and /harness/app/kenji-harness.apk).
#   ANDROID_HOME=... KEYSTORE=... KEYSTORE_PASS=... ./publish.sh <versionName> <versionCode> "<release notes>"
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
name="${1:?versionName}"; code="${2:?versionCode}"; notes="${3:-}"
"$here/build.sh" "$name" "$code"
mkdir -p "$here/dist"
cp "$here/build/kenji-harness-$name.apk" "$here/dist/kenji-harness.apk"
sha="$(sha256sum "$here/dist/kenji-harness.apk" | cut -d' ' -f1)"
python3 - "$here/dist/version.json" "$name" "$code" "$sha" "$notes" <<'PY'
import json, sys
path, name, code, sha, notes = sys.argv[1:]
json.dump({"versionName": name, "versionCode": int(code), "sha256": sha, "notes": notes}, open(path, "w"), ensure_ascii=False, indent=2)
open(path, "a").write("\n")
PY
cat "$here/dist/version.json"
