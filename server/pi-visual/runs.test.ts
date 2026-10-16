import { describe, expect, it } from "bun:test";
import { GUI_VIEW_RUN_MS, GuiViewRuns, readRuns } from "./runs.ts";
import type { ViewerSystem } from "./viewers.ts";

const T0 = Date.parse("2026-10-16T14:27:45.000Z");
const LOG = "/home/u/.pi/agent/gui.log";
/** pi-gui's lines for one `/gui view` (pi-gui src/viewer.ts): a new viewer, then how its client went */
const started = (pi: number, worker: string, at: number) => `${new Date(at).toISOString()} [gui] main pid=${pi} view ${worker}: krdp pid ${pi + 1} listening on 127.0.0.1:46121 for wayland-virtual-9`;
const answered = (pi: number, worker: string, at: number, how = "client not opened (Pi runs in herdr pane w3:p3: herdr-web-ui shows this desktop)") =>
  `${new Date(at).toISOString()} [gui] main pid=${pi} view ${worker}: ${how}`;

/** pane p1 runs Pi 100 (this user), pane p2 runs a shell 300, pane p3 another user's Pi 400 */
function system(log: { text: string }, options: { uid?: number; supported?: boolean } = {}): ViewerSystem {
  return {
    supported: () => options.supported ?? true,
    foreground: async (pane) => pane === "p1" ? [100] : pane === "p2" ? [300] : pane === "p3" ? [400] : [],
    ppid: () => 1, startedAt: () => T0 - 600_000,
    uid: (pid) => pid === 400 ? 1001 : options.uid ?? 1000,
    cmdline: () => undefined,
    environ: () => ({ HOME: "/home/u" }),
    tail: (path) => path === LOG ? log.text : undefined,
    privateFile: () => undefined, privateDir: () => false, realpath: (path) => path,
    myUid: () => 1000,
  };
}

/** a watcher on a fake clock whose polls run when `tick` is awaited */
function harness(options: { isPi?: (pane: string) => boolean; uid?: number; supported?: boolean } = {}) {
  const log = { text: "" };
  let now = T0;
  const ran: { client: string; pane: string; worker: string }[] = [];
  const clients = { a: { name: "a" }, b: { name: "b" } };
  const runs = new GuiViewRuns<{ name: string }>(async (pane) => (options.isPi ?? ((id) => id !== "p2"))(pane), (client, pane, worker) => ran.push({ client: client.name, pane, worker }),
    system(log, options), () => now);
  // fixed wait: one real poll of the watcher's own timer (400 ms) passes, also where nothing must arrive
  const tick = async (ms: number) => { now += ms; await Bun.sleep(ms === 0 ? 5 : Math.min(ms, 450) + 30); };
  return { log, ran, clients, runs, tick, at: () => now, set: (value: number) => { now = value; } };
}

describe("readRuns", () => {
  it("reads one run per client line of the pane's Pi processes, never the krdp start line", () => {
    const text = [
      started(100, "W3", T0), answered(100, "W3", T0 + 5),
      answered(100, "W2", T0 + 90_000, "opened Remmina (snap) (/snap/bin/remmina)"),
      answered(100, "W1", T0 + 95_000, "could not open a client: no RDP client"),
      answered(200, "W9", T0 + 1000), // another Pi's line
      `${new Date(T0).toISOString()} [gui] main pid=100 view W4: viewer stopped`,
      `${new Date(T0).toISOString()} [gui] main pid=100 view ../x: client not opened (bad name)`,
      "garbage",
    ].join("\n");
    const runs = readRuns(system({ text }), new Map([["/home/u/.pi/agent", [100]]]));
    expect(runs).toEqual([{ worker: "W3", at: T0 + 5, piPid: 100 }, { worker: "W2", at: T0 + 90_000, piPid: 100 }, { worker: "W1", at: T0 + 95_000, piPid: 100 }]);
  });
});

describe("GuiViewRuns", () => {
  it("gives the run Pi logs after an Enter to the connection that sent it, once", async () => {
    const h = harness();
    h.log.text = answered(100, "W2", T0 - 60_000); // an earlier run is not this Enter's
    h.runs.entered(h.clients.a, "p1", h.at());
    await h.tick(0);
    expect(h.ran).toEqual([]);
    h.log.text += "\n" + started(100, "W3", h.at() + 300) + "\n" + answered(100, "W3", h.at() + 310);
    await h.tick(400);
    expect(h.ran).toEqual([{ client: "a", pane: "p1", worker: "W3" }]);
    await h.tick(400);
    expect(h.ran.length).toBe(1);
    expect(h.runs.size()).toBe(0);
  });

  it("a run shown again (no new krdp line) counts too, and the newest Enter before it ran it", async () => {
    const h = harness();
    h.runs.entered(h.clients.a, "p1", h.at());
    await h.tick(1000);
    h.runs.entered(h.clients.b, "p1", h.at());
    h.log.text = answered(100, "W3", h.at() + 20);
    await h.tick(400);
    expect(h.ran).toEqual([{ client: "b", pane: "p1", worker: "W3" }]);
  });

  it("a log line from before the Enter, or after its watch, opens nothing", async () => {
    const h = harness();
    const enter = h.at();
    h.log.text = answered(100, "W3", enter - 1000);
    h.runs.entered(h.clients.a, "p1", enter);
    await h.tick(0);
    expect(h.ran).toEqual([]);
    h.set(enter + GUI_VIEW_RUN_MS + 1);
    h.log.text += "\n" + answered(100, "W3", enter + GUI_VIEW_RUN_MS + 1);
    await h.tick(400);
    expect(h.ran).toEqual([]);
    expect(h.runs.size()).toBe(0);
  });

  it("watches only Pi panes, this user's Pi processes, and nothing where processes cannot be read", async () => {
    const shell = harness();
    shell.runs.entered(shell.clients.a, "p2", shell.at());
    await shell.tick(0);
    expect(shell.runs.size()).toBe(0);

    const other = harness({ isPi: () => true });
    other.runs.entered(other.clients.a, "p3", other.at());
    other.log.text = answered(400, "W3", other.at() + 10);
    await other.tick(400);
    expect(other.ran).toEqual([]);

    const unsupported = harness({ supported: false });
    unsupported.runs.entered(unsupported.clients.a, "p1", unsupported.at());
    expect(unsupported.runs.size()).toBe(0);
  });

  it("a closed connection's Enters run nothing", async () => {
    const h = harness();
    h.runs.entered(h.clients.a, "p1", h.at());
    await h.tick(0);
    h.runs.forget(h.clients.a);
    h.log.text = answered(100, "W3", h.at() + 10);
    await h.tick(400);
    expect(h.ran).toEqual([]);
    expect(h.runs.size()).toBe(0);
  });
});
