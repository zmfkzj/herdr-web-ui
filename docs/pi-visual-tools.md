# Original Pi visual tools (feature branch)

This branch adds browser UI for **original Pi with `zmfkzj/oh-my-pi-extensions`**.
It does not switch the runtime to Oh My Pi (`omp`), install an OMP SDK, or change
OMP's existing chat support. Herdr and Pi still own the terminals, sessions,
model connections and approvals. The features are normal source changes, not
runtime monkey patches or a new generic plugin framework.

## Run this branch

Keep your current installation available while trying the feature on another port:

```sh
git clone https://github.com/zmfkzj/herdr-web-ui.git
cd herdr-web-ui
git switch feat/pi-visual-tools
bun install --frozen-lockfile
bun run build
PORT=7318 bun run server
```

Open `http://localhost:7318` on the Pi host. For another device, use the same
trusted VPN / HTTPS access setup as the normal app. The server remains bound to
loopback by default. This command is the unmanaged entrypoint: it does **not**
replace your existing app or run the upstream self-updater. Do not install an
upstream release over this feature branch; merge upstream and test instead.

`HERDR_SOCKET` selects a non-default Herdr session. The Pi process must already
be running in that Herdr instance. Use the same OS user and Pi agent directory as
that process; `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` retain their
existing meaning. Neither extension bundle nor its submodules need modification.

## 1. Worker monitor

Open an original Pi pane in **Chat** and expand **Pi workers and desktop**.
The panel shows job/worker IDs, recorded state, role, assignment, model/thinking,
last completed tool where recorded, summary, and recorded sub-workers.
It refreshes every two seconds while visible and connected.

The adapter reads native `custom/orche-job` records on the currently persisted
Pi branch and enriches them from `pi-orche`'s `run.json` and bounded worker
transcript tails. It checks the **exact parent session ID and file**, not just
the project directory. Abandoned branches and other sessions are not mixed in.
It never writes to Pi's transcripts or invokes a model to infer status.

Default run-record root: `~/.pi/agent/orche/records`. If your orche configuration
uses a custom `records.dir`, point `HERDR_PI_ORCHE_RECORDS_DIR` at the same
absolute directory. With records disabled, native job entries still appear but
richer details will be absent. The panel retains active and the newest 30 ended
jobs within a bounded read window and explicitly flags truncated history.

This is a **record-backed monitor**, not a new worker manager. Tool start/streaming
data not persisted by Pi is not available; `lastTool` is the most recently
recorded completed tool, and child records can arrive only when orche persists
them. Explicitly blocking/library-only runs that do not write `orche-job` entries
are not listed. A runtime-only `/tree` move is visible after Pi records its new
branch. Use existing `/orche` commands for cancellation, messaging and approval;
the panel does not bypass those policies.

## 2. Browser desktop viewer

The viewer connects to the RDP server **already provided by `pi-gui`**, through a
local `guacd`. It is not a CDP browser or VNC viewer.

Prerequisites on the machine running Pi and this web backend:

- `pi-gui` private KDE Wayland desktop and its normal `/gui doctor` prerequisites.
- `krdp` / `openssl` for `/gui view`, as documented by `pi-gui`.
- Apache **guacd 1.6.0 or newer**, built with FreeRDP GFX/H.264 decoding support.
  `pi-gui`'s krdp requires AVC420; a build without its decoder cannot show the
  desktop even when authentication succeeds.
- guacd listening at **127.0.0.1:4822**, never exposed publicly. For a native
  installation, the foreground command is:

```sh
guacd -f -b 127.0.0.1 -l 4822
```

On **Ubuntu 24.04 LTS or 26.04 LTS** (point releases included), the retained installer is
`install-guacd-h264-ubuntu26.04-v3.sh`. The filename is kept for existing callers; its header says
**Revision 5**, and it builds the same private FreeRDP 3.32.2 and guacd 1.6.0 into
`/opt/herdr-guacd` on both releases, with the glibc 2.43 fixes and a real AVC420 decoder probe.
Run it as your normal user: it asks for sudo for apt and for `/opt/herdr-guacd`. It needs the
`universe` component (ninja-build and the FFmpeg `-dev` packages) and HTTPS access to GitHub and
downloads.apache.org.

```sh
bash install-guacd-h264-ubuntu26.04-v3.sh                          # new install
bash install-guacd-h264-ubuntu26.04-v3.sh --resume [BUILD_DIRECTORY]  # FreeRDP installed, guacd not
bash install-guacd-h264-ubuntu26.04-v3.sh --rebuild-guacd [BUILD_DIRECTORY]  # replace an installed guacd
bash install-guacd-h264-ubuntu26.04-v3.check.sh [--build]           # checks; installs nothing
```

**guacd built before revision 6 draws nothing.** guacd 1.6.0 initializes FreeRDP's GDI in
PreConnect, but FreeRDP 3.31+ (this stack uses 3.32.2) creates the cache that `gdi_init()` needs
only later, so each connection's guacd process aborts on `WINPR_ASSERT(cache->brush)`
(`libfreerdp/cache/brush.c`) right after "Loading Dynamic Virtual Channel rdpgfx": the viewer
stays on "Connecting…" and guacd's log shows a WinPR backtrace. Revision 6 applies upstream's fix
(GUACAMOLE-2328, initialize the GDI in PostConnect). Rebuild guacd only, reusing FreeRDP and the
cached build, then restart the stack:

```sh
bash install-guacd-h264-ubuntu26.04-v3.sh --rebuild-guacd    # sudo make install into /opt/herdr-guacd
scripts/pi-visual-stack.sh restart
```

Other Ubuntu releases and derivatives such as Linux Mint are refused before anything changes.
`--resume` runs no apt. It reuses a cached build directory and `/opt/herdr-guacd` only when both
were built for this release and architecture (recorded in the build directory's
`herdr-build-target` and in `/opt/herdr-guacd/share/herdr-guacd/build-target`) and the FreeRDP
build used the same GCC major version. Unrecorded ones from the earlier 26.04-only revision remain
usable on Ubuntu 26.04 after the same library and AVC420 decode checks. After a release upgrade,
move `/opt/herdr-guacd` away and install again. The older unversioned and `-resume.sh` installers
were removed; recovery is in this script. The `.check.sh` companion is not another installer: it
checks release detection, apt candidates, resume compatibility, the source fixes and the decoder,
and with `--build` compiles guacd with `-Werror` in a temporary directory, without running the
installation flow. Neither script is run automatically.

Images inside the Pi **terminal** use Kitty graphics, not guacd. herdr drops them from the attach
stream; with the pi images extension's markers the browser draws tool-result images inline itself
(see [Terminal images](terminal-images.md)). This RDP viewer and image review are not involved.

Start the feature backend with the explicitly enabled desktop gateway:

```sh
HERDR_PI_GUACD_ENABLED=1 PORT=7318 bun run server
```

### Start guacd and the server together

`scripts/pi-visual-stack.sh` runs both commands above in the background, each in a session of
its own with its output in a log, so they keep running after the terminal closes:

```sh
scripts/pi-visual-stack.sh          # start (same as `start`): guacd, then the server
scripts/pi-visual-stack.sh status   # exit 0 only when both run and listen
scripts/pi-visual-stack.sh logs     # the end of both logs
scripts/pi-visual-stack.sh stop     # stop the pair
scripts/pi-visual-stack.sh restart
```

It starts `/opt/herdr-guacd/sbin/guacd -f -b 127.0.0.1 -l 4822 -L info` and
`HERDR_PI_GUACD_ENABLED=1 PORT=7318 bun run server` (`HOST` defaults to `127.0.0.1`), waits until
each listens, and prints the address. Before starting anything it checks that guacd exists and
runs (`guacd -v`), that Bun is found, and that `bun install` and `bun run build` have been run;
it names what is missing instead of installing or building it. It refuses to run as root.

- **Settings:** `PORT` and `HOST` for the server (other server variables such as `HERDR_SOCKET`
  or `HERDR_WEB_TOKEN` pass through), `HERDR_STACK_GUACD_BIN` for another guacd binary,
  `HERDR_STACK_START_TIMEOUT` / `HERDR_STACK_STOP_TIMEOUT` in seconds (30 / 15). guacd always
  binds `127.0.0.1:4822`, the address the gateway dials. Use the same variables for `status` and
  `stop` as for `start`.
- **Logs and records:** `guacd.log`, `web-ui.log` and the pid records live in
  `${HERDR_WEB_STATE_DIR:-~/.config/herdr-web-ui}/pi-visual-stack/` (`HERDR_STACK_DIR` moves
  them). Logs are appended to and kept after `stop`.
- **Only its own processes:** a second `start` reuses the running pair, and two commands at once
  are serialized by a lock. A port already held by a guacd or server started some other way is
  refused and left alone; stop that one yourself first. `stop` signals only the sessions this
  script started, recognized by pid, start time and boot, and sends KILL after the stop timeout.
  When the server fails to start, the guacd this run started is stopped again.
- `status` checks that the recorded processes listen on their ports. To ask the server itself,
  `curl http://127.0.0.1:7318/api/health?scope=bridge` answers without herdr, while
  `/api/health` also pings herdr.
- It is an on-demand launcher, not a boot service: nothing starts it again after a reboot or a
  crash.

In Pi, run `/gui view W1` (or `/gui view main`) in the pane this web UI shows: the desktop opens
here at once (next section). The **Open private desktop** form in the worker panel stays for a
viewer this browser did not start: enter the port, one-time password and fingerprint the Pi
terminal printed. The destination is fixed to loopback and user `pi`. No arbitrary host or
guacd/RDP option can be supplied by the browser.

**Observe only is the default.** Every connection starts view-only unless Observe only was
unchecked before connecting, and a `/gui view` desktop always opens view-only. To type or click,
stop assigning work to that worker, then press **Switch input** (입력 전환) in the open viewer: the
badge beside it changes from "View only: input is blocked" to "Input on: mouse and keyboard reach
the desktop" once the PC confirms it. Press it again to hand control back. The switch keeps the
same connection, so it needs no password and no reconnect. This is not a mutual exclusion lock:
do not let the worker and yourself operate simultaneously.
Shift+Escape moves keyboard focus from the remote screen back to the controls.

- **How the switch works.** The browser sends `pi-input,<observe|interact>,<id>` on its own
  desktop socket (`shared/pi-visual.ts` `PI_INPUT_OPCODE`). The PC's `DesktopTunnel`
  (`server/pi-visual/guacamole.ts`) answers with the mode now in force and never passes it to
  guacd; the browser passes keys and pointer only after an `interact` answer. guacd's RDP
  connection is opened with `read-only` false, so the tunnel's filter is what enforces view-only:
  in view-only only `sync`, `nop`, `ack` and pings pass, never key, mouse, size, clipboard,
  files or streams.
- **Back to view-only** first lets go of what this viewer holds: the browser releases its keys and
  buttons, and the tunnel sends a key-up for every key and a button-up for the pointer it passed
  on, before it answers. The same release runs when the viewer blurs, closes or disconnects.
- **Who may switch.** Only the open connection itself, for its own desktop; other viewers of the
  same desktop keep their own mode. A device whose role is now watch-only is refused input
  (`This device may only watch`) and loses the desktop at the next 3 s recheck, on this PC and
  through a connection server's relay alike. Device revocation still closes it at once.
- **Lost answers.** A switch to input that is not confirmed within 5 s leaves the viewer view-only
  with a message (a remote PC whose bridge predates the switch ignores it: install this server's
  Pi visual bridge there). A switch to view-only that is not confirmed ends that viewer, so input
  stops in any case.

Touch keyboard/IME forwarding is not implemented; keyboard/mouse control is
intended for a desktop browser. Mobile viewing remains possible.

The password is entered into an uncontrolled DOM input, transmitted on the
explicit connect action over HTTPS, localhost or a direct Tailscale link (below), and cleared. It is not put in
chat, localStorage, a URL, a retry queue, or application logs. The backend uses a
30-second, one-use, cookie/device-bound ticket; reconnects require the password
again (Switch input avoids them). RDP uses TLS and the **explicit certificate fingerprint**, not blanket
certificate ignoring. File, clipboard, printer and audio redirection are disabled.
View-only mouse/key filtering is enforced by the backend (above).

Closing the browser viewer closes only its guacd connection; Pi, krdp and the
private desktop stay under `pi-gui` ownership. Device revocation, a ended pane,
or a detected Pi session change disconnects the web viewer. The Pi session is
rechecked periodically while connected.

## `/gui view <WORKER>` opens the desktop at once

Run `/gui view W1` (or `main`, `W3-2`, or a bare `/gui view`) in an original Pi pane of this web UI:
typed straight into its terminal, sent from the chat message box, or sent from the terminal's input
box. The desktop opens in this browser, on the PC the pane belongs to (this PC or a remote one),
observe-only by default, without asking for the password pi-gui printed.

- **Which addresses.** Private desktops open over HTTPS, on `localhost`, or straight over Tailscale:
  with `HOST` set to this PC's tailnet address or MagicDNS name (`HOST=100.x.y.z` or
  `HOST=pc.tailnet.ts.net`, as `scripts/pi-visual-stack.sh` is often started), a browser on another
  tailnet device at `http://100.x.y.z:7318` counts, because WireGuard encrypts that link end to end.
  It counts only when the server is bound to tailnet addresses only (a name: every address it
  resolved to at startup), the connecting peer is a tailnet address (Tailscale's own firewall rules drop such
  sources arriving on other interfaces) and no proxy header (`X-Forwarded-*`, `Forwarded`, `Via`,
  `X-Real-IP`, `Tailscale-User-Login`) says it was relayed (`server/access.ts`
  `directTailnetRequest`). A wildcard (`0.0.0.0`) or LAN bind, a LAN address and plain HTTP through
  a proxy are still refused with "Use HTTPS, localhost or this PC's Tailscale address". The same
  rule applies to another PC's desktop relayed through this server. SSH passwords and key
  passphrases keep their HTTPS-or-localhost rule.

- **Names** resolve the way pi-gui resolves them: the exact name first, then a case-insensitive
  one. Two case-insensitive matches, an unknown name, or no viewer within 45 s end with a message;
  nothing falls back to another worker or another PC. A bare `/gui view` opens only a viewer that
  started after the command.
- **Pi's completion list.** While a slash command is typed, Pi lists completions and Enter takes
  the highlighted one. When another desktop's name starts with the typed one (`W1` and `W10`,
  `W1` and `W1-2`), Pi may have opened that one instead, so the viewer stops with a message.
  Press Esc before Enter, or send the command from the message box.
- **What counts as the command.** The server that passed the keys on follows the line typed into
  that pane (printable keys, Backspace, Delete, ←, →, Home, End, one-line pastes; Ctrl+C or Ctrl+U at
  the end of the line empties it; mouse and focus reports change nothing); the desktop then opens at
  once. A key it cannot follow (↑/↓ history or completion choice, Tab, word motions, a modified
  Enter, a multi-line paste) leaves the line unnamed, and so does a chat message that waited for Pi
  to finish its turn. Then Pi's own word counts: after an Enter this browser delivered to an
  original Pi pane (typed, a chat message, **Send now**, a held message sent on its turn), the PC
  watches that pane's Pi processes' `gui.log` for up to 10 s for the line pi-gui writes for every
  `/gui view` it answers (`view W1: client not opened (…)`, `opened …`, `could not open a client`),
  and the desktop it names opens in the browser whose Enter came last before it
  (`server/pi-visual/runs.ts`, the `gui-view` frame). Output on the screen and text such as
  `echo /gui view W1` never count, and a `gui.log` line counts only after this browser's own Enter.
- **Who may open it.** Only the browser that ran the command, on that PC's pane and through the same
  bridge connection, once, within 2 minutes (`server/pi-visual/grants.ts`). Typing the pane did not
  take (observe mode, a held or unready terminal, a refused submit) grants nothing, and a revoked
  device's grants go with it. Watch devices cannot open desktops at all. Every other open (another
  browser, the panel's buttons, a second open) asks for the one-time password.
- **Which viewer.** The PC that runs Pi finds it from pi-gui's `gui.log` line plus `/proc` checks:
  same uid, krdp is a child of that Pi process, loopback port, a private
  `computer-use-mcp-isolated-*` runtime directory with the certificate inside it, start times near the
  log line, and a Pi process that was already running when the command was typed (a reused pane
  ID with another Pi opens nothing). It then uses krdp's one-time password itself; the password
  never reaches the browser. Viewer discovery needs Linux (`/proc`); elsewhere the password form stays.

## Remote PCs (SSH bridges)

Worker reads, image reviews and desktops of a remote PC go through this web server and that PC's
existing SSH forward, with its bridge bearer. Remote guacd and krdp stay on that PC's loopback: the
browser holds only this server's one-use, 30-second ticket, bound to its device, that PC and the
current bridge connection; it never sees the bridge's bearer or ticket. A PC disconnect, a bridge
reconnect, desktop viewing turned off, a device revoke or a normal close ends that PC's desktop
relays only; terminals and chats of every PC keep working.

**On the remote PC** (Linux; pi-gui's KRDP desktops need it): pi-gui with its `/gui doctor`
prerequisites, and an H.264-capable guacd 1.6+ on `127.0.0.1:4822`, installed by you as for this
PC (nothing installs or starts it for you). **On this web server:** `HERDR_PI_GUACD_ENABLED=1`, as for
its own desktops; it also decides for every PC it relays to.

1. **Bridge with the Pi visual routes.** Upstream and older bridges report no `pi_visual` in
   `/api/bridge`; their panel says so and offers **Install Pi visual bridge** instead of controls
   that cannot work. Build this branch's bundle on this web server first, for the remote PC's
   platform: `bun run build:remote linux-x64` (or `linux-arm64`). It writes
   `remote-bundles/manifest-linux-x64.json` and its archive beside the server, which the server then
   installs instead of the published upstream release (see [Remote PCs](remote-pcs.md#building-and-distributing-runtimes)).
   The install refuses a manifest without the `pi-visual` feature before anything is uploaded, and
   reports a failure when the new bridge still lacks the routes.
2. **Turn desktop viewing on for that PC.** It is off for every PC until its user turns it on:
   **Turn on desktop viewing for this PC** in the worker panel or the desktop viewer (an
   interactive device only). A managed bridge started without it restarts with
   `HERDR_PI_GUACD_ENABLED=1` (herdr sessions keep running), and the choice is recorded only once
   the new bridge reports it. It is kept for that PC and SSH target in `pi-desktop.json` in the state
   directory, survives server restarts, reconnects and bridge updates (every bridge start says
   `HERDR_PI_GUACD_ENABLED=1` or `=0` explicitly, never inheriting the SSH login's environment), and
   is dropped when the PC is removed or its SSH target changes. A bridge managed elsewhere is never
   restarted: start it with `HERDR_PI_GUACD_ENABLED=1` on that PC, then turn it on here.
   **Turn off desktop viewing for this PC** stops relaying at once; the bridge keeps its startup
   value until it next restarts.
3. Run `/gui view W1` in that PC's Pi pane, as on this PC.

Protocol references:
- https://guacamole.apache.org/doc/gug/configuring-guacamole.html (TLS, `cert-fingerprints`, GFX)
- https://guacamole.apache.org/doc/gug/protocol-reference.html (handshake, streams)
- Client: pinned `guacamole-common-js@1.5.0`, the npm repack of Apache's client;
  the gateway negotiates protocol 1.5.0 with guacd 1.6+.

## 3. Image comments and feedback

Open a Pi chat image, then choose **Image comments** in its viewer toolbar.
Click to add a pin or drag to mark a rectangle. The **Add center comment** button
provides a keyboard-accessible way to add a pin. Zoom and scroll to inspect the
image, edit the comment text, mark comments resolved, and save.

Images are snapshotted before editing. Reviews are keyed by Pi session and the
**SHA-256 of the actual image bytes**. Replacing `output.png` does not silently
move yesterday's comments to today's image. Coordinates are normalized to the
original image. Concurrent tab writes require the current revision; a stale save
returns a conflict and retains the unsaved text for copying/reconciliation.

**Create feedback draft** saves pending comments, exports a marked PNG with
numbered regions, uploads it using the existing pane attachment mechanism, and
appends its path and unresolved comments to the existing chat draft. The review
then closes and the pane shows its chat lens (also when the review was opened
from the terminal lens, which has no message box), with the draft in the message
box and the caret after the feedback. While the pane has no message box (view
only, ended, a password prompt), the button says so and adds nothing. It does not
send the message, type into the terminal, overwrite existing draft text, change
models, or call the image-generation provider directly. Review and send the draft
yourself.

Supported review inputs: PNG, JPEG, WebP, GIF, up to 16 MiB. Marked exports use a
single raster frame and a maximum 4096-pixel edge; animated-image review is not a
frame-accurate video editor. SVG is deliberately excluded from persistent review
snapshots. Marked exports are saved beside normal uploaded pane attachments.

Reviews persist in `<HERDR_WEB_STATE_DIR>/pi-visual/reviews.sqlite` (the normal
app state directory when unset), with private file permissions. The store has a
256 MiB/500-image limit and refuses new snapshots rather than silently deleting
reviews. This branch does not add an administration UI for exporting/pruning the
review database; back it up before maintaining it on the server.

## Compatibility baseline and verification

Source contracts were inspected at:

| Repository | Revision |
| --- | --- |
| `oh-my-pi-extensions` | `c3e07be24c0c22878bb12766a9fd5ad353d8b262` |
| `pi-orche` | `f88d208a63517b9d0bfc2f47d31129d65eb6c27e` |
| `pi-gui` | `ee3bc983f5ffec0a6b19b03c4202416d805f5e48` |
| `pi-images` | `f915d4cbde830b8cdcfedb69d4f999da2e7bf027` |

`pi-images` remains unchanged: the feedback is a normal Pi prompt with a local
annotated image, so the extension bundle retains its existing image tooling.
No claims are made that arbitrary future private extension formats are stable.

```sh
bun run typecheck
bun run build
bun test shared/pi-visual.test.ts server/pi-visual/ server/machine-pi-visual-update.test.ts src/lib/pi-visual/visual.test.ts
CHROME_PATH=/path/to/chrome bun scripts/pi-visual-browser-qa.ts
CHROME_PATH=/path/to/chrome bun run check run bun scripts/pi-visual-gui-view-qa.ts
```

`pi-visual-gui-view-qa.ts` types `/gui view` into a real terminal of an isolated herdr pane and
checks the painted desktop for this PC and for a remote PC reached through a fake SSH forward to a
second server; its Pi, krdp and guacd are stand-ins. Real KRDP over a real SSH host, and H.264
decoding by a real guacd, are not covered by these checks.

The tests cover original-Pi record shapes, persisted branches, foreign-session
and symlink refusal, content versions, optimistic concurrency, observer
restrictions, bounded requests, one-use tickets, TLS pinning, protocol framing,
and a real local TCP guacd-protocol fixture. Browser QA exercises real React,
the review database, feedback drafts and the Guacamole client against fixtures
on desktop/mobile layouts. It makes no model requests and touches no user session.

**Not a live environment certification:** fixture tests are not an end-to-end
run on your actual Herdr/Pi/KDE/krdp/FreeRDP installation. Real H.264 decoding,
private-desktop input and the precise version installed on your machine must be
smoke-tested there. These checks cannot be inferred from successful TypeScript
compilation or the mocked RDP protocol fixture.
