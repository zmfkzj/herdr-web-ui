### Fixed

- `/gui view <WORKER>` now opens the private desktop in the browser however the command was
  entered there: recalled with ↑ from Pi's history, finished with Tab or an arrow from Pi's
  completion list, edited with arrows, or sent from the chat box after Pi finished a turn (held,
  then **Send now** or sent on its turn). Before, only a line typed key by key and submitted at
  once opened it, and every other way ran the command in Pi but opened nothing, with no message.
  After an Enter from a browser reaches an original Pi pane, the server watches that Pi's
  `gui.log` for up to 10 s for the line pi-gui writes for each `/gui view` it answers; that
  desktop then opens in that browser only, with the same one-time grant as a typed command.
