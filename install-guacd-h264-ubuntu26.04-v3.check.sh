#!/usr/bin/env bash
# Non-destructive checks for install-guacd-h264-ubuntu26.04-v3.sh.
# Never runs sudo, apt, make install, or guacd as a service; never writes to
# /opt or to cached builds (they are copied into a temporary directory).
#
# Usage: bash install-guacd-h264-ubuntu26.04-v3.check.sh [--build]
#   --build  also configure and compile guacd (with -Werror) in a temporary
#            directory against an already installed private FreeRDP in
#            /opt/herdr-guacd. Nothing is installed.
# GUACAMOLE_TARBALL=path selects the guacamole-server-1.6.0 tarball; otherwise a
# cached ~/.cache/herdr-guacd/build.*/guacamole.tar.gz or a download is used.
# Set TMPDIR to choose where the temporary directory is created.
set -Eeuo pipefail
export LC_ALL=C
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
installer=$here/install-guacd-h264-ubuntu26.04-v3.sh
build=no
case ${1:-} in
    --build) build=yes ;;
    '') ;;
    *) sed -n '5,12p' "${BASH_SOURCE[0]}" >&2; exit 2 ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/guacd-check.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
failures=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
skip() { printf 'SKIP %s\n' "$1"; }

# 1. Syntax and argument handling (exits before any root, OS, or sudo step).
bash -n "$installer" && pass 'bash -n' || fail 'bash -n'
if command -v shellcheck > /dev/null; then
    shellcheck -S warning "$installer" && pass shellcheck || fail shellcheck
else
    skip 'shellcheck (not installed)'
fi
bash "$installer" --help > /dev/null && pass '--help exits 0' || fail '--help'
if bash "$installer" --bogus > /dev/null 2>&1; then fail 'unknown option rejected'; else pass 'unknown option rejected'; fi
if bash "$installer" --resume a b > /dev/null 2>&1; then fail '--resume with two dirs rejected'; else pass '--resume with two dirs rejected'; fi

# Load only the function block; the installer's main flow is never executed.
eval "$(sed -n '/^# BEGIN testable functions/,/^# END testable functions$/p' "$installer")"
declare -F apply_guacamole_source_fixes build_guacamole probe_h264_decoder \
    guard_generated_config_h select_resume_work verify_private_freerdp > /dev/null \
    && pass 'function block loads' || { fail 'function block loads'; exit 1; }

# 2. Resume-directory selection with fixtures.
fake_home=$tmp/home
prefix=/opt/herdr-guacd
make_cached_build() {
    local dir=$fake_home/.cache/herdr-guacd/$1
    mkdir -p "$dir/freerdp" "$dir/freerdp-build" "$dir/guacamole/src/protocols/rdp"
    : > "$dir/guacamole/configure"; : > "$dir/guacamole/src/protocols/rdp/settings.c"
    printf 'CMAKE_INSTALL_PREFIX:PATH=%s\nCMAKE_HOME_DIRECTORY:INTERNAL=%s\n' "$prefix" "$dir/freerdp" \
        > "$dir/freerdp-build/CMakeCache.txt"
}
resume_count() { (HOME=$fake_home resume_dir=; select_resume_work) 2>&1 | head -1; }
mkdir -p "$fake_home"
[[ $(resume_count) == 'Expected one cached build, found 0. Nothing was modified.' ]] \
    && pass 'resume: no cached build rejected' || fail 'resume: no cached build rejected'
make_cached_build build.one; make_cached_build build.two
[[ $(resume_count) == 'Expected one cached build, found 2. Nothing was modified.' ]] \
    && pass 'resume: ambiguous cached builds rejected' || fail 'resume: ambiguous cached builds rejected'

# 3. pkg-config validation with an isolated fixture prefix.
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

# 4. config.h guard: reproduces the glibc 2.43 _XOPEN_SOURCE redefinition.
mkdir -p "$tmp/guard"
printf '#define PACKAGE_VERSION "1.6.0"\n#define _GNU_SOURCE 1\n#define _XOPEN_SOURCE 700\n' > "$tmp/guard/config.h"
printf '#include "config.h"\n#include <unistd.h>\n#include "config.h"\nint main(void) { return 0; }\n' > "$tmp/guard/t.c"
if command -v gcc > /dev/null; then
    if gcc -Werror -Wall -std=gnu11 -c "$tmp/guard/t.c" -o "$tmp/guard/t.o" 2> /dev/null; then
        skip 'guard: unguarded config.h compiles here (glibc does not raise _XOPEN_SOURCE)'
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

# 5. Source fixes against the verified 1.6.0 release (pristine, then again).
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
        && ! grep -q 'inet_pton(wol_dest.sin_family' "$1/src/libguac/wol.c"
}
work=$tmp/pristine
fresh_source "$work"
if (apply_guacamole_source_fixes > "$tmp/fix1.log" 2>&1) \
    && (apply_guacamole_source_fixes > "$tmp/fix2.log" 2>&1) \
    && check_fixed_source "$work/guacamole" \
    && grep -q 'already applied: GUACAMOLE-2070' "$tmp/fix2.log" \
    && grep -q 'Existing AVC420 source change retained' "$tmp/fix2.log" \
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

# A copy of a cached revision-3 build (AVC420 edit, guarded config.h, objects).
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
    skip 'source fixes on a cached revision-3 build (none found)'
fi

# 6. Real AVC420 frame decode through the installed private FreeRDP (read-only).
if [[ -f /opt/herdr-guacd/lib/libfreerdp3.so ]]; then
    probe_h264_decoder /opt/herdr-guacd/lib/libfreerdp3.so && pass 'H.264 frame decode (private FreeRDP)' \
        || fail 'H.264 frame decode (private FreeRDP)'
else
    skip 'H.264 frame decode (no /opt/herdr-guacd/lib/libfreerdp3.so)'
fi

# 7. Optional full guacd compile with -Werror, exactly as the installer does.
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
