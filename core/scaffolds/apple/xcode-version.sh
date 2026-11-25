#!/usr/bin/env bash
# scripts/xcode-version.sh: stamps this Xcode app with its version and commit.
# Seeded by cogyard (kind apple). `npm run build` runs it before building
# (scripts/xcode-build.sh), and `npm version` runs it after a bump (the "version"
# script in package.json), so the bump commit carries the new version.
#
# It writes two files at the repo root, because the numbers change on different
# clocks. Never hand-edit either one.
#
#   Version.xcconfig  COMMITTED. MARKETING_VERSION (CFBundleShortVersionString)
#                     from the root package.json version, the one number a merge
#                     bumps. Committed, because a checkout without it would build a
#                     bundle with no version string, and nothing would say so.
#   Build.xcconfig    GENERATED, gitignored. CURRENT_PROJECT_VERSION
#                     (CFBundleVersion) is the commit count, which only goes up
#                     along a branch, and GIT_COMMIT_SHORT is the short commit.
#                     Both change with every commit, so committing them would never
#                     settle. Version.xcconfig includes it.
#
# The one-time hookup in Xcode. cogyard never edits an Xcode project, so until
# this is done once, the built app keeps the version Xcode itself set:
#
#   1. Add Version.xcconfig to the project: File > Add Files, add it to no
#      target. It is at the repo root, which may be a folder above the project.
#   2. Select the project, then its Info tab. Under Configurations, set Debug
#      and Release of each app target to Version.xcconfig.
#   3. Select each app target, then Build Settings. Delete the target's own
#      Marketing Version and Current Project Version (select the row, press
#      Delete), so the values from Version.xcconfig show through: a target's
#      own value always wins over an xcconfig.
#   4. In the same target's Info tab, add a String row named GitCommitShort
#      whose value is $(GIT_COMMIT_SHORT). The app reads it with
#      Bundle.main.object(forInfoDictionaryKey: "GitCommitShort").
#
# `npm run build` then reads the version and commit back out of each app it
# built, and warns when either one is not what this script stamped.
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(plutil -extract version raw -o - package.json 2>/dev/null)" || version=""
if [ -z "$version" ]; then
  echo "xcode-version: package.json has no \"version\". Add one, e.g. \"version\": \"0.1.0\"." >&2
  exit 1
fi
count="$(git rev-list --count HEAD 2>/dev/null)" || count=1
commit="$(git rev-parse --short HEAD 2>/dev/null)" || commit=unknown

cat > Version.xcconfig <<EOF
// Version.xcconfig: written by scripts/xcode-version.sh, and committed. Never
// hand-edit it. Change "version" in package.json; the next build, or npm version,
// writes it again.
//
// MARKETING_VERSION is CFBundleShortVersionString. The build number and the short
// commit change with every commit, so they live in Build.xcconfig, which the same
// script writes and git ignores. The two values below stand until that file exists.

MARKETING_VERSION = $version
CURRENT_PROJECT_VERSION = 1
GIT_COMMIT_SHORT = unknown
#include? "Build.xcconfig"
EOF

cat > Build.xcconfig <<EOF
// Build.xcconfig: written by scripts/xcode-version.sh on every build. Gitignored,
// because it changes with every commit. Never hand-edit it.

CURRENT_PROJECT_VERSION = $count
GIT_COMMIT_SHORT = $commit
EOF

echo "xcode-version: version $version, build $count, commit $commit (Version.xcconfig, Build.xcconfig)"
