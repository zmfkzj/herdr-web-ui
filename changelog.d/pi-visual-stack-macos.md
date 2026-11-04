### Fixed
- `scripts/pi-visual-stack.sh` runs on macOS. It stopped there with "missing commands: setsid flock
  ss" because it relied on Linux tools and `/proc`; on macOS it now starts each process in a session
  of its own with perl, locks with flock(2) through perl, tracks the process group of each launched
  process by pid, start time and boot, and finds listeners with lsof and netstat, all of which ship
  with macOS. Linux keeps the same commands as before. A missing guacd on macOS is named with what
  to do there (build guacd 1.6+ with H.264 and set `HERDR_STACK_GUACD_BIN`) instead of the Ubuntu
  installer.
