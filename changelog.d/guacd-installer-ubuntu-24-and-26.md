### Changed

- The retained guacd installer `install-guacd-h264-ubuntu26.04-v3.sh` (Revision 5, filename kept)
  now builds the same private FreeRDP 3.32.2 / guacd 1.6.0 H.264 stack on Ubuntu 24.04 LTS as well
  as 26.04 LTS, and refuses other releases and derivatives with a clear message. `--resume` only
  reuses a build directory and `/opt/herdr-guacd` recorded for the same release and architecture;
  unrecorded ones from the 26.04-only revision stay usable on 26.04 after the existing checks.

### Fixed

- The guacd installer installs `libicu-dev` and stops before apt changes anything when a dependency
  has no candidate (universe disabled): a fresh Ubuntu system no longer fails in FreeRDP's CMake
  step.
