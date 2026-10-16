### Added
- Pi's inline tool-result images (a `read` picture, `generate_image`, any tool image) now appear
  inside the browser terminal at the cells pi drew them, on this PC and on remote PCs, when pi runs
  the pi images extension's terminal references. herdr still drops the Kitty pixels; the extension
  marks each image row with a linked blank cell, and the browser fetches the picture from the
  pane's own pi session (checked by session id and digest). See docs/terminal-images.md.
