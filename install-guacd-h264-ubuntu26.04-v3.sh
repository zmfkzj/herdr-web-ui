#!/usr/bin/env bash
# Build a private guacd 1.6.0 / FreeRDP 3.32.2 stack for original Pi's pi-gui.
# Guacamole 1.6.0 labels FreeRDP 3.x support experimental. Smoke-test the actual
# KRDP desktop before relying on it. This is not a tested binary distribution.
# Private FreeRDP/guacd libraries are installed only under /opt/herdr-guacd.
# apt may install/update distribution dependencies; Herdr/Pi files, services,
# firewall rules, and system dynamic-loader configuration are not changed.
# Targets: Ubuntu 24.04 LTS (noble: glibc 2.39, GCC 13, CMake 3.28, FFmpeg 6.1)
# and Ubuntu 26.04 LTS (resolute: glibc 2.43, GCC 15, CMake 4.2, FFmpeg 8.0),
# including their point releases. Both use the same package names and the same
# FreeRDP / guacd sources, options and fixes. The filename still says 26.04 so
# that existing callers keep working. Not end-to-end tested against a real KRDP
# session.
#
# Where H.264 is used: the RDP server (KRDP) encodes the desktop as H.264
# (RDP Graphics Pipeline, AVC420). guacd decodes it through FreeRDP + FFmpeg
# and sends ordinary PNG/JPEG/WebP image updates to the browser. The browser
# never receives H.264. KRDP closes a session whose client does not advertise
# AVC420, and upstream guacd 1.6.0 does not advertise it, hence the local
# settings.c edit below. Do not set the RDP connection parameter disable-gfx.
#
# Revision 5 (Ubuntu 24.04 and 26.04):
# - Accepts Ubuntu 24.04 and 26.04 (ID=ubuntu, VERSION_ID and codename
#   checked) and explains every other system before anything is changed.
# - Checks that every apt dependency has a candidate (universe) before apt
#   installs anything.
# - Records the build target (ubuntu-VERSION-ARCH) in new build directories
#   and in the prefix. --resume refuses a build directory or prefix made for
#   another release or architecture, or a FreeRDP build configured by another
#   GCC major version. Unrecorded artifacts of the earlier 26.04-only revision
#   remain usable on Ubuntu 26.04 after the same checks.
#
# Revision 4 (fixes the failures of revision 3 on Ubuntu 26.04):
# - Backports upstream fixes that 1.6.0 lacks and that -Werror turns into
#   build failures with glibc 2.43:
#     GUACAMOLE-2136 (c3c4685): memchr() now returns const char* (string.c).
#     GUACAMOLE-2070 (2e2a336): IPv6 inet_pton() into a 4-byte sin_addr
#       (wol.c); glibc 2.43 fortify rejects the stack overflow.
# - Keeps the local GUACAMOLE-2182 config.h guard (_XOPEN_SOURCE 700 vs 800).
# - Replaces the decoder-initialization probe with a real AVC420 frame decode.
# - Shows compiler errors, not the many FreeRDP deprecation warnings, on failure.
# References:
# https://guacamole.apache.org/doc/1.6.0/gug/guacamole-native.html
# https://issues.apache.org/jira/browse/GUACAMOLE-2182
# https://github.com/apache/guacamole-server/commit/c3c4685be6bc528870f2c2fe55e071df339280f3
# https://github.com/apache/guacamole-server/commit/2e2a33621d673345e7b9d22c9388be80c6d77598
# https://github.com/FreeRDP/FreeRDP/releases/tag/3.32.2
# https://github.com/FreeRDP/FreeRDP/blob/3.32.2/channels/rdpgfx/client/rdpgfx_main.c
# Non-destructive checks: install-guacd-h264-ubuntu26.04-v3.check.sh [--build]
set -Eeuo pipefail
export LC_ALL=C
umask 022
trap 'printf "Build failed at line %s. Build directory: %s\n" "$LINENO" "${work:-not created}" >&2' ERR

usage() {
    printf '%s\n' \
        'Usage: bash install-guacd-h264-ubuntu26.04-v3.sh [--resume [BUILD_DIRECTORY]]' \
        'Supported: Ubuntu 24.04 LTS and 26.04 LTS (and their point releases), with universe.' \
        'Run as your normal user; sudo is requested for apt and for installing into /opt/herdr-guacd.' \
        'No arguments: install a new private FreeRDP / guacd stack.' \
        '--resume: reuse installed FreeRDP and finish guacd; no apt or FreeRDP rebuild.' \
        '  Use it after a run that installed FreeRDP but failed before guacd was installed.' \
        '  The build directory and FreeRDP must have been built for this Ubuntu release.' \
        'An omitted BUILD_DIRECTORY is allowed only if exactly one matching cached build exists.' \
        'BUILD_JOBS controls build parallelism (default: 4).' \
        'Nothing is deleted. No Herdr/Pi files, services, or firewall rules are changed.'
}

# BEGIN testable functions (loaded by install-guacd-h264-ubuntu26.04-v3.check.sh)
guacamole_url='https://downloads.apache.org/guacamole/1.6.0/source/guacamole-server-1.6.0.tar.gz'
guacamole_sha256=8bc45675da96d7b6f39728160181e3d4ff3c08f460f6d26de5805b642bf13f2b

# One list for both releases: 24.04 and 26.04 use the same package names. The
# FFmpeg development packages and ninja-build are in the universe component.
# libicu-dev: WinPR's Unicode conversion (FreeRDP default WITH_UNICODE_BUILTIN=OFF)
# needs ICU; without it FreeRDP's CMake step fails on a fresh system.
build_packages=(
    build-essential cmake ninja-build pkg-config libtool-bin patch curl ca-certificates python3
    libcairo2-dev libjpeg-turbo8-dev libpng-dev uuid-dev libssl-dev zlib1g-dev
    libwebp-dev libavcodec-dev libavutil-dev libswscale-dev libswresample-dev
    libavformat-dev libxkbcommon-dev libicu-dev
)
# Build-target records (target=ubuntu-VERSION-ARCH), compared by --resume.
build_target_record=herdr-build-target                  # in each new build directory
prefix_target_record=share/herdr-guacd/build-target      # relative to $prefix

# Read os-release (default /etc/os-release) and set target_pretty and
# build_target (ubuntu-VERSION-ARCH). Point releases keep VERSION_ID 24.04 /
# 26.04. $2 overrides the dpkg architecture (tests only).
detect_target_release() {
    local file=${1:-/etc/os-release} arch=${2:-} id version codename pretty expected
    local -a fields=()
    if [[ ! -f $file || ! -r $file ]]; then
        printf 'Cannot read %s. This installer supports native Ubuntu 24.04 LTS and 26.04 LTS only.\n' "$file" >&2
        return 1
    fi
    # os-release is a list of shell assignments; read it in a subshell only.
    mapfile -t fields < <(
        trap - ERR; set +eu
        # shellcheck source=/dev/null
        . "$file" > /dev/null 2>&1
        printf '%s\n' "${ID-}" "${VERSION_ID-}" "${VERSION_CODENAME-}" "${PRETTY_NAME-}")
    id=${fields[0]-} version=${fields[1]-} codename=${fields[2]-} pretty=${fields[3]-}
    case $version in
        24.04) expected=noble ;;
        26.04) expected=resolute ;;
        *) expected= ;;
    esac
    if [[ $id != ubuntu ]]; then
        printf 'Unsupported system: %s (ID=%s). Supported: native Ubuntu 24.04 LTS and 26.04 LTS;\n' \
            "${pretty:-unknown}" "${id:-missing}" >&2
        echo 'Ubuntu derivatives and other distributions are not supported. Nothing was modified.' >&2
        return 1
    fi
    if [[ -z $expected ]]; then
        printf 'Unsupported Ubuntu release: %s (VERSION_ID=%s). Supported: 24.04 LTS (noble) and\n' \
            "${pretty:-unknown}" "${version:-missing}" >&2
        echo '26.04 LTS (resolute), including their point releases. Nothing was modified.' >&2
        return 1
    fi
    if [[ $codename != "$expected" ]]; then
        printf 'Inconsistent %s: VERSION_ID=%s requires VERSION_CODENAME=%s, found %s. Nothing was modified.\n' \
            "$file" "$version" "$expected" "${codename:-nothing}" >&2
        return 1
    fi
    [[ -n $arch ]] || arch=$(dpkg --print-architecture 2> /dev/null) || arch=
    if [[ ! $arch =~ ^[a-z0-9]+$ ]]; then
        echo 'Cannot determine the dpkg architecture (dpkg --print-architecture). Nothing was modified.' >&2
        return 1
    fi
    target_pretty=${pretty:-Ubuntu $version}
    build_target=ubuntu-$version-$arch
    printf 'Target system: %s (%s, %s); build target %s\n' "$target_pretty" "$codename" "$arch" "$build_target"
}

# After apt-get update: fail before installing anything when a dependency has
# no candidate, usually because the universe component is disabled.
check_package_candidates() {
    local pkg candidate
    local -a missing=()
    for pkg in "${build_packages[@]}"; do
        candidate=$(apt-cache policy "$pkg" 2> /dev/null \
            | sed -n 's/^[[:space:]]*Candidate:[[:space:]]*//p' | head -n 1) || candidate=
        [[ -n $candidate && $candidate != '(none)' ]] || missing+=("$pkg")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        printf 'No apt installation candidate on %s for: %s\n' "${target_pretty:-this system}" "${missing[*]}" >&2
        echo 'ninja-build and the FFmpeg -dev packages are in the universe component. Enable it' >&2
        echo '(sudo add-apt-repository universe && sudo apt-get update) and rerun. Nothing was installed.' >&2
        return 1
    fi
    printf 'All %s build dependencies have an apt candidate.\n' "${#build_packages[@]}"
}

write_build_target_record() {  # $1 = file to create
    printf '%s\n' \
        '# Written by install-guacd-h264-ubuntu26.04-v3.sh; --resume compares target=.' \
        "target=$build_target" "os=$target_pretty" 'freerdp=3.32.2' 'guacamole-server=1.6.0' > "$1"
}

read_build_target_record() {  # $1 = record file; prints its target
    local -a targets=()
    mapfile -t targets < <(sed -n 's/^target=//p' "$1")
    if [[ ${#targets[@]} -ne 1 || ! ${targets[0]} =~ ^ubuntu-[0-9]{2}\.[0-9]{2}-[a-z0-9]+$ ]]; then
        printf 'Unreadable build-target record: %s\n' "$1" >&2
        return 1
    fi
    printf '%s\n' "${targets[0]}"
}

# GCC major version that configured the FreeRDP build in build directory $1.
cached_compiler_major() {
    local file version
    local -A majors=()
    for file in "$1"/freerdp-build/CMakeFiles/*/CMakeCCompiler.cmake; do
        [[ -f $file ]] || continue
        version=$(sed -n 's/^set(CMAKE_C_COMPILER_VERSION "\([0-9][0-9.]*\)")$/\1/p' "$file")
        if [[ -n $version ]]; then majors[${version%%.*}]=1; fi
    done
    if [[ ${#majors[@]} -ne 1 ]]; then
        printf 'Cannot tell which GCC configured the FreeRDP build in %s.\n' "$1" >&2
        return 1
    fi
    printf '%s\n' "${!majors[@]}"
}

# Is cached build directory $1 usable for $build_target with GCC $host_gcc_major?
# Unrecorded directories come from the earlier Ubuntu 26.04-only revision.
check_build_dir_target() {
    local dir=$1 recorded compiler origin
    if [[ -f $dir/$build_target_record ]]; then
        recorded=$(read_build_target_record "$dir/$build_target_record") || return 1
        if [[ $recorded != "$build_target" ]]; then
            printf 'Build directory %s was created for %s; this system is %s.\n' \
                "$dir" "$recorded" "$build_target" >&2
            return 1
        fi
        origin="recorded target $recorded"
    elif [[ $build_target == ubuntu-26.04-* ]]; then
        origin='no target record: earlier Ubuntu 26.04-only revision'
    else
        printf 'Build directory %s has no build-target record: the earlier installer made it on\n' "$dir" >&2
        printf 'Ubuntu 26.04 only, so it cannot be reused on %s.\n' "$build_target" >&2
        return 1
    fi
    compiler=$(cached_compiler_major "$dir") || return 1
    if [[ $compiler != "$host_gcc_major" ]]; then
        printf 'FreeRDP in %s was configured by GCC %s; /usr/bin/gcc is GCC %s.\n' \
            "$dir" "$compiler" "${host_gcc_major:-unknown}" >&2
        return 1
    fi
    printf 'Build directory target: OK (%s, GCC %s).\n' "$origin" "$compiler"
}

# Is the FreeRDP installed in $prefix recorded for $build_target? Unrecorded
# prefixes come from the earlier Ubuntu 26.04-only revision; the pkg-config,
# runtime-library and AVC420 decode checks that follow still apply to them.
check_prefix_target() {
    local record=$prefix/$prefix_target_record recorded
    if [[ -f $record ]]; then
        recorded=$(read_build_target_record "$record") || return 1
        if [[ $recorded != "$build_target" ]]; then
            printf '%s was built for %s; this system is %s.\n' "$prefix" "$recorded" "$build_target" >&2
            return 1
        fi
        printf 'Installed FreeRDP target: OK (recorded target %s).\n' "$recorded"
    elif [[ $build_target == ubuntu-26.04-* ]]; then
        printf 'Installed FreeRDP target: no record (earlier Ubuntu 26.04-only revision); checked below.\n'
    else
        printf '%s has no build-target record: the earlier installer built it on Ubuntu 26.04 only,\n' "$prefix" >&2
        printf 'so it cannot be reused on %s.\n' "$build_target" >&2
        return 1
    fi
}

verify_private_freerdp() {
    local expected_root expected_pc expected_lib pc actual_pc raw_prefix raw_lib
    local version actual_root actual_lib pc_path
    expected_root=$(realpath -e -- "$prefix") || return 1
    expected_pc=$(realpath -e -- "$prefix/lib/pkgconfig") || return 1
    expected_lib=$(realpath -e -- "$prefix/lib") || return 1
    for pc in freerdp3 freerdp-client3 winpr3; do
        if ! /usr/bin/pkg-config --print-errors --exists "$pc"; then
            printf 'Cannot resolve pkg-config module: %s\n' "$pc" >&2
            return 1
        fi
        actual_pc=$(/usr/bin/pkg-config --variable=pcfiledir "$pc") || return 1
        raw_prefix=$(/usr/bin/pkg-config --variable=prefix "$pc") || return 1
        raw_lib=$(/usr/bin/pkg-config --variable=libdir "$pc") || return 1
        version=$(/usr/bin/pkg-config --modversion "$pc") || return 1
        printf '%s: version=%s\n  pcfiledir=%s\n  prefix=%s\n  libdir=%s\n' \
            "$pc" "$version" "$actual_pc" "$raw_prefix" "$raw_lib"
        # Never turn an empty variable into the working directory with realpath.
        if [[ $actual_pc != /* || $raw_prefix != /* || $raw_lib != /* ]]; then
            echo "Missing or non-absolute pkg-config paths for $pc; no build attempted." >&2
            return 1
        fi
        pc_path=$(realpath -e -- "$actual_pc/$pc.pc") || return 1
        actual_root=$(realpath -e -- "$raw_prefix") || return 1
        actual_lib=$(realpath -e -- "$raw_lib") || return 1
        if [[ $pc_path != "$expected_pc/$pc.pc" || $actual_root != "$expected_root" \
              || $actual_lib != "$expected_lib" || $version != 3.32.2 ]]; then
            printf 'Wrong %s selection. Expected .pc=%s/%s.pc, prefix=%s, libdir=%s, version=3.32.2\n' \
                "$pc" "$expected_pc" "$pc" "$expected_root" "$expected_lib" >&2
            printf 'Resolved .pc=%s, prefix=%s, libdir=%s, version=%s\n' \
                "$pc_path" "$actual_root" "$actual_lib" "$version" >&2
            return 1
        fi
    done
    printf 'Private FreeRDP pkg-config paths: OK (canonical paths checked).\n'
}

select_resume_work() {
    local candidate selected actual_source saved_source saved_prefix reason
    local -a candidates=()
    if [[ -n $resume_dir ]]; then
        candidates=("$resume_dir")
    else
        for candidate in "$HOME"/.cache/herdr-guacd/build.*; do
            [[ -d $candidate && ! -L $candidate ]] || continue
            [[ -f $candidate/freerdp-build/CMakeCache.txt \
               && -f $candidate/guacamole/configure \
               && -f $candidate/guacamole/src/protocols/rdp/settings.c ]] || continue
            saved_prefix=$(sed -n 's/^CMAKE_INSTALL_PREFIX:PATH=//p' "$candidate/freerdp-build/CMakeCache.txt")
            [[ $saved_prefix == "$prefix" ]] || continue
            if ! reason=$(check_build_dir_target "$candidate" 2>&1 > /dev/null); then
                printf 'Skipping incompatible cached build %s:\n' "$candidate" >&2
                printf '%s\n' "$reason" | sed 's/^/  /' >&2
                continue
            fi
            candidates+=("$candidate")
        done
    fi
    if [[ ${#candidates[@]} -ne 1 ]]; then
        printf 'Expected one cached build, found %s. Nothing was modified.\n' "${#candidates[@]}" >&2
        if [[ ${#candidates[@]} -gt 0 ]]; then printf '  %s\n' "${candidates[@]}" >&2; fi
        echo 'Use --resume /absolute/build/directory from the previous build log.' >&2
        return 1
    fi
    selected=$(realpath -e -- "${candidates[0]}") || return 1
    [[ -f $selected/freerdp-build/CMakeCache.txt \
       && -f $selected/guacamole/configure \
       && -f $selected/guacamole/src/protocols/rdp/settings.c ]] || {
        echo 'The selected directory does not contain the previous build.' >&2; return 1;
    }
    saved_prefix=$(sed -n 's/^CMAKE_INSTALL_PREFIX:PATH=//p' "$selected/freerdp-build/CMakeCache.txt")
    saved_source=$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "$selected/freerdp-build/CMakeCache.txt")
    [[ $saved_prefix == /* && $saved_source == /* ]] || {
        echo 'Required CMake cache paths are missing.' >&2; return 1;
    }
    actual_source=$(realpath -e -- "$selected/freerdp") || return 1
    if [[ $(realpath -e -- "$saved_prefix") != "$(realpath -e -- "$prefix")" \
       || $(realpath -e -- "$saved_source") != "$actual_source" ]]; then
        echo 'CMake cache does not match this install/source directory; nothing was modified.' >&2
        return 1
    fi
    check_build_dir_target "$selected" || {
        echo 'This cached build cannot be resumed on this system; nothing was modified.' >&2
        return 1
    }
    work=$selected
}

# Decode one real AVC420 (H.264 4:2:0) frame with the given libfreerdp3 and
# check its pixels. This is the codec call FreeRDP's GDI makes for a GFX
# AVC420 surface command inside guacd. It does not test an RDP connection.
probe_h264_decoder() {
    python3 - "$1" <<'PY_H264_PROBE'
import base64, ctypes, sys

lib = ctypes.CDLL(sys.argv[1])
lib.freerdp_get_build_config.argtypes = []
lib.freerdp_get_build_config.restype = ctypes.c_char_p
config = (lib.freerdp_get_build_config() or b'').decode('utf-8', 'replace').split()
# rdpgfx only advertises AVC420 when FreeRDP was built with WITH_GFX_H264.
for key in ('WITH_GFX_H264=ON', 'WITH_VIDEO_FFMPEG=ON'):
    if key not in config:
        raise SystemExit('Missing required codec build setting: ' + key)

# 64x64 IDR frame, left half BGR(200,40,40), right half BGR(0,128,255).
# Encoded with FreeRDP 3.32.2 avc420_compress (libx264, QP 10); SEI removed.
sample = base64.b64decode(
    'AAAAAWdkAAqssghNCAAAAwAIAAADAeR4kTJAAAAAAWjrwEMsiwAAAAFliIQ6/ubA+ZZY'
    '3XOAQdjK6VbSKb9iTX4pvqBVtcuYUgt6u4qe+nS8C/JmiuceQ50=')
BGRX32 = (32 << 24) | (4 << 16) | (8 << 8) | (8 << 4) | 8  # PIXEL_FORMAT_BGRX32
size = 64

class RECTANGLE_16(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint16) for name in ('left', 'top', 'right', 'bottom')]

lib.h264_context_new.argtypes = [ctypes.c_int]
lib.h264_context_new.restype = ctypes.c_void_p
lib.h264_context_reset.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32]
lib.h264_context_reset.restype = ctypes.c_int
lib.h264_context_free.argtypes = [ctypes.c_void_p]
lib.h264_context_free.restype = None
lib.avc420_decompress.argtypes = [
    ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32,
    ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(RECTANGLE_16),
    ctypes.c_uint32]
lib.avc420_decompress.restype = ctypes.c_int32

ctx = lib.h264_context_new(0)  # FALSE: decoder
if not ctx:
    raise SystemExit('FreeRDP H.264 decoder initialization failed.')
frame = ctypes.create_string_buffer(size * size * 4)
try:
    if not lib.h264_context_reset(ctx, size, size):
        raise SystemExit('FreeRDP H.264 decoder reset failed.')
    status = lib.avc420_decompress(ctx, sample, len(sample), frame, BGRX32, size * 4,
                                   size, size, ctypes.byref(RECTANGLE_16(0, 0, size, size)), 1)
    if status < 0:
        raise SystemExit(f'FreeRDP AVC420 decode failed with status {status}.')
finally:
    lib.h264_context_free(ctx)

for (x, y), expected in (((16, 32), (200, 40, 40)), ((48, 32), (0, 128, 255))):
    offset = (y * size + x) * 4
    actual = tuple(frame.raw[offset:offset + 3])
    if any(abs(a - e) > 24 for a, e in zip(actual, expected)):
        raise SystemExit(f'Decoded H.264 pixel at {x},{y} is {actual}, expected about {expected}.')
print('Private FreeRDP AVC420 (H.264) frame decode: OK (library only, no RDP session)')
PY_H264_PROBE
}

# Apply an upstream patch read from stdin in the current source directory.
# Already applied: no change. Neither applicable nor applied: fail unchanged.
apply_upstream_patch() {
    local name=$1 file
    file="$work/upstream-$name.patch"
    cat > "$file" || return 1
    # --force: never let --batch guess that an unapplied patch is reversed.
    if patch -p1 -R --force --dry-run --batch --silent < "$file" > /dev/null 2>&1; then
        printf 'Upstream backport already applied: %s\n' "$name"
    elif patch -p1 --forward --dry-run --batch --silent < "$file" > /dev/null 2>&1; then
        patch -p1 --forward --batch --no-backup-if-mismatch < "$file" || return 1
        printf 'Upstream backport applied: %s\n' "$name"
    else
        printf 'Upstream backport %s does not apply to %s; this patch changed nothing.\n' \
            "$name" "$PWD" >&2
        echo 'Use a fresh guacamole-server-1.6.0 source (run without --resume after moving the old build away).' >&2
        return 1
    fi
}

# Source changes to the verified guacamole-server 1.6.0 release in $work/guacamole.
apply_guacamole_source_fixes() {
    cd "$work/guacamole" || return 1
    command -v patch > /dev/null || { echo 'The patch command is missing (apt install patch).' >&2; return 1; }

    # FreeRDP leaves GfxH264 FALSE by default (libfreerdp/core/settings.c) and
    # upstream guacd 1.6.0 only enables the Graphics Pipeline, so rdpgfx would
    # not advertise AVC420. Request AVC420 only; AVC444 stays off.
    python3 - <<'PY_AVC420' || return 1
from pathlib import Path
p = Path('src/protocols/rdp/settings.c')
s = p.read_text()
needle = '        freerdp_settings_set_bool(rdp_settings, FreeRDP_SupportGraphicsPipeline, TRUE);'
if s.count(needle) != 1:
    raise SystemExit('Unexpected guacd source: refusing the AVC420 edit.')
extra = '''
        /* Local pi-gui integration: explicitly advertise AVC420. */
        freerdp_settings_set_bool(rdp_settings, FreeRDP_GfxH264, TRUE);
        freerdp_settings_set_bool(rdp_settings, FreeRDP_GfxAVC444, FALSE);'''
if extra in s:
    print('Existing AVC420 source change retained.')
elif 'Local pi-gui integration: explicitly advertise AVC420.' in s:
    raise SystemExit('Unexpected partial AVC420 change; refusing to modify source.')
else:
    p.write_text(s.replace(needle, needle + extra))
    print('AVC420 source change applied.')
PY_AVC420

    # Verbatim diffs of the upstream commits named in the header.
    apply_upstream_patch GUACAMOLE-2136-c3c4685 <<'GUAC_PATCH_2136' || return 1
diff --git a/src/guaclog/keydef.c b/src/guaclog/keydef.c
index b9fc1db2d3..33ef2626cc 100644
--- a/src/guaclog/keydef.c
+++ b/src/guaclog/keydef.c
@@ -144,7 +144,7 @@ static int guaclog_keydef_bsearch_compare(const void* key,
         const void* member) {
 
     int keysym = (int) ((intptr_t) key);
-    guaclog_keydef* current = (guaclog_keydef*) member;
+    const guaclog_keydef* current = (const guaclog_keydef*) member;
 
     /* Compare given keysym to keysym of current member */
     return keysym  - current->keysym;
@@ -163,7 +163,7 @@ static int guaclog_keydef_bsearch_compare(const void* key,
  *     A pointer to the static guaclog_keydef associated with the given keysym,
  *     or NULL if the key could not be found.
  */
-static guaclog_keydef* guaclog_get_known_key(int keysym) {
+static const guaclog_keydef* guaclog_get_known_key(int keysym) {
 
     /* Search through known keys for given keysym */
     return bsearch((void*) ((intptr_t) keysym),
@@ -280,7 +280,7 @@ static guaclog_keydef* guaclog_get_unicode_key(int keysym) {
  *     A newly-allocated guaclog_keydef structure copied from the given
  *     guaclog_keydef.
  */
-static guaclog_keydef* guaclog_copy_key(guaclog_keydef* keydef) {
+static guaclog_keydef* guaclog_copy_key(const guaclog_keydef* keydef) {
 
     guaclog_keydef* copy = guac_mem_alloc(sizeof(guaclog_keydef));
 
@@ -301,7 +301,7 @@ static guaclog_keydef* guaclog_copy_key(guaclog_keydef* keydef) {
 
 guaclog_keydef* guaclog_keydef_alloc(int keysym) {
 
-    guaclog_keydef* keydef;
+    const guaclog_keydef* keydef;
 
     /* Check list of known keys first */
     keydef = guaclog_get_known_key(keysym);
diff --git a/src/libguac/string.c b/src/libguac/string.c
index 7cb26ccab0..2b3c286c07 100644
--- a/src/libguac/string.c
+++ b/src/libguac/string.c
@@ -118,25 +118,28 @@ char* guac_strnstr(const char *haystack, const char *needle, size_t len) {
 #ifdef HAVE_STRNSTR
     return strnstr(haystack, needle, len);
 #else
-    char* chr;
-    size_t nlen = strlen(needle), off = 0;
+    const char* chr;
+    size_t nlen = strlen(needle);
 
     /* Follow documented API: return haystack if needle is the empty string. */
     if (nlen == 0)
-        return (char *)haystack;
+        return (char*) haystack;
 
     /* Use memchr to find candidates. It might be optimized in asm. */
-    while (off < len && NULL != (chr = memchr(haystack + off, needle[0], len - off))) {
+    for (size_t off = 0; off < len
+            && NULL != (chr = memchr(haystack + off, needle[0], len - off)); off++) {
+
         /* chr is guaranteed to be in bounds of and >= haystack. */
         off = chr - haystack;
+
         /* If needle would go beyond provided len, it doesn't exist in haystack. */
         if (off + nlen > len)
             return NULL;
+
         /* Now that we know we have at least nlen bytes, compare them. */
         if (!memcmp(chr, needle, nlen))
-            return chr;
-        /* Make sure we make progress. */
-        off += 1;
+            return (char*) chr;
+
     }
 
     /* memchr ran out of candidates, needle wasn't found. */
diff --git a/src/terminal/named-colors.c b/src/terminal/named-colors.c
index 948982afe3..71713d3b88 100644
--- a/src/terminal/named-colors.c
+++ b/src/terminal/named-colors.c
@@ -784,7 +784,7 @@ static int guac_terminal_named_color_search(const void* a, const void* b) {
 int guac_terminal_find_color(const char* name, guac_terminal_color* color) {
 
     /* Search for the color having the given name */
-    guac_terminal_named_color* found = bsearch(name,
+    const guac_terminal_named_color* found = bsearch(name,
             GUAC_TERMINAL_NAMED_COLORS, GUAC_TERMINAL_NAMED_COLORS_LENGTH,
             sizeof(guac_terminal_named_color),
             guac_terminal_named_color_search);
GUAC_PATCH_2136
    apply_upstream_patch GUACAMOLE-2070-2e2a336 <<'GUAC_PATCH_2070' || return 1
diff --git a/src/libguac/wol.c b/src/libguac/wol.c
index 1671abcfc0..32ddedfdea 100644
--- a/src/libguac/wol.c
+++ b/src/libguac/wol.c
@@ -63,6 +63,173 @@ static void __guac_wol_create_magic_packet(unsigned char packet[],
     
 }
 
+/**
+ * Converts the given IPv4 address and UDP port number into its binary
+ * representation (struct sockaddr_in). The size of the structure used will be
+ * stored in wol_dest_size.
+ *
+ * @param addr
+ *     The IPv4 address to convert.
+ *
+ * @param udp_port
+ *     The UDP port number to convert and include in the resulting sockaddr_in
+ *     structure.
+ *
+ * @param wol_dest
+ *     Storage that is sufficiently large and correctly aligned such that it
+ *     may be typecast as a sockaddr_in without issue (this is guaranteed by
+ *     the definition of the sockaddr_storage structure).
+ *
+ * @param wol_dest_size
+ *     Pointer to a socklen_t that should receive the size of the sockaddr_in
+ *     structure. This value is assigned only if this call succeeds.
+ *
+ * @return
+ *     A positive value if conversion succeeded, zero if conversion failed, and
+ *     a negative value if IPv4 is unsupported by this system.
+ */
+static int __guac_wol_convert_addr_ipv4(const char* addr, const unsigned short udp_port,
+        struct sockaddr_storage* wol_dest, socklen_t* wol_dest_size) {
+
+    struct sockaddr_in* wol_dest_ipv4 = (struct sockaddr_in*) wol_dest;
+    *wol_dest_size = sizeof(struct sockaddr_in);
+
+    /* Init address structure for IPv4 details */
+    memset(wol_dest, 0, *wol_dest_size);
+    wol_dest_ipv4->sin_port = htons(udp_port);
+    wol_dest_ipv4->sin_family = AF_INET;
+
+    return inet_pton(wol_dest_ipv4->sin_family, addr, &(wol_dest_ipv4->sin_addr));
+
+}
+
+/**
+ * Converts the given IPv6 address and UDP port number into its binary
+ * representation (struct sockaddr_in6). The size of the structure used will be
+ * stored in wol_dest_size.
+ *
+ * @param addr
+ *     The IPv6 address to convert.
+ *
+ * @param udp_port
+ *     The UDP port number to convert and include in the resulting sockaddr_in6
+ *     structure.
+ *
+ * @param wol_dest
+ *     Storage that is sufficiently large and correctly aligned such that it
+ *     may be typecast as a sockaddr_in6 without issue (this is guaranteed by
+ *     the definition of the sockaddr_storage structure).
+ *
+ * @param wol_dest_size
+ *     Pointer to a socklen_t that should receive the size of the sockaddr_in6
+ *     structure. This value is assigned only if this call succeeds.
+ *
+ * @return
+ *     A positive value if conversion succeeded, zero if conversion failed, and
+ *     a negative value if IPv6 is unsupported by this system.
+ */
+static int __guac_wol_convert_addr_ipv6(const char* addr, const unsigned short udp_port,
+         struct sockaddr_storage* wol_dest, socklen_t* wol_dest_size) {
+
+    struct sockaddr_in6* wol_dest_ipv6 = (struct sockaddr_in6*) wol_dest;
+    *wol_dest_size = sizeof(struct sockaddr_in6);
+
+    /* Init address structure for IPv6 details */
+    memset(wol_dest, 0, *wol_dest_size);
+    wol_dest_ipv6->sin6_family = AF_INET6;
+    wol_dest_ipv6->sin6_port = htons(udp_port);
+
+    return inet_pton(wol_dest_ipv6->sin6_family, addr, &(wol_dest_ipv6->sin6_addr));
+
+}
+
+/**
+ * Converts the given IPv4 or IPv6 address and UDP port number into its binary
+ * representation (either a struct sockaddr_in or struct sockaddr_in6). The
+ * size of the structure used will be stored in wol_dest_size. If conversion
+ * fails, guac_error and guac_error_message are set appropriately.
+ *
+ * @param addr
+ *     The address to convert.
+ *
+ * @param udp_port
+ *     The UDP port number to convert and include in the resulting structure.
+ *
+ * @param wol_dest
+ *     Storage that is sufficiently large and correctly aligned such that it
+ *     may be typecast as a sockaddr_in OR sockaddr_in6 without issue (this is
+ *     guaranteed by the definition of the sockaddr_storage structure).
+ *
+ * @param wol_dest_size
+ *     Pointer to a socklen_t that should receive the size of the structure
+ *     ultimately used. This value is assigned only if this call succeeds.
+ *
+ * @return
+ *     Non-zero if conversion succeeded, zero otherwise.
+ */
+static int __guac_wol_convert_addr(const char* addr, const unsigned short udp_port,
+          struct sockaddr_storage* wol_dest, socklen_t* wol_dest_size) {
+
+    /* Attempt to resolve as an IPv4 address first */
+    int ipv4_retval = __guac_wol_convert_addr_ipv4(addr, udp_port, wol_dest, wol_dest_size);
+    if (ipv4_retval > 0)
+        return 1;
+
+    /* Failing that, reattempt as IPv6 */
+    int ipv6_retval = __guac_wol_convert_addr_ipv6(addr, udp_port, wol_dest, wol_dest_size);
+    if (ipv6_retval > 0)
+        return 1;
+
+    /*
+     * Translate all possible IPv4 / IPv6 failure combinations into a single,
+     * human-readable message.
+     */
+
+    /* The provided address is not valid IPv4 ... */
+    if (ipv4_retval == 0) {
+
+        /* ... and also not valid IPv6. */
+        if (ipv6_retval == 0) {
+            guac_error = GUAC_STATUS_INVALID_ARGUMENT;
+            guac_error_message = "The broadcast or multicast address "
+                "specified for Wake-on-LAN is not a valid IPv4 or IPv6 "
+                "address";
+        }
+
+        /* ... but we can't try IPv6 because this system doesn't support it. */
+        else {
+            guac_error = GUAC_STATUS_INVALID_ARGUMENT;
+            guac_error_message = "IPv6 is not supported by this system and "
+                "the broadcast/multicast address specified for Wake-on-LAN is "
+                "not a valid IPv4 address";
+        }
+
+    }
+
+    /* This system bizarrely doesn't support IPv4 ... */
+    else {
+
+        /* ... and the provided address is not valid IPv6. */
+        if (ipv6_retval == 0) {
+            guac_error = GUAC_STATUS_INVALID_ARGUMENT;
+            guac_error_message = "IPv4 is not supported by this system and "
+                "the broadcast/multicast address specified for Wake-on-LAN is "
+                "not a valid IPv6 address";
+        }
+
+        /* ... nor IPv6 (should be impossible). */
+        else {
+            guac_error = GUAC_STATUS_NOT_SUPPORTED;
+            guac_error_message = "Neither IPv4 nor IPv6 is supported by this "
+                "system (this should not be possible)";
+        }
+
+    }
+
+    return 0;
+
+}
+
 /**
  * Send the magic Wake-on-LAN (WoL) packet to the specified broadcast address,
  * returning the number of bytes sent, or zero if any error occurred and nothing
@@ -82,46 +249,16 @@ static void __guac_wol_create_magic_packet(unsigned char packet[],
  */
 static ssize_t __guac_wol_send_packet(const char* broadcast_addr,
         const unsigned short udp_port, unsigned char packet[]) {
-    
-    struct sockaddr_in wol_dest;
-    int wol_socket;
-    
-    /* Determine the IP version, starting with IPv4. */
-    wol_dest.sin_port = htons(udp_port);
-    wol_dest.sin_family = AF_INET;
-    int retval = inet_pton(wol_dest.sin_family, broadcast_addr, &(wol_dest.sin_addr));
-    
-    /* If return value is less than zero, this system doesn't know about IPv4. */
-    if (retval < 0) {
-        guac_error = GUAC_STATUS_SEE_ERRNO;
-        guac_error_message = "IPv4 address family is not supported";
+
+    struct sockaddr_storage wol_dest;
+    socklen_t wol_dest_size;
+
+    /* Resolve broadcast address */
+    if (!__guac_wol_convert_addr(broadcast_addr, udp_port, &wol_dest, &wol_dest_size))
         return 0;
-    }
-    
-    /* If return value is zero, address doesn't match the IPv4, so try IPv6. */
-    else if (retval == 0) {
-        wol_dest.sin_family = AF_INET6;
-        retval = inet_pton(wol_dest.sin_family, broadcast_addr, &(wol_dest.sin_addr));
-        
-        /* System does not support IPv6. */
-        if (retval < 0) {
-            guac_error = GUAC_STATUS_SEE_ERRNO;
-            guac_error_message = "IPv6 address family is not supported";
-            return 0;
-        }
-        
-        /* Address didn't match IPv6. */
-        else if (retval == 0) {
-            guac_error = GUAC_STATUS_INVALID_ARGUMENT;
-            guac_error_message = "Invalid broadcast or multicast address specified for Wake-on-LAN";
-            return 0;
-        }
-    }
-    
-    
-    
+
     /* Set up the socket */
-    wol_socket = socket(wol_dest.sin_family, SOCK_DGRAM, 0);
+    int wol_socket = socket(wol_dest.ss_family, SOCK_DGRAM, 0);
     
     /* If socket open fails, bail out. */
     if (wol_socket < 0) {
@@ -129,10 +266,10 @@ static ssize_t __guac_wol_send_packet(const char* broadcast_addr,
         guac_error_message = "Failed to open socket to send Wake-on-LAN packet";
         return 0;
     }
-    
+
     /* Set up socket for IPv4 broadcast. */
-    if (wol_dest.sin_family == AF_INET) {
-        
+    if (wol_dest.ss_family == AF_INET) {
+
         /* For configuring socket broadcast */
         int wol_bcast = 1;
 
@@ -161,10 +298,10 @@ static ssize_t __guac_wol_send_packet(const char* broadcast_addr,
             return 0;
         }
     }
-    
+
     /* Send the packet and return number of bytes sent. */
     int bytes = sendto(wol_socket, packet, GUAC_WOL_PACKET_SIZE, 0,
-            (struct sockaddr*) &wol_dest, sizeof(wol_dest));
+            (struct sockaddr*) &wol_dest, wol_dest_size);
     close(wol_socket);
     return bytes;
  
GUAC_PATCH_2070
}

# GUACAMOLE-2182: upstream 1.6.0 includes the unguarded generated config.h
# from several headers. glibc 2.43 raises _XOPEN_SOURCE from 700 to 800 when
# _GNU_SOURCE is set, after which including config.h again is a
# macro-redefinition error under -Werror. Keep every config macro and source
# include intact, but read config.h once, before ANY system header.
# Apply this only AFTER configure: FreeRDP feature probes must remain unchanged.
guard_generated_config_h() {
    python3 - <<'PY_CONFIG_GUARD' || return 1
from pathlib import Path
import re
import tempfile

p = Path('config.h')
text = p.read_text()
marker = 'HERDR_GUACD_CONFIG_H_INCLUDED_ONCE'
head = f'#ifndef {marker}\n#define {marker} 1\n'
tail = f'\n#endif /* {marker} */\n'
if marker in text:
    if not (text.startswith(head) and text.endswith(tail)):
        raise SystemExit('Unexpected partial config.h guard; no change made.')
    print('Existing generated config.h guard retained.')
else:
    checks = (
        r'^#define\s+PACKAGE_VERSION\s+"1\.6\.0"\s*$',
        r'^#define\s+_GNU_SOURCE\s+1\s*$',
        r'^#define\s+_XOPEN_SOURCE\s+700\s*$',
    )
    if not all(re.search(pattern, text, re.MULTILINE) for pattern in checks):
        raise SystemExit('Unexpected generated config.h; refusing compatibility edit.')
    with tempfile.NamedTemporaryFile(mode='w', dir='.', prefix='config.h.before-guard.',
                                     delete=False) as backup:
        backup.write(text)
        backup_name = backup.name
    p.write_text(head + text + tail)
    print('Generated config.h guarded; original saved as ' + backup_name)
PY_CONFIG_GUARD
}

# Configure and compile guacd in $work/guacamole against the private FreeRDP
# in $prefix. Installs nothing. Sets guac_make_flags for the install step.
build_guacamole() {
    local log backup build_status
    # Guacamole checks FreeRDP 2 before 3. Do not accidentally select the host's
    # FreeRDP 2 if its development package is already installed.
    # Only this configure invocation uses the wrapper; host pkg-config is unchanged.
    cat > "$work/pkg-config-freerdp3" <<'PKG'
#!/bin/sh
for arg in "$@"; do
    case "$arg" in *freerdp2*|*freerdp-client2*|*winpr2*) exit 1 ;; esac
done
exec /usr/bin/pkg-config "$@"
PKG
    chmod +x "$work/pkg-config-freerdp3"

    # Keep the original diagnostics across retries instead of overwriting them.
    for log in guacamole-configure.log guacamole-build.log guacamole-install.log; do
        if [[ -f $work/$log ]]; then
            backup=$(mktemp "$work/$log.previous.XXXXXX")
            cp -- "$work/$log" "$backup"
            printf 'Previous log preserved: %s\n' "$backup"
        fi
    done

    cd "$work/guacamole" || return 1
    PKG_CONFIG="$work/pkg-config-freerdp3" \
        LDFLAGS="-L$prefix/lib -Wl,-rpath,$prefix/lib" \
        CFLAGS="-O2 -std=gnu11 -Wno-error=deprecated-declarations" \
        CPPFLAGS="-Wno-error=deprecated-declarations" \
        ./configure --prefix="$prefix" --libdir="$prefix/lib" --with-rdp \
        --with-freerdp-plugin-dir="$prefix/lib/freerdp3" \
        --with-guacd-conf="$prefix/etc/guacd.conf" \
        --without-vnc --without-ssh --without-telnet --disable-kubernetes \
        --without-terminal --disable-guacenc --disable-guaclog \
        2>&1 | tee "$work/guacamole-configure.log" || return 1
    # FreeRDP's version is printed on the library row, not on the RDP protocol row.
    if ! grep -Eq '^[[:space:]]*freerdp[[:space:].]+yes[[:space:]]+\(3\.x\)' "$work/guacamole-configure.log" \
        || ! grep -Eq '^[[:space:]]*RDP[[:space:].]+yes[[:space:]]*$' "$work/guacamole-configure.log"; then
        echo 'Guacamole did not select FreeRDP 3; refusing installation.' >&2
        return 1
    fi
    # FreeRDP 3 requires the settings accessor path that received the AVC420 edit.
    if ! grep -Eq '^#define[[:space:]]+HAVE_SETTERS_GETTERS([[:space:]]|$)' config.h; then
        echo 'FreeRDP settings accessors were not detected; inspect config.log.' >&2
        return 1
    fi
    guard_generated_config_h || return 1

    # Command-line CFLAGS apply to recursive make and come after per-target flags.
    # Force the same guarded config into every compilation, even files that only
    # obtained it indirectly. Do not silence warnings or disable -Werror globally.
    guac_make_flags=(V=1 "CFLAGS=-O2 -std=gnu11 -Wno-error=deprecated-declarations -include \"$work/guacamole/config.h\"")
    if make -j"$jobs" "${guac_make_flags[@]}" 2>&1 | tee "$work/guacamole-build.log"; then
        :
    else
        build_status=$?
        # FreeRDP 3.32 headers emit many deprecation warnings; show errors only.
        printf '\nGuacamole build failed. First compiler errors:\n' >&2
        grep -n -m 12 -B 3 -A 5 -E '(^|[[:space:]])(fatal error|error):' \
            "$work/guacamole-build.log" >&2 || true
        printf '\nFull build log: %s/guacamole-build.log\n' "$work" >&2
        printf 'No guacd install was attempted. FreeRDP and sources were retained.\n' >&2
        return "$build_status"
    fi
}
# END testable functions

mode=install
resume_dir=
case ${1:-} in
    --help|-h) usage; exit 0 ;;
    --resume)
        mode=resume
        shift
        if [[ $# -gt 1 ]]; then usage >&2; exit 1; fi
        resume_dir=${1:-}
        ;;
    '') ;;
    *) usage >&2; exit 1 ;;
esac

if [[ $EUID -eq 0 ]]; then
    echo 'Run as your normal user; this script requests sudo when needed.' >&2
    exit 1
fi
detect_target_release || exit 1
prefix=/opt/herdr-guacd
if [[ $mode == install && ( -e $prefix || -L $prefix ) ]]; then
    echo "$prefix already exists; nothing was overwritten." >&2
    if [[ -e $prefix/sbin/guacd ]]; then
        echo 'guacd is already installed there. Move /opt/herdr-guacd away to reinstall.' >&2
    elif check_prefix_target > /dev/null; then
        echo 'If an earlier run installed FreeRDP but failed before guacd, run:' >&2
        echo '  bash install-guacd-h264-ubuntu26.04-v3.sh --resume' >&2
    else
        echo 'It cannot be resumed on this system. Move /opt/herdr-guacd away and rerun.' >&2
    fi
    exit 1
fi
if [[ $mode == resume && ! -d $prefix ]]; then
    echo "No installed FreeRDP at $prefix; --resume cannot continue." >&2
    exit 1
fi
if [[ $mode == resume && -e $prefix/sbin/guacd ]]; then
    echo "$prefix/sbin/guacd already exists; refusing to overwrite it in recovery mode." >&2
    echo 'This recovery is for a failure before guacd was installed.' >&2
    exit 1
fi
if [[ $mode == resume ]]; then
    check_prefix_target || {
        echo "Nothing was modified. Move $prefix away and run a fresh install." >&2
        exit 1
    }
    if ! host_gcc_major=$(/usr/bin/gcc -dumpfullversion 2> /dev/null); then
        echo '/usr/bin/gcc is missing. --resume does not run apt; run a fresh install instead.' >&2
        exit 1
    fi
    host_gcc_major=${host_gcc_major%%.*}
fi
jobs=${BUILD_JOBS:-4}
[[ $jobs =~ ^[1-9][0-9]*$ ]] || { echo 'BUILD_JOBS must be a positive integer.' >&2; exit 1; }

# Keep build-time overrides local to this script. They cannot leak into Pi/krdp.
unset LD_LIBRARY_PATH PKG_CONFIG_PATH PKG_CONFIG_LIBDIR PKG_CONFIG_SYSROOT_DIR
unset CMAKE_PREFIX_PATH CMAKE_TOOLCHAIN_FILE CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH
unset CC CXX CFLAGS CXXFLAGS CPPFLAGS LDFLAGS

if [[ $mode == resume ]]; then
    select_resume_work
    cd "$work"
    printf 'Resuming guacd only. Existing FreeRDP is reused.\nBuild directory: %s\n' "$work"
else
    sudo -v
    sudo apt-get update
    check_package_candidates || exit 1
    sudo apt-get install -y --no-remove --no-install-recommends "${build_packages[@]}"

    # Fail early when an expected development library is unavailable. The FFmpeg
    # development packages are in Ubuntu's universe component; no foreign PPA is used.
    for pc in libavcodec libavutil libswscale openssl xkbcommon icu-uc icu-io icu-i18n; do
        pkg-config --exists "$pc" || { echo "Missing pkg-config module: $pc" >&2; exit 1; }
    done

    mkdir -p "$HOME/.cache/herdr-guacd"
    work=$(mktemp -d "$HOME/.cache/herdr-guacd/build.XXXXXX")
    cd "$work"
    write_build_target_record "$work/$build_target_record"
    printf 'Sources and logs: %s\nInstall prefix: %s\n' "$work" "$prefix"

    fetch() {
        local url=$1 file=$2 hash=$3
        curl --fail --location --retry 3 --proto "=https" --tlsv1.2 --output "$file" "$url"
        printf '%s  %s\n' "$hash" "$file" | sha256sum --check -
    }
    fetch 'https://github.com/FreeRDP/FreeRDP/releases/download/3.32.2/freerdp-3.32.2.tar.gz' \
        freerdp.tar.gz e95a505c0057e4d06a3b120477c421028769deba4db9c639ef3465d050f0955c
    fetch "$guacamole_url" guacamole.tar.gz "$guacamole_sha256"
    mkdir freerdp guacamole
    tar -xzf freerdp.tar.gz --strip-components=1 -C freerdp
    tar -xzf guacamole.tar.gz --strip-components=1 -C guacamole

    # Build libraries and channels, not a new desktop RDP client/server. Software
    # FFmpeg decoding avoids dependence on a particular GPU, driver or OpenH264 ABI.
    # WITH_GFX_H264 is derived from WITH_VIDEO_FFMPEG; rdpgfx needs it for AVC420.
    # FreeRDP 3 always links client channels into its libraries (no BUILTIN_CHANNELS).
    cmake -S freerdp -B freerdp-build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER=/usr/bin/gcc -DCMAKE_CXX_COMPILER=/usr/bin/g++ \
        -DCMAKE_INSTALL_PREFIX="$prefix" \
        -DCMAKE_INSTALL_LIBDIR=lib \
        -DCMAKE_INSTALL_RPATH="$prefix/lib" \
        -DCMAKE_INSTALL_RPATH_USE_LINK_PATH=ON \
        -DBUILD_SHARED_LIBS=ON -DBUILD_TESTING=OFF \
        -DWITH_FFMPEG=ON -DWITH_VIDEO_FFMPEG=ON -DWITH_DSP_FFMPEG=OFF \
        -DWITH_FFMPEG_HWACCEL=OFF -DWITH_OPENH264=OFF -DWITH_SWSCALE=ON \
        -DWITH_CLIENT_COMMON=ON -DWITH_CLIENT=OFF -DWITH_CLIENT_SDL=OFF \
        -DWITH_CHANNELS=ON \
        -DWITH_SERVER=OFF -DWITH_SAMPLE=OFF \
        -DWITH_X11=OFF -DWITH_WAYLAND=OFF \
        -DWITH_ALSA=OFF -DWITH_PULSE=OFF -DWITH_CUPS=OFF -DWITH_PCSC=OFF \
        -DWITH_KRB5=OFF -DWITH_AAD=OFF -DWITH_WINPR_JSON=OFF \
        -DCHANNEL_URBDRC=OFF -DWITH_FUSE=OFF -DWITH_MANPAGES=OFF \
        -DWITH_FREERDP_DEPRECATED=ON -DWITHOUT_FREERDP_3x_DEPRECATED=OFF \
        2>&1 | tee freerdp-configure.log
    cmake --build freerdp-build --parallel "$jobs" 2>&1 | tee freerdp-build.log
    # Record the target first: every prefix this revision creates carries it.
    sudo install -D -m 0644 -- "$work/$build_target_record" "$prefix/$prefix_target_record"
    sudo cmake --install freerdp-build 2>&1 | tee freerdp-install.log

fi

export LD_LIBRARY_PATH="$prefix/lib"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
verify_private_freerdp
# FreeRDP built for another release fails here (e.g. a missing FFmpeg soname or
# glibc symbol version), before any guacd source is touched.
if ! env -u LD_LIBRARY_PATH ldd "$prefix/lib/libfreerdp3.so" > "$work/freerdp-libraries.log" 2>&1 \
    || grep -q 'not found' "$work/freerdp-libraries.log"; then
    grep 'not found' "$work/freerdp-libraries.log" >&2 || cat "$work/freerdp-libraries.log" >&2
    echo "The private FreeRDP in $prefix cannot load on $build_target. Nothing was installed." >&2
    exit 1
fi
probe_h264_decoder "$prefix/lib/libfreerdp3.so"

apply_guacamole_source_fixes
build_guacamole

cd "$work/guacamole"
sudo -v
sudo make "${guac_make_flags[@]}" install 2>&1 | tee "$work/guacamole-install.log"
"$prefix/sbin/guacd" -v
# Test runtime resolution without the build-only LD_LIBRARY_PATH override.
env -u LD_LIBRARY_PATH ldd "$prefix/lib/libguac-client-rdp.so" > "$work/guacamole-libraries.log"
if grep -q 'not found' "$work/guacamole-libraries.log"; then
    cat "$work/guacamole-libraries.log" >&2
    exit 1
fi
for lib in libfreerdp3.so.3 libfreerdp-client3.so.3 libwinpr3.so.3; do
    selected=$(awk -v lib="$lib" '$1 == lib && $2 == "=>" { print $3 }' "$work/guacamole-libraries.log")
    if [[ $selected != /* || ! -f $prefix/lib/$lib ]]; then
        cat "$work/guacamole-libraries.log" >&2
        echo "Missing expected runtime library: $lib" >&2
        exit 1
    fi
    if [[ $(realpath -e -- "$selected") != "$(realpath -e -- "$prefix/lib/$lib")" ]]; then
        cat "$work/guacamole-libraries.log" >&2
        echo "The RDP plugin did not resolve the private library: $lib" >&2
        exit 1
    fi
done
env -u LD_LIBRARY_PATH "$prefix/sbin/guacd" -v
printf '\nInstalled for %s. No service was started.\n' "$build_target"
printf 'Start as a normal user:\n%s/sbin/guacd -f -b 127.0.0.1 -l 4822 -L info\n' "$prefix"
printf 'Sources and logs remain in: %s\n' "$work"
printf 'H.264 is decoded inside guacd; browsers receive image updates, not H.264.\n'
printf 'Keep disable-gfx unset. Verify with KRDP debug logs (QT_LOGGING_RULES=krdp.debug=true).\n'
printf 'Guacamole 1.6.0 treats FreeRDP 3.x support as experimental. Test real KRDP output.\n'
printf 'This private source install is NOT updated by apt; maintain it separately.\n'
