### Fixed

- `/gui view <WORKER>` opens the private desktop without its one-time password on a browser's
  first visit too. The terminal connection that gives a new browser its stream cookie recorded
  the command for that browser as it was before the cookie, so the desktop it asked for next did
  not match and the password form came up instead, until the page was reloaded.
