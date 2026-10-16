#!/usr/bin/env python3
"""Probe the exact private FreeRDP library; this is not a full RDP/video test."""
import ctypes
from pathlib import Path
import sys

try:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else '/opt/herdr-guacd/lib/libfreerdp3.so')
    if not path.is_file():
        raise RuntimeError(f'Library not found: {path}')
    lib = ctypes.CDLL(str(path.resolve()))
    lib.freerdp_get_build_config.argtypes = []
    lib.freerdp_get_build_config.restype = ctypes.c_char_p
    config = (lib.freerdp_get_build_config() or b'').decode('utf-8', 'replace')
    print('Library:', path.resolve())
    for item in config.split():
        if any(key in item for key in ('WITH_FFMPEG', 'WITH_VIDEO_FFMPEG', 'WITH_OPENH264', 'WITH_GFX_H264')):
            print(item)
    lib.h264_context_new.argtypes = [ctypes.c_int]
    lib.h264_context_new.restype = ctypes.c_void_p
    lib.h264_context_free.argtypes = [ctypes.c_void_p]
    lib.h264_context_free.restype = None
    ctx = lib.h264_context_new(0)
    if not ctx:
        raise RuntimeError('H.264 decoder initialization failed.')
    lib.h264_context_free(ctx)
    print('H.264 decoder initialization: OK')
    print('This does not verify an actual RDP connection or decoded video frames.')
except (OSError, AttributeError, RuntimeError) as exc:
    print('ERROR:', exc, file=sys.stderr)
    sys.exit(1)

