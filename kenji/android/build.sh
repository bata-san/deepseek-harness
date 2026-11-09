#!/usr/bin/env bash
# Build the Kenji Harness APK with plain Android SDK tools (aapt2, javac, d8, zipalign, apksigner).
# No Gradle or third-party plugins are involved.
#   ANDROID_HOME=/opt/android-sdk KEYSTORE=/path/to/key.p12 KEYSTORE_PASS=... ./build.sh [versionName] [versionCode]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sdk="${ANDROID_HOME:?set ANDROID_HOME}"
bt="$sdk/build-tools/35.0.0"
jar="$sdk/platforms/android-35/android.jar"
version_name="${1:-1.0.0}"
version_code="${2:-1}"
out="$here/build"
rm -rf "$out" && mkdir -p "$out/res" "$out/gen" "$out/classes" "$out/dex"

"$bt/aapt2" compile --dir "$here/res" -o "$out/res/res.zip"
"$bt/aapt2" link "$out/res/res.zip" -I "$jar" --manifest "$here/AndroidManifest.xml" \
  --min-sdk-version 26 --target-sdk-version 34 --version-code "$version_code" --version-name "$version_name" \
  --java "$out/gen" -o "$out/base.apk"

javac -nowarn -source 17 -target 17 -encoding UTF-8 -classpath "$jar" -d "$out/classes" \
  $(find "$here/src" "$out/gen" -name '*.java')
"$bt/d8" --release --min-api 26 --lib "$jar" --output "$out/dex" $(find "$out/classes" -name '*.class')

cp "$out/base.apk" "$out/unaligned.apk"
(cd "$out/dex" && zip -q -j "$out/unaligned.apk" classes.dex)
"$bt/zipalign" -f -p 4 "$out/unaligned.apk" "$out/aligned.apk"
"$bt/apksigner" sign --ks "${KEYSTORE:?set KEYSTORE}" --ks-pass "env:KEYSTORE_PASS" --ks-key-alias harness \
  --out "$out/kenji-harness-$version_name.apk" "$out/aligned.apk"
"$bt/apksigner" verify --print-certs "$out/kenji-harness-$version_name.apk" | head -3
echo "APK: $out/kenji-harness-$version_name.apk"
