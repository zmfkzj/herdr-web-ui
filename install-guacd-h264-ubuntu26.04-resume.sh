#!/usr/bin/env bash
# Build a private guacd 1.6.0 / FreeRDP 3.32.2 stack for original Pi's pi-gui.
# Guacamole 1.6.0 labels FreeRDP 3.x support experimental. Smoke-test the actual
# KRDP desktop before relying on it. This is not a tested binary distribution.
# Private FreeRDP/guacd libraries are installed only under /opt/herdr-guacd.
# apt may install/update distribution dependencies; Herdr/Pi files, services,
# firewall rules, and system dynamic-loader configuration are not changed.
# Target: Ubuntu 26.04 (resolute). Not end-to-end tested on Ubuntu 26.04.
# Revision 2: canonical pkg-config paths, actual .pc location checks, and resume support.
# Build prerequisites are installed through apt. Sources and logs remain local.
# Official references:
# https://guacamole.apache.org/doc/1.6.0/gug/guacamole-native.html
# https://github.com/FreeRDP/FreeRDP/releases/tag/3.32.2
# https://github.com/FreeRDP/FreeRDP/blob/3.32.2/cmake/ConfigOptions.cmake
set -Eeuo pipefail
export LC_ALL=C
umask 022
trap 'printf "Build failed at line %s. Build directory: %s\n" "$LINENO" "${work:-not created}" >&2' ERR

usage() {
    printf '%s\n' \
        'Usage: bash install-guacd-h264-ubuntu26.04-v2.sh [--resume [BUILD_DIRECTORY]]' \
        'No arguments: install a new private FreeRDP / guacd stack.' \
        '--resume: reuse installed FreeRDP and finish guacd; no apt or FreeRDP rebuild.' \
        'An omitted BUILD_DIRECTORY is allowed only if exactly one matching cached build exists.' \
        'BUILD_JOBS controls guacd compilation parallelism (default: 4).' \
        'Nothing is deleted. No Herdr/Pi files, services, or firewall rules are changed.'
}
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
source /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 26.04 ]]; then
    echo 'This script targets native Ubuntu 26.04 only.' >&2
    exit 1
fi
prefix=/opt/herdr-guacd
if [[ $mode == install && ( -e $prefix || -L $prefix ) ]]; then
    echo "$prefix already exists; nothing was overwritten." >&2
    echo 'After the pkg-config error, use this script with --resume.' >&2
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
jobs=${BUILD_JOBS:-4}
[[ $jobs =~ ^[1-9][0-9]*$ ]] || { echo 'BUILD_JOBS must be a positive integer.' >&2; exit 1; }

# Keep build-time overrides local to this script. They cannot leak into Pi/krdp.
unset LD_LIBRARY_PATH PKG_CONFIG_PATH PKG_CONFIG_LIBDIR PKG_CONFIG_SYSROOT_DIR
unset CMAKE_PREFIX_PATH CMAKE_TOOLCHAIN_FILE CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH
unset CC CXX CFLAGS CXXFLAGS CPPFLAGS LDFLAGS

# BEGIN pkg-config validation (also exercised with isolated .pc fixtures)
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
# END pkg-config validation

# BEGIN resume directory selection
select_resume_work() {
    local candidate selected actual_source saved_source saved_prefix
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
    work=$selected
}
# END resume directory selection

if [[ $mode == resume ]]; then
    select_resume_work
    cd "$work"
    printf 'Resuming guacd only. Existing FreeRDP is reused.\nBuild directory: %s\n' "$work"
else
    sudo -v
    sudo apt-get update
    sudo apt-get install -y --no-remove --no-install-recommends \
        build-essential cmake ninja-build pkg-config libtool-bin curl ca-certificates python3 \
        libcairo2-dev libjpeg-turbo8-dev libpng-dev uuid-dev libssl-dev zlib1g-dev \
        libwebp-dev libavcodec-dev libavutil-dev libswscale-dev libswresample-dev \
        libavformat-dev libxkbcommon-dev

    # Fail early when an expected development library is unavailable. The FFmpeg
    # development packages are in Ubuntu's universe component; no foreign PPA is used.
    for pc in libavcodec libavutil libswscale openssl xkbcommon; do
        pkg-config --exists "$pc" || { echo "Missing pkg-config module: $pc" >&2; exit 1; }
    done

    mkdir -p "$HOME/.cache/herdr-guacd"
    work=$(mktemp -d "$HOME/.cache/herdr-guacd/build.XXXXXX")
    cd "$work"
    printf 'Sources and logs: %s\nInstall prefix: %s\n' "$work" "$prefix"

    fetch() {
        local url=$1 file=$2 hash=$3
        curl --fail --location --retry 3 --proto "=https" --tlsv1.2 --output "$file" "$url"
        printf '%s  %s\n' "$hash" "$file" | sha256sum --check -
    }
    fetch 'https://github.com/FreeRDP/FreeRDP/releases/download/3.32.2/freerdp-3.32.2.tar.gz' \
        freerdp.tar.gz e95a505c0057e4d06a3b120477c421028769deba4db9c639ef3465d050f0955c
    fetch 'https://downloads.apache.org/guacamole/1.6.0/source/guacamole-server-1.6.0.tar.gz' \
        guacamole.tar.gz 8bc45675da96d7b6f39728160181e3d4ff3c08f460f6d26de5805b642bf13f2b
    mkdir freerdp guacamole
    tar -xzf freerdp.tar.gz --strip-components=1 -C freerdp
    tar -xzf guacamole.tar.gz --strip-components=1 -C guacamole

    # Build libraries and channels, not a new desktop RDP client/server. Software
    # FFmpeg decoding avoids dependence on a particular GPU, driver or OpenH264 ABI.
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
        -DWITH_CHANNELS=ON -DBUILTIN_CHANNELS=OFF \
        -DWITH_SERVER=OFF -DWITH_SAMPLE=OFF \
        -DWITH_X11=OFF -DWITH_WAYLAND=OFF \
        -DWITH_ALSA=OFF -DWITH_PULSE=OFF -DWITH_CUPS=OFF -DWITH_PCSC=OFF \
        -DWITH_KRB5=OFF -DWITH_AAD=OFF -DWITH_WINPR_JSON=OFF \
        -DCHANNEL_URBDRC=OFF -DWITH_FUSE=OFF -DWITH_MANPAGES=OFF \
        -DWITH_FREERDP_DEPRECATED=ON -DWITHOUT_FREERDP_3x_DEPRECATED=OFF \
        2>&1 | tee freerdp-configure.log
    cmake --build freerdp-build --parallel "$jobs" 2>&1 | tee freerdp-build.log
    sudo cmake --install freerdp-build 2>&1 | tee freerdp-install.log

fi

export LD_LIBRARY_PATH="$prefix/lib"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
verify_private_freerdp

# Initialize a decoder from the exact private library. This does NOT claim to
# have decoded a frame or tested a real KRDP connection.
python3 - "$prefix/lib/libfreerdp3.so" <<'PY'
import ctypes, sys
lib = ctypes.CDLL(sys.argv[1])
lib.freerdp_get_build_config.argtypes = []
lib.freerdp_get_build_config.restype = ctypes.c_char_p
config = (lib.freerdp_get_build_config() or b'').decode('utf-8', 'replace')
for key in ('WITH_VIDEO_FFMPEG=ON', 'WITH_GFX_H264=ON'):
    if key not in config.split():
        raise SystemExit('Missing required codec build setting: ' + key)
lib.h264_context_new.argtypes = [ctypes.c_int]
lib.h264_context_new.restype = ctypes.c_void_p
lib.h264_context_free.argtypes = [ctypes.c_void_p]
lib.h264_context_free.restype = None
ctx = lib.h264_context_new(0)
if not ctx:
    raise SystemExit('FreeRDP H.264 decoder initialization failed.')
lib.h264_context_free(ctx)
print('Private FreeRDP FFmpeg/H.264 decoder initialization: OK')
PY

# Upstream guacd enables GFX without explicitly requesting H.264. Select AVC420
# in this dedicated build. This is a normal source change, not a runtime patch.
python3 - <<'PY'
from pathlib import Path
p = Path('guacamole/src/protocols/rdp/settings.c')
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
PY

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

cd guacamole
PKG_CONFIG="$work/pkg-config-freerdp3" \
    LDFLAGS="-L$prefix/lib -Wl,-rpath,$prefix/lib" \
    CFLAGS="-O2 -std=gnu11 -Wno-error=deprecated-declarations" \
    CPPFLAGS="-Wno-error=deprecated-declarations" \
    ./configure --prefix="$prefix" --libdir="$prefix/lib" --with-rdp \
    --with-freerdp-plugin-dir="$prefix/lib/freerdp3" \
    --with-guacd-conf="$prefix/etc/guacd.conf" \
    --without-vnc --without-ssh --without-telnet --disable-kubernetes \
    --without-terminal --disable-guacenc --disable-guaclog \
    2>&1 | tee "$work/guacamole-configure.log"
# FreeRDP's version is printed on the library row, not on the RDP protocol row.
if ! grep -Eq '^[[:space:]]*freerdp[[:space:].]+yes[[:space:]]+\(3\.x\)' "$work/guacamole-configure.log" \
    || ! grep -Eq '^[[:space:]]*RDP[[:space:].]+yes[[:space:]]*$' "$work/guacamole-configure.log"; then
    echo 'Guacamole did not select FreeRDP 3; refusing installation.' >&2
    exit 1
fi
# FreeRDP 3 requires the settings accessor path that received the AVC420 edit.
if ! grep -Eq '^#define[[:space:]]+HAVE_SETTERS_GETTERS([[:space:]]|$)' config.h; then
    echo 'FreeRDP settings accessors were not detected; inspect config.log.' >&2
    exit 1
fi
make -j"$jobs" 2>&1 | tee "$work/guacamole-build.log"
sudo -v
sudo make install 2>&1 | tee "$work/guacamole-install.log"
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
printf '\nInstalled. No service was started.\n'
printf 'Start as a normal user:\n%s/sbin/guacd -f -b 127.0.0.1 -l 4822 -L info\n' "$prefix"
printf 'Sources and logs remain in: %s\n' "$work"
printf 'Guacamole 1.6.0 treats FreeRDP 3.x support as experimental. Test real KRDP output.\n'
printf 'This private source install is NOT updated by apt; maintain it separately.\n'

