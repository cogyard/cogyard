#!/usr/bin/env bash
# scripts/xcode-build.sh: builds this Xcode app. `npm run build` runs it.
# Seeded by cogyard (kind apple); it is yours to change.
#
#   1. Finds the Xcode workspace, project or Swift package: at the repo root, or
#      else in the one folder below it that has one (an app beside a server often
#      keeps it in ios/).
#   2. Asks it for its schemes (xcodebuild -list -json) and takes the one it
#      finds. None, or more than one, stops the build and says what it found.
#   3. Stamps the version and commit (scripts/xcode-version.sh), then builds.
#   4. Reads the version and commit back out of each app it built, and warns
#      when either is not what step 3 stamped.
#
# Anything after the script name goes to xcodebuild as it is, so package.json can
# name what this script should not guess:
#   "build": "bash scripts/xcode-build.sh -scheme MyApp"
#   "build": "bash scripts/xcode-build.sh -destination 'generic/platform=iOS Simulator'"
#   "build": "bash scripts/xcode-build.sh -destination 'generic/platform=macOS'"
# (the last one stops xcodebuild warning that it picked one of several Macs).
# With -project or -workspace given, step 1 is skipped; with -scheme, step 2. A
# Swift package also needs a -destination (xcodebuild says so). xcodebuild runs
# in the folder that holds the Xcode project, so a relative path passed to it is
# relative to that folder.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"

die() { echo "xcode-build: $*" >&2; exit 1; }
json() { printf '%s' "$1" | plutil -extract "$2" raw -o - - 2>/dev/null; }
joined() { local out="" x; for x in "$@"; do out="${out:+$out, }$x"; done; printf '%s' "$out"; }
has_xcode() {
  local f
  for f in "$1"/*.xcworkspace "$1"/*.xcodeproj "$1"/Package.swift; do
    if [ -e "$f" ]; then return 0; fi
  done
  return 1
}

container=()
scheme=()
rest=()
while [ $# -gt 0 ]; do
  case "$1" in
    -project|-workspace|-scheme)
      [ $# -ge 2 ] || die "$1 needs a value"
      if [ "$1" = -scheme ]; then scheme=("$1" "$2"); else container=("$1" "$2"); fi
      shift 2 ;;
    *) rest+=("$1"); shift ;;
  esac
done

# Step 1: the Xcode project.
shopt -s nullglob
dir=.
if [ ${#container[@]} -eq 0 ]; then
  if ! has_xcode .; then
    found=()
    for d in */; do
      d="${d%/}"
      [ "$d" = node_modules ] && continue
      if has_xcode "$d"; then found+=("$d"); fi
    done
    [ ${#found[@]} -gt 0 ] || die "no Xcode workspace, project or Package.swift at the repo root or one folder below it. cogyard does not create one: make the project in Xcode (File > New > Project), save it in this folder, and build again."
    [ ${#found[@]} -eq 1 ] || die "Xcode projects in ${#found[@]} folders: $(joined "${found[@]}"). Name the one to build in package.json, e.g. \"build\": \"bash scripts/xcode-build.sh -project ${found[0]}/<Name>.xcodeproj\"."
    dir="${found[0]}"
  fi
  cd "$dir"
  workspaces=(*.xcworkspace)
  projects=(*.xcodeproj)
  if [ ${#workspaces[@]} -gt 1 ]; then
    die "${#workspaces[@]} workspaces in $dir: $(joined "${workspaces[@]}"). Name the one to build in package.json, e.g. \"build\": \"bash scripts/xcode-build.sh -workspace $dir/${workspaces[0]}\"."
  elif [ ${#workspaces[@]} -eq 1 ]; then
    container=(-workspace "${workspaces[0]}")
  elif [ ${#projects[@]} -gt 1 ]; then
    die "${#projects[@]} projects in $dir: $(joined "${projects[@]}"). Name the one to build in package.json, e.g. \"build\": \"bash scripts/xcode-build.sh -project $dir/${projects[0]}\"."
  elif [ ${#projects[@]} -eq 1 ]; then
    container=(-project "${projects[0]}")
  fi
  # Neither: a Swift package, which xcodebuild reads from the folder it runs in.
fi
key=workspace
if [ "${container[0]-}" = -project ]; then key=project; fi
what="${container[1]-Package.swift}"
[ "$dir" = . ] || what="$dir/$what"

# Step 2: the scheme.
if [ ${#scheme[@]} -eq 0 ]; then
  list="$(xcodebuild -list -json ${container[@]+"${container[@]}"} 2>/dev/null)" \
    || die "xcodebuild -list failed for $what. Run it to see why: (cd $dir && xcodebuild -list ${container[*]-})"
  n="$(json "$list" "$key.schemes")" || n=0
  names=()
  i=0
  while [ "$i" -lt "$n" ]; do names+=("$(json "$list" "$key.schemes.$i")"); i=$((i + 1)); done
  if [ "$n" -eq 0 ]; then
    die "no scheme in $what. Open it in Xcode once, which makes a scheme for each app, or share one (Product > Scheme > Manage Schemes, Shared)."
  elif [ "$n" -gt 1 ]; then
    die "$n schemes in $what: $(joined "${names[@]}"). Name the one to build in package.json, e.g. \"build\": \"bash scripts/xcode-build.sh -scheme ${names[0]}\"."
  fi
  scheme=(-scheme "${names[0]}")
fi

# Step 3: stamp, then build.
(cd "$root" && bash scripts/xcode-version.sh)
args=(${container[@]+"${container[@]}"} "${scheme[@]}" ${rest[@]+"${rest[@]}"})
echo "xcode-build: xcodebuild build ${args[*]} (in $dir)"
xcodebuild build "${args[@]}"

# Step 4: what the built apps say.
version="$(plutil -extract version raw -o - "$root/package.json")"
commit="$(git -C "$root" rev-parse --short HEAD 2>/dev/null)" || commit=unknown
settings="$(xcodebuild -showBuildSettings -json "${args[@]}" 2>/dev/null)" || settings=""
i=0
while target="$(json "$settings" "$i.target")"; do
  if [ "$(json "$settings" "$i.buildSettings.PRODUCT_TYPE")" = com.apple.product-type.application ]; then
    plist="$(json "$settings" "$i.buildSettings.TARGET_BUILD_DIR")/$(json "$settings" "$i.buildSettings.INFOPLIST_PATH")"
    if [ ! -f "$plist" ]; then
      echo "xcode-build: built $target, but found no Info.plist at $plist, so its version was not checked."
    else
      got_version="$(plutil -extract CFBundleShortVersionString raw -o - "$plist" 2>/dev/null)" || got_version=""
      got_build="$(plutil -extract CFBundleVersion raw -o - "$plist" 2>/dev/null)" || got_build=""
      got_commit="$(plutil -extract GitCommitShort raw -o - "$plist" 2>/dev/null)" || got_commit=""
      echo "xcode-build: built $target: version ${got_version:-none}, build ${got_build:-none}, commit ${got_commit:-none} ($plist)"
      if [ "$got_version" != "$version" ]; then
        echo "xcode-build: warning: $target says version ${got_version:-none}, but package.json says $version. The one-time Xcode hookup is not done (scripts/xcode-version.sh, steps 1 to 3)." >&2
      fi
      if [ "$got_commit" != "$commit" ]; then
        echo "xcode-build: warning: $target says commit ${got_commit:-none}, but HEAD is $commit. The one-time Xcode hookup is not done (scripts/xcode-version.sh, step 4)." >&2
      fi
    fi
  fi
  i=$((i + 1))
done
