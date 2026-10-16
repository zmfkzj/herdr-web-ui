### Added

- `/gui view <WORKER>` run in an original Pi pane, typed straight into its terminal or sent from a
  message box, opens that worker's private desktop in this browser at once, on the pane's own PC,
  without retyping the password; unknown, ambiguous or possibly completed names fail clearly.
- Pi visual tools work for remote PCs through their SSH bridge: worker reads, image reviews and
  private desktops relay through this server, while remote guacd and krdp stay on loopback.
- **Turn on desktop viewing for this PC** enables remote desktops one PC at a time: the bridge
  restarts with it, and the choice is kept for that PC until turned off or the PC is removed.
- **Install Pi visual bridge** replaces a remote PC's bridge with a locally built bundle carrying
  the `pi-visual` feature when the current bridge (upstream or older) lacks it.
