# Inline images in the terminal

This concerns images inside **Terminal**, not chat attachments, image review or `/gui view` RDP.

## What works

Pictures that pi draws inline in its TUI — the images of **tool results** (`read` of an image,
`generate_image`, MCP or any tool that returns an image block) — also appear inline in the browser
terminal, at the same cells, on this PC and on remote PCs. This needs the pi images extension's
terminal references (below); without them the terminal behaves as before.

Not covered: images of other programs (any Kitty/SIXEL/iTerm2 output that is not pi's), pi's
pasted-image preview and the images extension's `pasted-images` entries (they are files, not part
of the session), images of nested tool calls, and other agents (omp, Claude, Codex...).

## Why it needs a marker

herdr 0.9.5 does not forward graphics. `herdr terminal attach` re-renders the pane as cells, cursor
and OSC 8 hyperlinks ([`render.rs`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/server/headless/render.rs#L760-L811),
[`render_ansi.rs`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/protocol/render_ansi.rs)); Kitty
uploads and placements reach only herdr's own client (reproduced: `scripts/terminal-image-diagnostic.ts`
still exits 2), and xterm.js 5.5 has no Kitty renderer. Switching pi to iTerm2 or SIXEL does not help
(not runtime-verified: herdr's terminal keeps Kitty state only). herdr itself is unchanged.

What herdr does keep is OSC 8. Measured on an isolated herdr 0.9.5 through the server's WebSocket
and a `MachineRelay` (byte-identical): a custom-scheme link on a single blank cell keeps its exact
cell, moves with scrolling, herdr's scrollback view, a resize redraw and a re-attach, and goes with
`clear`; URIs up to ~2 KiB pass (2026 characters kept, 2116 dropped).

## The contract (v1, agreed with the pi images extension)

On each row of a native image except the first (a one-row image: on its only row), the extension
writes one cell right of the image (column `left + c`): U+2800 inside an OSC 8 link

```text
ESC ] 8 ; ; x-pi-image:v1?s=<pi session id>&ref=<encodeURIComponent("pi:<toolCallId>:<n>")>&h=<32 hex>&c=<cols>&r=<rows>&y=<row> ESC \  U+2800  ESC ] 8 ; ; ESC \
```

`n` counts the tool result's image blocks with base64 data and type png/jpeg/gif/webp; `h` is the
first 32 hex digits of the SHA-256 of those decoded bytes. The URI is at most 512 characters. The
marker holds no path, URL or pixels. Native Kitty output is otherwise unchanged; the first image row
carries no marker because pi's fullscreen mode puts a cropped image line there.

`shared/terminal-images.ts` parses it strictly (six keys once each, pi's session-id rule, the ref
grammar of the image endpoint, 1–1000 cells); anything else is no marker. Such links are swallowed
like other links this app cannot open, so they are never drawn as links.

## What the browser does

`src/lib/terminalImages.ts`, wired in `PaneTerminal.tsx`:

- **Which cells are markers.** herdr's attach stream only places the cursor (`CSI row;col H`), sets
  styles and modes, erases (`CSI 2 J` on a full frame) and writes cells; a cell whose text, style or
  link changed is written again, with its link or without one. Measured on herdr 0.9.5
  (`scripts/terminal-image-attach-probe.ts`): a marker cell rewritten as the same U+2800 without the
  link comes as `ESC]8;;ESC\` (the previous link ended), `CSI 9;15 H`, the style and a bare U+2800.
  So a cell is a marker exactly when the last print over it was the single character printed
  first under a marker link. The browser follows the parser as it writes: an OSC 8 opens or ends
  the current link; each print covers the cells between the cursor before and after it, which stop
  being markers, except a lone cell printed first under a fresh marker link, which becomes one.
  Erases are caught by the cell no longer showing U+2800. Anything that moves rows or shifts cells
  (a scroll from a line feed or a wrapping print, `IND`/`NEL`/`RI`, `SU`/`SD`, `IL`/`DL`,
  `ICH`/`DCH`) forgets the markers it may have moved; RIS, a pane switch, a resize and a buffer switch
  forget them all, until herdr's next frame writes them again. At most 2048 marker cells are kept.
  A U+2800 still showing where the marker was proves nothing.
- **Fail closed.** xterm.js 5.5 has no public print hook, so the browser wraps that terminal's own
  `InputHandler.print` (`followTerminalWrites`; the parser calls it through the instance, and the
  wrapper is removed on dispose). Where that internal is missing (another xterm build), no image is
  drawn. The marker link itself never reaches xterm (it is swallowed like other links this app cannot
  open), so it is neither underlined nor clickable.
- **Placement.** Cells of one footprint (`left = x - c`, `top = y - row`) form a placement; the same
  picture can stand in two places. An image shows on the rows that carry its marker and on the row
  above the first of them (the image line), unless that row's marker cell shows a bare U+2800 (a
  marker overwritten there). A picture scrolled off the top or cropped by pi shows only its visible
  rows; a row whose marker was overwritten is not drawn, and the rows around it are drawn apart.
- The image is fetched from **the terminal's own PC and pane** (never from the marker):
  `GET /api[/machines/<id>]/pane/conversation/image?pane_id=…&ref=…&session=<s>&digest=<h>`. The server
  answers only when the pane runs pi now, its transcript header id is `s`, `ref` resolves on the
  active branch, and the bytes' digest is `h`; it echoes `x-herdr-pi-session` and sends `no-store`.
  The browser draws nothing without that echo (an older remote bridge), for another MIME type, over
  8 MiB, over 4096×4096 pixels or 8192 per side (read from the header before decoding), or when
  decoding fails. Two images load at a time; 32 decoded images / 48 MiB are cached per terminal,
  never evicting one on screen. A missing image is asked again after 1, 4 and 15 s (pi may draw a
  result before writing it); a refused one is not, so a forged marker costs one request.
- Images are drawn in a layer inside `.xterm-screen`, clipped to it, below xterm's IME helpers, with
  `pointer-events: none`; each keeps its aspect ratio from the top left of its `c × r` cells. The
  attach stream stays the only source of the screen: `scrollback: 0`, no `pane.read` rebuild, no
  file or URL reads, and ACKs are never held for an image.

Limits: the browser's cell aspect differs from the one pi assumed, so a picture can leave a margin
in its cells. After pi quits, markers it leaves on screen keep their images while this page has them
(as a native terminal keeps the Kitty image); a reload then finds no pi session and draws nothing
there. Images appear once pi's extension has indexed the result; a just-finished result can take a
second. The marker tracking relies on herdr never scrolling the attach stream (measured on 0.9.5;
any scroll makes it forget, so another herdr that scrolled would hide images until its next frame,
not show stale ones).

## Setup

1. **Web UI / bridge (this repository):** rebuild and restart the server you run (`bun run build`,
   then your usual `bun run start` or service restart; nothing restarts automatically). Remote PCs
   need a bridge bundle built from this branch (see [Remote PCs](remote-pcs.md)); an upstream
   `remote-v29` bundle ignores `session`/`digest`, sends no echo, and its pane shows no images.
2. **Pi on every PC (local and remote) where images should show:** pi 1.3.x and the pi images
   extension with terminal references (`oh-my-pi-extensions/images`, `src/terminal-refs.ts`; at the
   time of writing an uncommitted change in that repository). It writes markers only when pi uses
   Kitty images inside a herdr pane (`TERM_PROGRAM=herdr`); `PI_IMAGES_TERMINAL_REFS=0` turns it off,
   `=1` forces it on (still Kitty only). Restart pi sessions to load it. herdr's pi integration
   (installed by herdr) must report the session, as it does for Chat.
3. herdr: unchanged (0.9.5 verified).

## Checks

- `bun test shared/terminal-images.test.ts src/lib/terminalImages.test.ts`: contract parsing, forged
  and oversized markers, placement, clipping and split rows, loader limits, retries and PC/pane keys;
  marker tracking on a real (headless) xterm 5.5: overwrites by a bare U+2800, another link or a run,
  erase, scroll, inserted characters and reset; and herdr 0.9.5's own captured attach bytes for a
  marker rewritten without its link, fed whole and one character per write.
- `server/pi.contract.test.ts`, `server/machine-proxy.test.ts`: session/digest binding, a reused tool
  call id in another session, the echo through a PC's proxy.
- `bun run check run bun scripts/terminal-image-attach-probe.ts`: captures what herdr sends for
  markers drawn, rewritten bare and restored (server WebSocket and a loopback relay), and what the
  tracking makes of it.
- End to end, with a real pi and the extension (both read-only), an isolated herdr and Chromium:

  ```sh
  PI_IMAGES_EXTENSION=/path/to/oh-my-pi-extensions/images/src/index.ts \
    bun run check run --build bun scripts/terminal-image-regression.ts   # PI_TUI_MODE=regular too
  ```

  It checks pixels and placement against the marker cells locally and through a remote PC's bridge
  (a loopback fake SSH forward, not a real SSH host), after resize, scroll, reload and a dropped
  socket; then, after pi quits, overwrites one image's marker cells with a bare U+2800 (the glyph
  stays, the image and its pixels go, the others stay), overwrites another's middle marker (it is
  drawn in two parts), writes the markers again (the image is back); removal on `clear`; forged
  markers; a later session reusing a tool call id; and that herdr's attach stream never scrolled or
  shifted cells in the whole run. Screenshots and `result.json` go to `TERMINAL_IMAGE_EVIDENCE_DIR`.
- `scripts/terminal-image-diagnostic.ts` still documents that raw Kitty bytes never reach the attach
  stream (exit 2 is the expected result on herdr 0.9.5).
