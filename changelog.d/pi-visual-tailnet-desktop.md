### Fixed

- `/gui view <WORKER>` now opens the private desktop in a browser that reaches this server straight
  over Tailscale at plain `http://` (`HOST` set to this PC's tailnet address or MagicDNS name), as
  `scripts/pi-visual-stack.sh` users do. Before, the desktop was refused with "Use HTTPS or
  localhost for private desktops" although WireGuard already encrypts that link. LAN, wildcard
  and proxied plain-HTTP requests are still refused, and the one-time `/gui view` grant is still
  required; SSH passwords keep their HTTPS-or-localhost rule.
- Private desktops now draw in the browser instead of staying on "Connecting…". guacd 1.6.0
  initialized FreeRDP's GDI before FreeRDP 3.31+ creates its cache, so every RDP connection
  aborted on `WINPR_ASSERT(cache->brush)`. The guacd installer (revision 6) applies upstream's
  GUACAMOLE-2328 fix (GDI in PostConnect) and gains `--rebuild-guacd` to replace an installed
  guacd: run `bash install-guacd-h264-ubuntu26.04-v3.sh --rebuild-guacd`, then
  `scripts/pi-visual-stack.sh restart`.
