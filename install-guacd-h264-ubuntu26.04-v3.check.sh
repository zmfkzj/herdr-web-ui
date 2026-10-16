#!/usr/bin/env bash
# Non-destructive checks for install-guacd-h264-ubuntu26.04-v3.sh (Ubuntu 24.04
# and 26.04). Never runs sudo, apt-get, make install, or guacd as a service;
# never writes to /opt or to cached builds (they are copied into a temporary
# directory). Release detection, apt candidates and build-target records are
# checked with fixtures, so these checks also run on other systems.
#
# Usage: bash install-guacd-h264-ubuntu26.04-v3.check.sh [--build]
#   --build  also configure and compile guacd (with -Werror) in a temporary
#            directory against an already installed private FreeRDP in
#            /opt/herdr-guacd. Nothing is installed.
# GUACAMOLE_TARBALL=path selects the guacamole-server-1.6.0 tarball; otherwise a
# cached ~/.cache/herdr-guacd/build.*/guacamole.tar.gz or a download is used.
# Set TMPDIR to choose where the temporary directory is created.
# The eval'ed installer functions read and set the globals assigned below.
# shellcheck disable=SC2034,SC2154
set -Eeuo pipefail
export LC_ALL=C
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
installer=$here/install-guacd-h264-ubuntu26.04-v3.sh
build=no
case ${1:-} in
    --build) build=yes ;;
    '') ;;
    *) sed -n '8,14p' "${BASH_SOURCE[0]}" >&2; exit 2 ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/guacd-check.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
failures=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
skip() { printf 'SKIP %s\n' "$1"; }
info() { printf 'INFO %s\n' "$1"; }

# 1. Syntax and argument handling (exits before any root, OS, or sudo step).
bash -n "$installer" && pass 'bash -n' || fail 'bash -n'
if command -v shellcheck > /dev/null; then
    shellcheck -S warning "$installer" && pass shellcheck || fail shellcheck
else
    skip 'shellcheck (not installed)'
fi
bash "$installer" --help > "$tmp/help.txt" && pass '--help exits 0' || fail '--help'
grep -q 'Supported: Ubuntu 24.04 LTS and 26.04 LTS' "$tmp/help.txt" \
    && pass '--help names both supported releases' || fail '--help names both supported releases'
if bash "$installer" --bogus > /dev/null 2>&1; then fail 'unknown option rejected'; else pass 'unknown option rejected'; fi
if bash "$installer" --resume a b > /dev/null 2>&1; then fail '--resume with two dirs rejected'; else pass '--resume with two dirs rejected'; fi

# Load only the function block; the installer's main flow is never executed.
eval "$(sed -n '/^# BEGIN testable functions/,/^# END testable functions$/p' "$installer")"
declare -F apply_guacamole_source_fixes build_guacamole probe_h264_decoder \
    guard_generated_config_h select_resume_work verify_private_freerdp \
    detect_target_release check_package_candidates write_build_target_record \
    read_build_target_record cached_compiler_major check_build_dir_target \
    check_prefix_target > /dev/null \
    && pass 'function block loads' || { fail 'function block loads'; exit 1; }

# 2. Supported-release detection with os-release fixtures (no host state used).
osr=$tmp/os-release
detects() {  # detects EXPECTED_TARGET ARCH os-release-lines...
    local want=$1 arch=$2; shift 2
    printf '%s\n' "$@" > "$osr"
    (detect_target_release "$osr" "$arch" > /dev/null 2>&1 && [[ $build_target == "$want" ]])
}
rejects() {  # rejects EXPECTED_MESSAGE os-release-lines...
    local want=$1; shift
    printf '%s\n' "$@" > "$osr"
    if (detect_target_release "$osr" amd64 > "$tmp/detect.out" 2>&1); then return 1; fi
    grep -qF -- "$want" "$tmp/detect.out"
}
detects ubuntu-24.04-amd64 amd64 ID=ubuntu 'VERSION_ID="24.04"' VERSION_CODENAME=noble \
    'PRETTY_NAME="Ubuntu 24.04.5 LTS"' && pass 'release: Ubuntu 24.04.5 (noble) accepted' \
    || fail 'release: Ubuntu 24.04.5 (noble) accepted'
detects ubuntu-26.04-amd64 amd64 ID=ubuntu 'VERSION_ID="26.04"' VERSION_CODENAME=resolute \
    'PRETTY_NAME="Ubuntu 26.04.1 LTS"' && pass 'release: Ubuntu 26.04.1 (resolute) accepted' \
    || fail 'release: Ubuntu 26.04.1 (resolute) accepted'
detects ubuntu-24.04-arm64 arm64 ID=ubuntu VERSION_ID=24.04 VERSION_CODENAME=noble \
    && pass 'release: the architecture becomes part of the build target' \
    || fail 'release: the architecture becomes part of the build target'
rejects 'Unsupported Ubuntu release: Ubuntu 22.04.5 LTS (VERSION_ID=22.04)' ID=ubuntu \
    VERSION_ID=22.04 VERSION_CODENAME=jammy 'PRETTY_NAME="Ubuntu 22.04.5 LTS"' \
    && pass 'release: Ubuntu 22.04 rejected' || fail 'release: Ubuntu 22.04 rejected'
rejects 'Unsupported Ubuntu release: Ubuntu 25.10 (VERSION_ID=25.10)' ID=ubuntu \
    VERSION_ID=25.10 VERSION_CODENAME=questing 'PRETTY_NAME="Ubuntu 25.10"' \
    && pass 'release: Ubuntu 25.10 rejected' || fail 'release: Ubuntu 25.10 rejected'
rejects 'Ubuntu derivatives and other distributions are not supported' ID=linuxmint \
    'ID_LIKE="ubuntu debian"' VERSION_ID=22.1 VERSION_CODENAME=xia 'UBUNTU_CODENAME=noble' \
    && pass 'release: Ubuntu derivative (ID_LIKE=ubuntu) rejected' \
    || fail 'release: Ubuntu derivative (ID_LIKE=ubuntu) rejected'
rejects 'Unsupported system: Debian GNU/Linux 13 (trixie) (ID=debian)' ID=debian VERSION_ID=13 \
    VERSION_CODENAME=trixie 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"' \
    && pass 'release: other distribution rejected' || fail 'release: other distribution rejected'
rejects '(ID=missing)' VERSION_ID=24.04 VERSION_CODENAME=noble \
    && pass 'release: missing ID rejected' || fail 'release: missing ID rejected'
rejects '(VERSION_ID=missing)' ID=ubuntu VERSION_CODENAME=noble \
    && pass 'release: missing VERSION_ID rejected' || fail 'release: missing VERSION_ID rejected'
rejects 'VERSION_ID=24.04 requires VERSION_CODENAME=noble, found resolute' ID=ubuntu \
    VERSION_ID=24.04 VERSION_CODENAME=resolute \
    && pass 'release: inconsistent codename rejected' || fail 'release: inconsistent codename rejected'
if (detect_target_release "$tmp/no-such-os-release" amd64 > "$tmp/detect.out" 2>&1); then
    fail 'release: unreadable os-release rejected'
else
    grep -q '^Cannot read' "$tmp/detect.out" && pass 'release: unreadable os-release rejected' \
        || fail 'release: unreadable os-release rejected'
fi

# 3. apt candidates, with a stub apt-cache (nothing is resolved or installed).
[[ $(printf '%s\n' "${build_packages[@]}" | sort | uniq -d) == '' ]] \
    && printf '%s\n' "${build_packages[@]}" | grep -qx libicu-dev \
    && pass 'packages: one list without duplicates, including libicu-dev' \
    || fail 'packages: one list without duplicates, including libicu-dev'
mkdir -p "$tmp/bin"
cat > "$tmp/bin/apt-cache" <<'STUB'
#!/bin/sh
[ "$1" = policy ] || exit 1
[ "$2" = "${STUB_UNKNOWN:-}" ] && exit 0
printf '%s:\n  Installed: (none)\n' "$2"
if [ "$2" = "${STUB_NO_CANDIDATE:-}" ]; then echo '  Candidate: (none)'; else echo '  Candidate: 1.0-1'; fi
STUB
chmod +x "$tmp/bin/apt-cache"
candidates() {  # candidates NO_CANDIDATE_PACKAGE UNKNOWN_PACKAGE ('' = none)
    (export PATH=$tmp/bin:$PATH STUB_NO_CANDIDATE=$1 STUB_UNKNOWN=$2
        target_pretty='Ubuntu 24.04.5 LTS' check_package_candidates) > "$tmp/apt.out" 2>&1
}
candidates '' '' && grep -q "All ${#build_packages[@]} build dependencies" "$tmp/apt.out" \
    && pass 'packages: every candidate present accepted' || fail 'packages: every candidate present accepted'
if candidates ninja-build ''; then
    fail 'packages: missing universe candidate rejected'
else
    grep -q 'for: ninja-build$' "$tmp/apt.out" && grep -q 'universe' "$tmp/apt.out" \
        && pass 'packages: missing universe candidate rejected with advice' \
        || fail 'packages: missing universe candidate rejected'
fi
if candidates '' libavcodec-dev; then
    fail 'packages: unknown package rejected'
else
    grep -q 'for: libavcodec-dev$' "$tmp/apt.out" && pass 'packages: unknown package rejected' \
        || fail 'packages: unknown package rejected'
fi

# 4. Build-target records, cached-build compatibility and resume selection.
fake_home=$tmp/home
prefix=/opt/herdr-guacd
make_cached_build() {  # $1 = name, $2 = GCC version ('' = none), $3 = record target ('' = none)
    local dir=$fake_home/.cache/herdr-guacd/$1
    mkdir -p "$dir/freerdp" "$dir/freerdp-build/CMakeFiles/4.2.3" "$dir/guacamole/src/protocols/rdp"
    : > "$dir/guacamole/configure"; : > "$dir/guacamole/src/protocols/rdp/settings.c"
    printf 'CMAKE_INSTALL_PREFIX:PATH=%s\nCMAKE_HOME_DIRECTORY:INTERNAL=%s\n' "$prefix" "$dir/freerdp" \
        > "$dir/freerdp-build/CMakeCache.txt"
    [[ -z ${2:-} ]] || printf 'set(CMAKE_C_COMPILER_VERSION "%s")\n' "$2" \
        > "$dir/freerdp-build/CMakeFiles/4.2.3/CMakeCCompiler.cmake"
    [[ -z ${3:-} ]] || (build_target=$3 target_pretty=fixture write_build_target_record "$dir/$build_target_record")
}
compatible() {  # compatible TARGET GCC_MAJOR BUILD_NAME
    (build_target=$1 host_gcc_major=$2 check_build_dir_target "$fake_home/.cache/herdr-guacd/$3") \
        > "$tmp/compat.out" 2>&1
}
incompatible() {  # incompatible TARGET GCC_MAJOR BUILD_NAME EXPECTED_MESSAGE
    if compatible "$1" "$2" "$3"; then return 1; fi
    grep -qF -- "$4" "$tmp/compat.out"
}
mkdir -p "$fake_home"
make_cached_build rec24 13.3.0 ubuntu-24.04-amd64
[[ $(read_build_target_record "$fake_home/.cache/herdr-guacd/rec24/$build_target_record") == ubuntu-24.04-amd64 ]] \
    && pass 'record: written target is read back' || fail 'record: written target is read back'
printf 'target=ubuntu-24.04-amd64\ntarget=ubuntu-26.04-amd64\n' > "$tmp/bad-record"
if read_build_target_record "$tmp/bad-record" > /dev/null 2>&1; then fail 'record: ambiguous record rejected'
else pass 'record: ambiguous record rejected'; fi
compatible ubuntu-24.04-amd64 13 rec24 && pass 'cache: recorded 24.04 build reused on 24.04' \
    || fail 'cache: recorded 24.04 build reused on 24.04'
incompatible ubuntu-26.04-amd64 15 rec24 'was created for ubuntu-24.04-amd64; this system is ubuntu-26.04-amd64' \
    && pass 'cache: 24.04 build refused on 26.04' || fail 'cache: 24.04 build refused on 26.04'
incompatible ubuntu-24.04-arm64 13 rec24 'this system is ubuntu-24.04-arm64' \
    && pass 'cache: build for another architecture refused' || fail 'cache: build for another architecture refused'
make_cached_build legacy26 15.2.0
compatible ubuntu-26.04-amd64 15 legacy26 && grep -q 'earlier Ubuntu 26.04-only revision' "$tmp/compat.out" \
    && [[ ! -e $fake_home/.cache/herdr-guacd/legacy26/$build_target_record ]] \
    && pass 'cache: unrecorded 26.04-only build reused on 26.04, not re-recorded' \
    || fail 'cache: unrecorded 26.04-only build reused on 26.04, not re-recorded'
incompatible ubuntu-24.04-amd64 13 legacy26 'cannot be reused on ubuntu-24.04-amd64' \
    && pass 'cache: unrecorded 26.04-only build refused on 24.04' \
    || fail 'cache: unrecorded 26.04-only build refused on 24.04'
make_cached_build legacy-gcc13 13.3.0
incompatible ubuntu-26.04-amd64 15 legacy-gcc13 'configured by GCC 13; /usr/bin/gcc is GCC 15' \
    && pass 'cache: build configured by another GCC major refused' \
    || fail 'cache: build configured by another GCC major refused'
make_cached_build no-compiler '' ubuntu-26.04-amd64
incompatible ubuntu-26.04-amd64 15 no-compiler 'Cannot tell which GCC configured' \
    && pass 'cache: build without CMake compiler information refused' \
    || fail 'cache: build without CMake compiler information refused'
compatible ubuntu-26.04-amd64 15 rec24-point 2> /dev/null && fail 'cache: missing directory refused' \
    || pass 'cache: missing directory refused'

pfx_with_record() {  # $1 = record target ('' = none); creates a fixture prefix
    rm -rf -- "${tmp:?}/prefix"; mkdir -p "$tmp/prefix"
    [[ -z $1 ]] || (prefix=$tmp/prefix build_target=$1 target_pretty=fixture; mkdir -p "$prefix/${prefix_target_record%/*}"
        write_build_target_record "$prefix/$prefix_target_record")
}
prefix_ok() { (prefix=$tmp/prefix build_target=$1 check_prefix_target) > "$tmp/prefix.out" 2>&1; }
pfx_with_record ubuntu-24.04-amd64
prefix_ok ubuntu-24.04-amd64 && pass 'prefix: recorded 24.04 prefix accepted on 24.04' \
    || fail 'prefix: recorded 24.04 prefix accepted on 24.04'
prefix_ok ubuntu-26.04-amd64 && fail 'prefix: 24.04 prefix refused on 26.04' \
    || { grep -q 'was built for ubuntu-24.04-amd64' "$tmp/prefix.out" \
        && pass 'prefix: 24.04 prefix refused on 26.04' || fail 'prefix: 24.04 prefix refused on 26.04'; }
pfx_with_record ''
prefix_ok ubuntu-26.04-amd64 && grep -q 'no record (earlier Ubuntu 26.04-only revision)' "$tmp/prefix.out" \
    && pass 'prefix: unrecorded 26.04-only prefix kept for the library checks on 26.04' \
    || fail 'prefix: unrecorded 26.04-only prefix kept for the library checks on 26.04'
prefix_ok ubuntu-24.04-amd64 && fail 'prefix: unrecorded 26.04-only prefix refused on 24.04' \
    || pass 'prefix: unrecorded 26.04-only prefix refused on 24.04'

resume_count() { (HOME=$tmp/resume-home resume_dir='' build_target=ubuntu-26.04-amd64 host_gcc_major=15
    select_resume_work) 2>&1 | grep -m 1 '^Expected one cached build'; }
mkdir -p "$tmp/resume-home"
[[ $(resume_count) == 'Expected one cached build, found 0. Nothing was modified.' ]] \
    && pass 'resume: no cached build rejected' || fail 'resume: no cached build rejected'
fake_home=$tmp/resume-home
make_cached_build build.one 15.2.0; make_cached_build build.two 15.2.0 ubuntu-26.04-amd64
[[ $(resume_count) == 'Expected one cached build, found 2. Nothing was modified.' ]] \
    && pass 'resume: ambiguous cached builds rejected' || fail 'resume: ambiguous cached builds rejected'
rm -rf -- "${fake_home:?}/.cache/herdr-guacd/build.one"; make_cached_build build.old 13.3.0 ubuntu-24.04-amd64
if (HOME=$fake_home resume_dir='' build_target=ubuntu-26.04-amd64 host_gcc_major=15
    select_resume_work > "$tmp/select.out" 2>&1 && [[ $work == "$fake_home/.cache/herdr-guacd/build.two" ]]) \
    && grep -q "Skipping incompatible cached build $fake_home/.cache/herdr-guacd/build.old" "$tmp/select.out"; then
    pass 'resume: incompatible cached build skipped, the compatible one selected'
else
    cat "$tmp/select.out" >&2; fail 'resume: incompatible cached build skipped'
fi
if (HOME=$fake_home resume_dir=$fake_home/.cache/herdr-guacd/build.old build_target=ubuntu-26.04-amd64 \
    host_gcc_major=15 select_resume_work > "$tmp/select.out" 2>&1); then
    fail 'resume: explicit incompatible build directory refused'
else
    grep -q 'cannot be resumed on this system; nothing was modified' "$tmp/select.out" \
        && pass 'resume: explicit incompatible build directory refused' \
        || fail 'resume: explicit incompatible build directory refused'
fi

# 5. pkg-config validation with an isolated fixture prefix.
fixture_pkg() {   # $1 = version written into all three .pc files
    rm -rf "$tmp/pfx"; mkdir -p "$tmp/pfx/lib/pkgconfig"
    local pc
    for pc in freerdp3 freerdp-client3 winpr3; do
        printf 'prefix=%s\nlibdir=${prefix}/lib\nName: %s\nDescription: fixture\nVersion: %s\n' \
            "$tmp/pfx" "$pc" "$1" > "$tmp/pfx/lib/pkgconfig/$pc.pc"
    done
}
fixture_pkg 3.32.2
(prefix=$tmp/pfx PKG_CONFIG_PATH=$tmp/pfx/lib/pkgconfig PKG_CONFIG_LIBDIR=$tmp/pfx/lib/pkgconfig \
    verify_private_freerdp > /dev/null 2>&1) && pass 'pkg-config: private 3.32.2 accepted' \
    || fail 'pkg-config: private 3.32.2 accepted'
fixture_pkg 3.32.1
if (prefix=$tmp/pfx PKG_CONFIG_PATH=$tmp/pfx/lib/pkgconfig PKG_CONFIG_LIBDIR=$tmp/pfx/lib/pkgconfig \
    verify_private_freerdp > /dev/null 2>&1); then fail 'pkg-config: wrong version rejected'
else pass 'pkg-config: wrong version rejected'; fi

# 6. config.h guard: reproduces the glibc 2.43 _XOPEN_SOURCE redefinition.
mkdir -p "$tmp/guard"
printf '#define PACKAGE_VERSION "1.6.0"\n#define _GNU_SOURCE 1\n#define _XOPEN_SOURCE 700\n' > "$tmp/guard/config.h"
printf '#include "config.h"\n#include <unistd.h>\n#include "config.h"\nint main(void) { return 0; }\n' > "$tmp/guard/t.c"
if command -v gcc > /dev/null; then
    if gcc -Werror -Wall -std=gnu11 -c "$tmp/guard/t.c" -o "$tmp/guard/t.o" 2> /dev/null; then
        skip 'guard: unguarded config.h compiles here (glibc does not raise _XOPEN_SOURCE, e.g. 24.04)'
    else
        pass 'guard: unguarded config.h reproduces the redefinition error'
    fi
    (cd "$tmp/guard" && guard_generated_config_h > /dev/null && guard_generated_config_h > /dev/null) \
        && gcc -Werror -Wall -std=gnu11 -c "$tmp/guard/t.c" -o "$tmp/guard/t.o" \
        && pass 'guard: guarded config.h compiles, guard is idempotent' \
        || fail 'guard: guarded config.h compiles, guard is idempotent'
else
    skip 'guard compile test (gcc missing)'
fi

# 7. Source fixes against the verified 1.6.0 release (pristine, then again).
tarball=${GUACAMOLE_TARBALL:-}
if [[ -z $tarball ]]; then
    for candidate in "$HOME"/.cache/herdr-guacd/build.*/guacamole.tar.gz; do
        [[ -f $candidate ]] && { tarball=$candidate; break; }
    done
fi
if [[ -z $tarball ]]; then
    tarball=$tmp/guacamole.tar.gz
    curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
        --output "$tarball" "$guacamole_url" || { fail 'download guacamole-server 1.6.0'; exit 1; }
fi
printf '%s  %s\n' "$guacamole_sha256" "$tarball" | sha256sum --check --quiet - \
    && pass 'guacamole-server 1.6.0 tarball checksum' || { fail 'tarball checksum'; exit 1; }

fresh_source() {  # $1 = new work directory
    mkdir -p "$1/guacamole"
    tar -xzf "$tarball" --strip-components=1 -C "$1/guacamole"
}
check_fixed_source() {  # $1 = guacamole source directory
    grep -q 'freerdp_settings_set_bool(rdp_settings, FreeRDP_GfxH264, TRUE);' "$1/src/protocols/rdp/settings.c" \
        && grep -q 'freerdp_settings_set_bool(rdp_settings, FreeRDP_GfxAVC444, FALSE);' "$1/src/protocols/rdp/settings.c" \
        && [[ $(grep -c 'FreeRDP_GfxH264, TRUE' "$1/src/protocols/rdp/settings.c") == 1 ]] \
        && grep -q '^    const char\* chr;' "$1/src/libguac/string.c" \
        && grep -q 'struct sockaddr_storage wol_dest;' "$1/src/libguac/wol.c" \
        && ! grep -q 'inet_pton(wol_dest.sin_family' "$1/src/libguac/wol.c" \
        && gdi_in_post_connect "$1/src/protocols/rdp/rdp.c"
}
gdi_in_post_connect() {  # GUACAMOLE-2328: gdi_init() once, in PostConnect only
    [[ $(grep -c 'gdi_init(instance' "$1") == 1 ]] \
        && [[ $(grep -c 'rdp_inst->PostConnect = rdp_freerdp_post_connect;' "$1") == 1 ]] \
        && ! sed -n '/^static BOOL rdp_freerdp_pre_connect/,/^}/p' "$1" | grep -q 'gdi_init(instance' \
        && sed -n '/^static BOOL rdp_freerdp_post_connect/,/^}/p' "$1" | grep -q 'gdi_init(instance'
}
work=$tmp/pristine
fresh_source "$work"
if (apply_guacamole_source_fixes > "$tmp/fix1.log" 2>&1) \
    && (apply_guacamole_source_fixes > "$tmp/fix2.log" 2>&1) \
    && check_fixed_source "$work/guacamole" \
    && grep -q 'already applied: GUACAMOLE-2070' "$tmp/fix2.log" \
    && grep -q 'Existing AVC420 source change retained' "$tmp/fix2.log" \
    && grep -q 'Existing GUACAMOLE-2328 PostConnect GDI change retained' "$tmp/fix2.log" \
    && [[ -z $(find "$work/guacamole" -name '*.orig' -o -name '*.rej') ]]; then
    pass 'source fixes: applied once, repeat run is a no-op'
else
    cat "$tmp/fix1.log" "$tmp/fix2.log" >&2 || true
    fail 'source fixes: applied once, repeat run is a no-op'
fi

work=$tmp/conflict
fresh_source "$work"
printf '/* local divergence */\n' > "$work/guacamole/src/libguac/wol.c"
cp "$work/guacamole/src/libguac/string.c" "$tmp/string.before"
if (apply_guacamole_source_fixes > "$tmp/fix3.log" 2>&1); then
    fail 'source fixes: diverged source rejected'
elif grep -q 'does not apply' "$tmp/fix3.log" \
    && [[ $(cat "$work/guacamole/src/libguac/wol.c") == '/* local divergence */' ]]; then
    pass 'source fixes: diverged source rejected without touching it'
else
    cat "$tmp/fix3.log" >&2; fail 'source fixes: diverged source rejected'
fi

# GUACAMOLE-2328: a half-applied rdp.c (marker, GDI still in PreConnect) is refused untouched.
work=$tmp/partial2328
fresh_source "$work"
sed -i 's|^static BOOL rdp_freerdp_pre_connect|/* Local backport of GUACAMOLE-2328 */\n&|' "$work/guacamole/src/protocols/rdp/rdp.c"
cp "$work/guacamole/src/protocols/rdp/rdp.c" "$tmp/rdp.before"
if (apply_guacamole_source_fixes > "$tmp/fix2328.log" 2>&1); then
    fail 'source fixes: partial GUACAMOLE-2328 rejected'
elif grep -q 'Partial or diverged GUACAMOLE-2328' "$tmp/fix2328.log" \
    && cmp -s "$tmp/rdp.before" "$work/guacamole/src/protocols/rdp/rdp.c"; then
    pass 'source fixes: partial GUACAMOLE-2328 rejected without touching rdp.c'
else
    cat "$tmp/fix2328.log" >&2; fail 'source fixes: partial GUACAMOLE-2328 rejected'
fi

# A copy of a cached build (AVC420 edit, guarded config.h, objects).
cached=
for candidate in "$HOME"/.cache/herdr-guacd/build.*; do
    [[ -f $candidate/guacamole/src/protocols/rdp/settings.c ]] && { cached=$candidate; break; }
done
if [[ -n $cached ]]; then
    work=$tmp/resume
    mkdir -p "$work"
    cp -a -- "$cached/guacamole" "$work/guacamole"
    if (apply_guacamole_source_fixes > "$tmp/fix4.log" 2>&1) \
        && (apply_guacamole_source_fixes > "$tmp/fix5.log" 2>&1) \
        && check_fixed_source "$work/guacamole"; then
        pass "source fixes: copy of cached build $cached updated twice"
    else
        cat "$tmp/fix4.log" "$tmp/fix5.log" >&2 || true
        fail 'source fixes: copy of cached build'
    fi
else
    skip 'source fixes on a cached build (none found)'
fi

# 8. This host, read-only: release, apt candidates, cached builds and prefix.
# Reported as INFO: they describe this machine, not the installer.
if detect_target_release > "$tmp/host.out" 2>&1; then
    info "host: $(head -n 1 "$tmp/host.out")"
    if command -v apt-cache > /dev/null && check_package_candidates > "$tmp/host-apt.out" 2>&1; then
        info "host: $(head -n 1 "$tmp/host-apt.out")"
    else
        info "host: $(head -n 1 "$tmp/host-apt.out" 2> /dev/null || echo 'apt-cache missing') (enable universe before installing)"
    fi
    host_gcc_major=$(/usr/bin/gcc -dumpfullversion 2> /dev/null) && host_gcc_major=${host_gcc_major%%.*} || host_gcc_major=
    for candidate in "$HOME"/.cache/herdr-guacd/build.*; do
        [[ -f $candidate/freerdp-build/CMakeCache.txt ]] || continue
        if check_build_dir_target "$candidate" > "$tmp/host-cache.out" 2>&1; then
            info "cached build $candidate: target matches this system ($(sed 's/^Build directory target: OK (//; s/)\.$//' "$tmp/host-cache.out"))"
        else
            info "cached build $candidate: --resume would refuse it: $(tr '\n' ' ' < "$tmp/host-cache.out")"
        fi
    done
    if [[ -d /opt/herdr-guacd ]]; then
        if (prefix=/opt/herdr-guacd check_prefix_target) > "$tmp/host-prefix.out" 2>&1; then
            info "/opt/herdr-guacd: $(head -n 1 "$tmp/host-prefix.out")"
        else
            info "/opt/herdr-guacd: NOT for this system: $(tr '\n' ' ' < "$tmp/host-prefix.out")"
        fi
    fi
else
    info "host: not a supported installer target: $(head -n 1 "$tmp/host.out")"
fi

# 9. Real AVC420 frame decode through the installed private FreeRDP (read-only).
if [[ -f /opt/herdr-guacd/lib/libfreerdp3.so ]]; then
    probe_h264_decoder /opt/herdr-guacd/lib/libfreerdp3.so && pass 'H.264 frame decode (private FreeRDP)' \
        || fail 'H.264 frame decode (private FreeRDP)'
else
    skip 'H.264 frame decode (no /opt/herdr-guacd/lib/libfreerdp3.so)'
fi

# 10. Optional full guacd compile with -Werror, exactly as the installer does.
if [[ $build == yes ]]; then
    if [[ ! -f /opt/herdr-guacd/lib/pkgconfig/freerdp3.pc ]]; then
        fail 'build: private FreeRDP missing in /opt/herdr-guacd'
    else
        jobs=$(nproc)
        build_dirs=("$tmp/pristine")
        [[ -z $cached ]] || build_dirs+=("$tmp/resume")
        for work in "${build_dirs[@]}"; do
        if (
            prefix=/opt/herdr-guacd
            export LD_LIBRARY_PATH=$prefix/lib PKG_CONFIG_PATH=$prefix/lib/pkgconfig
            unset PKG_CONFIG_LIBDIR CFLAGS CPPFLAGS LDFLAGS
            verify_private_freerdp > /dev/null && build_guacamole > "$tmp/build-output.log" 2>&1
        ); then
            out=$(env -u LD_LIBRARY_PATH "$work/guacamole/src/guacd/guacd" -v 2>&1)
            if [[ $out == *'version 1.6.0'* ]] \
                && grep -E -- ' -Werror .*-include .*/config.h' "$work/guacamole-build.log" > /dev/null \
                && env -u LD_LIBRARY_PATH ldd "$work/guacamole/src/protocols/rdp/.libs/libguac-client-rdp.so" \
                    | grep 'libfreerdp3.so.3 => /opt/herdr-guacd/lib/' > /dev/null; then
                pass "build: guacd compiled with -Werror in $work ($out)"
            else
                fail "build: compiled guacd in $work does not run or resolve private FreeRDP"
            fi
        else
            tail -40 "$tmp/build-output.log" >&2
            fail "build: guacd compile in $work"
        fi
        done
    fi
else
    skip 'full guacd compile (use --build)'
fi

if [[ $failures -ne 0 ]]; then
    printf '%s check(s) failed.\n' "$failures" >&2
    exit 1
fi
printf 'All checks passed. No RDP session or H.264 negotiation was tested.\n'
