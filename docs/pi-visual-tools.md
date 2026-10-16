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

In Pi, run `/gui view W1` (or `/gui view main`). The existing Pi terminal prints
the address, user, one-time password and SHA-256 certificate fingerprint.
In the worker panel, select **Open private desktop** and enter the port,
password and fingerprint. The destination is fixed to loopback and user `pi`.
No arbitrary host or guacd/RDP option can be supplied by the browser.

**Observe only is the default.** To type or click, stop assigning work to that
worker, uncheck Observe only, and explicitly connect. This is not a mutual
exclusion lock: do not let the worker and yourself operate simultaneously.
Shift+Escape moves keyboard focus from the remote screen back to the controls.
Touch keyboard/IME forwarding is not implemented; keyboard/mouse control is
intended for a desktop browser. Mobile viewing remains possible.

The password is entered into an uncontrolled DOM input, transmitted on the
explicit connect action over HTTPS or localhost, and cleared. It is not put in
chat, localStorage, a URL, a retry queue, or application logs. The backend uses a
30-second, one-use, cookie/device-bound ticket; reconnects require the password
again. RDP uses TLS and the **explicit certificate fingerprint**, not blanket
certificate ignoring. File, clipboard, printer and audio redirection are disabled.
Read-only mouse/key filtering is also enforced by the backend.

Closing the browser viewer closes only its guacd connection; Pi, krdp and the
private desktop stay under `pi-gui` ownership. Device revocation, a ended pane,
or a detected Pi session change disconnects the web viewer. The Pi session is
rechecked periodically while connected.

**Direct-host access:** this first version's desktop websocket is local to the
selected web backend. For a Pi host listed through the multi-PC aggregator,
open that host's web UI directly. Worker reads and image reviews use the existing
machine API routes when the remote backend also runs this branch. Old upstream
remote bundles do not contain these routes.

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
appends its path and unresolved comments to the existing chat draft. It does not
send the message, overwrite existing draft text, change models, or call the
image-generation provider directly. Review and send the draft yourself.

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
bun test server/pi-visual/visual.test.ts server/pi-visual/tunnel.test.ts src/lib/pi-visual/visual.test.ts
CHROME_PATH=/path/to/chrome bun scripts/pi-visual-browser-qa.ts
```

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
