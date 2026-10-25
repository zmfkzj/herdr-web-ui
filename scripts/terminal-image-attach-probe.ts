/**
 * What herdr's attach stream sends for pi image markers (docs/terminal-images.md), and what the
 * browser's marker tracking makes of those bytes, chunk by chunk as they arrive:
 *
 *   bun run check run bun scripts/terminal-image-attach-probe.ts
 *
 * A shell in an owned pane of the test herdr prints, stage by stage: five markers of a 12 x 6 image
 * and one more (draw); row 8's marker again as U+2800 without its link (bare); rows 4..7 too
 * (bareAll); the markers again (restore). Each stage's bytes are read through the server's WebSocket
 * and through a loopback MachineRelay (not real SSH), fed into a headless xterm wired as
 * PaneTerminal wires it, and reported with the control sequences herdr used (it only places the
 * cursor and writes cells: no line feed or scroll). A last attach shows the full first frame.
 * Output: TERMINAL_IMAGE_PROBE_DIR (default: a temp dir) holds each stage's bytes and result.json.
 */
import "./test-herdr.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/xterm";
import { createServer } from "../server/index.ts";
import { herdrRpc, paneProcessInfo, paneSendKeys, paneSendText } from "../server/herdr/client.ts";
import { MachineRelay } from "../server/machine-relay.ts";
import type { MachineManager } from "../server/machines.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { hyperlinkFilter } from "../src/lib/terminalFileLinks.ts";
import { TerminalImageLayer } from "../src/lib/terminalImages.ts";

if (process.env["HERDR_TEST_LIVE"] === "1") throw new Error("refuses HERDR_TEST_LIVE=1");
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-terminal-image-probe-"));
const out = process.env["TERMINAL_IMAGE_PROBE_DIR"] || join(root, "out");
mkdirSync(out, { recursive: true });
const until = async (test: () => boolean, what: string, ms = 15_000) => {
  for (const end = Date.now() + ms; !test();) { if (Date.now() >= end) throw new Error(`Timed out: ${what}`); await Bun.sleep(25); }
};
const ESC = "\x1b";
const cup = (row: number, col: number) => `${ESC}[${row + 1};${col + 1}H`;
const uri = (y: number) => `x-pi-image:v1?s=0190abcd-0000-7000-8000-000000000001&ref=pi%3Acall_01%3A0&h=0123456789abcdef0123456789abcdef&c=12&r=6&y=${y}`;
const marker = (y: number) => `${ESC}]8;;${uri(y)}${ESC}\\\u2800${ESC}]8;;${ESC}\\`;
// stage 1: a 12 x 6 footprint at column 2, row 3 -> markers at column 14, rows 4..8; pi-like tool background on row 4..8
const stages: Record<string, string> = {
  draw: `${ESC}[2J` + [1, 2, 3, 4, 5].map((y) => `${cup(3 + y, 2)}${ESC}[48;5;236m            ${marker(y)}${ESC}[0m`).join("")
    // a marker whose link stays open over padding after it (a link held over EL-cleared cells)
    + `${cup(12, 14)}${ESC}]8;;${uri(1)}${ESC}\\\u2800${ESC}[K${ESC}]8;;${ESC}\\` + cup(20, 0),
  // stage 2: the bottom marker (row 8) rewritten as a bare U+2800 with the same background
  bare: `${ESC}7${cup(8, 14)}${ESC}[48;5;236m\u2800${ESC}[0m${ESC}8`,
  // stage 3: rows 4..7 too, default style
  bareAll: `${ESC}7` + [4, 5, 6, 7].map((row) => `${cup(row, 14)}\u2800`).join("") + `${ESC}8`,
  // stage 4: the markers written again
  restore: `${ESC}7` + [1, 2, 3, 4, 5].map((y) => `${cup(3 + y, 14)}${ESC}[48;5;236m${marker(y)}${ESC}[0m`).join("") + `${ESC}8`,
};
for (const [name, data] of Object.entries(stages)) writeFileSync(join(root, `${name}.bin`), data);

let workspace: string | undefined; let server: ReturnType<typeof createServer> | undefined;
let proxy: ReturnType<typeof Bun.serve<{ relay: MachineRelay }>> | undefined; const sockets: WebSocket[] = []; const relays = new Set<MachineRelay>();
const result: Record<string, unknown> = {};
try {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { label: "herdr-web-ui-test-terminal-image-probe", cwd: root, focus: false });
  workspace = created.workspace.workspace_id; const pane = created.root_pane.pane_id;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", herdrProfiles: async () => [], tailscaleOwner: null, stateDir: join(root, "state") });
  const endpoint = { url: `http://127.0.0.1:${server.port}`, token: "fixture-only" };
  const manager = { endpoint: () => endpoint, trackTerminal: () => () => {} } as unknown as MachineManager;
  proxy = Bun.serve<{ relay: MachineRelay }>({ port: 0, hostname: "127.0.0.1", async fetch(request, app) {
    if (new URL(request.url).pathname !== "/ws") return new Response("not found", { status: 404 });
    const relay = new MachineRelay(manager, "fixture-pc"); relays.add(relay);
    try { await relay.ready; } catch { relay.close(); return new Response("upstream failed", { status: 502 }); }
    if (app.upgrade(request, { data: { relay } })) return; relay.close(); return new Response("upgrade failed", { status: 400 });
  }, websocket: { open(c) { c.data.relay.bind(c); }, message(c, d) { c.data.relay.message(d); }, close(c) { c.data.relay.close(); relays.delete(c.data.relay); } } });

  // each attach feeds a headless xterm wired as PaneTerminal wires it, chunk by chunk as received
  const views: Record<string, { bytes: string; chunks: number; term: Terminal; layer: TerminalImageLayer; pending: Promise<void> }> = {};
  const attach = async (name: string, port: number) => {
    const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24, scrollback: 0 });
    const layer = new TerminalImageLayer(term, () => null);
    const filter = hyperlinkFilter();
    term.parser.registerOscHandler(8, (payload) => { layer.hyperlink(payload); return filter.handler(payload); });
    term.parser.registerEscHandler({ final: "c" }, () => { layer.reset(); return false; });
    const view = views[name] = { bytes: "", chunks: 0, term, layer, pending: Promise.resolve() };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(ws);
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      if (frame.type !== "pty-data" || frame.pane_id !== pane) return;
      view.bytes += frame.data; view.chunks++;
      view.pending = view.pending.then(() => new Promise<void>((resolve) => term.write(frame.data, resolve)));
      if (frame.flow) ws.send(JSON.stringify({ type: "pty-ack", pane_id: pane, ...frame.flow }));
    };
    await until(() => ws.readyState === WebSocket.OPEN, `${name} socket`);
    ws.send(JSON.stringify({ type: "attach", pane_id: pane, cols: 80, rows: 24, flow_control: "ack" }));
    await until(() => view.bytes.length > 0, `${name} first frame`);
    return ws;
  };
  await attach("local", server.port);
  await attach("relay", proxy.port);
  const settle = async () => { let last = -1; for (let i = 0; i < 40; i++) { const n = views["local"]!.bytes.length + views["relay"]!.bytes.length; if (n === last) break; last = n; await Bun.sleep(150); } for (const view of Object.values(views)) await view.pending; };
  const placements = (name: string) => { const { layer } = views[name]!; layer.update(); return layer.placements.map((p) => `${p.ref} ${p.left},${p.top} rows ${p.firstRow}-${p.lastRow}`); };
  const cell = (name: string, x: number, y: number) => views[name]!.term.buffer.active.getLine(y)?.getCell(x)?.getChars();

  // one shell command runs every stage in turn, each when its go-file appears
  writeFileSync(join(root, "run.sh"), `for s in draw bare bareAll restore; do until [ -e ${root}/go-$s ]; do sleep 0.05; done; cat ${root}/$s.bin; done\nuntil [ -e ${root}/go-end ]; do sleep 0.1; done\n`);
  await paneSendText(pane, `clear; sh ${root}/run.sh`); await paneSendKeys(pane, ["Enter"]);
  for (const deadline = Date.now() + 10_000; !(await paneProcessInfo(pane).catch(() => undefined))?.foreground_processes?.some((process) => process.name === "sh");) {
    if (Date.now() > deadline) throw new Error("the stage script did not start");
    await Bun.sleep(25);
  }
  await settle();
  for (const stage of Object.keys(stages)) {
    const from = { local: views["local"]!.bytes.length, relay: views["relay"]!.bytes.length };
    writeFileSync(join(root, `go-${stage}`), "");
    await until(() => views["local"]!.bytes.length > from.local && views["relay"]!.bytes.length > from.relay, `${stage} drawn`);
    await settle();
    const delta = views["local"]!.bytes.slice(from.local);
    writeFileSync(join(out, `${stage}.local.txt`), delta);
    const seqs: Record<string, number> = {};
    for (const m of delta.matchAll(/\x1b\[[0-9;?]*[A-Za-z@`]|\x1b[A-Z78=>c]|\n|\r/g)) { const k = m[0].replace(/\d+/g, "n"); seqs[k] = (seqs[k] ?? 0) + 1; }
    result[stage] = {
      // the bytes herdr wrote for the marker column, readable
      bytes: JSON.stringify(delta.replace(/x-pi-image:[^\x1b]*/g, "URI")).slice(0, 1200),
      sequences: seqs,
      relayEqualsLocal: views["relay"]!.bytes.slice(from.relay) === delta,
      local: placements("local"), relay: placements("relay"),
      markerColumn: [4, 5, 6, 7, 8, 12].map((row) => cell("local", 14, row) === "\u2800" ? "U+2800" : JSON.stringify(cell("local", 14, row))),
    };
  }
  // a fresh attach after everything: the full first frame
  await attach("reconnect", server.port); await settle();
  result["reconnect"] = { local: placements("reconnect"), sequences: [...new Set([...views["reconnect"]!.bytes.matchAll(/\x1b\[[0-9;?]*[A-Za-z@`]|\x1b[A-Z78=>c]|\n|\r/g)].map((m) => m[0].replace(/\d+/g, "n")))] };
  writeFileSync(join(root, "go-end"), "");
  result["chunks"] = { local: views["local"]!.chunks, relay: views["relay"]!.chunks };
  result["herdr"] = Bun.spawnSync([process.env["OVIS_HERDR_BIN"] || "herdr", "--version"]).stdout.toString().trim();
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`terminal image attach probe: ${out}`);
} finally {
  for (const ws of sockets) ws.close(); for (const r of relays) r.close(); proxy?.stop(true); server?.stop();
  if (workspace) await herdrRpc("workspace.close", { workspace_id: workspace }).catch(() => {});
}
