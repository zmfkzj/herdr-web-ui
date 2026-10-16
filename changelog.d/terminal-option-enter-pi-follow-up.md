### Fixed
- Option+Enter (Alt+Enter) in the live terminal reaches pi as its own Alt+Enter, so it queues a
  follow-up while pi answers and submits the line while pi is idle, instead of adding a new line.
  The terminal sends it as herdr's key, which herdr encodes in the program's keyboard protocol, on
  this PC and on remote PCs alike; a program that asked for modifyOtherKeys (Claude Code) still
  gets the ESC CR it reads as Alt+Enter.
