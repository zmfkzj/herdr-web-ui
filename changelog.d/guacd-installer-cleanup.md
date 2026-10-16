### Removed

- Superseded Ubuntu 26.04 guacd installers: keep only `install-guacd-h264-ubuntu26.04-v3.sh`
  (the latest revision, including recovery mode) and its non-installing `.check.sh` validation
  companion.

### Maintenance

- Add an isolated inline-terminal-image diagnostic: herdr 0.9.5's native client receives Kitty
  graphics, but its attach/mirror streams omit image payloads. Document this unresolved upstream
  blocker separately from chat images and the RDP viewer; no terminal-image fix is claimed.
