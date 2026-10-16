import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type SetupJob } from "../shared/machines.ts";
import type { PiVisualBridge } from "../shared/pi-visual.ts";
import { MachineManager } from "./machines.ts";
import { posixHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";
import { CompletionTracker } from "./completion.ts";
import type { PushService } from "./push.ts";

interface Options {
  /** what /api/bridge says about pi_visual: the running bridge (pid 4242), and one started after it */
  current?: PiVisualBridge | null;
  /** `"env"`: a started bridge reports desktop viewing as its start command set it */
  replacement?: PiVisualBridge | null | "env";
  bundleRefuses?: boolean;
  managed?: boolean;
}
interface Context { manager: MachineManager; id: string; operations: string[]; starts: string[]; dir: string; until(id: string): Promise<SetupJob>; restart(): MachineManager }

// A PC whose bridge has this app's version but may come from upstream's bundle (no pi_visual in
// /api/bridge): connect, terminals work, and only a deliberate update or desktop activation replaces
// it. A fake SSH host and a loopback identity endpoint; nothing is downloaded or really stopped.
async function scenario<T>(options: Options, act: (context: Context) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "herdr-pi-visual-update-"));
  const socket = "/home/fixture/.config/herdr/herdr.sock";
  const token = "b".repeat(64);
  let descriptor = { pid: 4242, port: 29432, token, socket_path: socket, managed_remote: options.managed !== false, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION };
  let stopped = false;
  const operations: string[] = [], starts: string[] = [];
  let startedWithDesktop = false;
  const relays: ReturnType<typeof Bun.serve>[] = [];
  const managers: MachineManager[] = [];
  const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close, forward: SshConnection.prototype.forward };
  const install = spyOn(posixHost, "installBundle").mockImplementation(async (_ssh, _platform, _signal, installOptions) => {
    operations.push(`install:${installOptions?.feature ?? "-"}`);
    if (options.bundleRefuses) throw new Error("The bridge bundle this web server installs (the published upstream release) does not include pi-visual.");
  });
  const create = () => { const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null)); managers.push(manager); return manager; };
  const manager = create();
  const until = async (id: string) => {
    for (const deadline = Date.now() + 3000;;) {
      const job = manager.job(id)!;
      if (["connected", "failed"].includes(job.phase)) return job;
      if (Date.now() >= deadline) throw new Error(`Setup stuck in ${job.phase}: ${job.error}`);
      await Bun.sleep(10);
    }
  };
  try {
    SshConnection.prototype.start = async () => {};
    SshConnection.prototype.close = () => {};
    SshConnection.prototype.run = async (script: string) => {
      if (script.includes("uname")) return `Linux\nx86_64\n/home/fixture\n/home/fixture/.config\n/usr/bin/herdr\nbundle-ready\n${JSON.stringify(descriptor)}\n`;
      if (script.includes("socket=")) return socket;
      if (script.includes("--version")) return "herdr 0.9.3";
      if (script.includes("kill -0")) return stopped && script.includes("4242") ? "" : "live";
      if (script === "kill -TERM 4242") { operations.push("stop:4242"); stopped = true; return ""; }
      if (script.includes("nohup")) {
        operations.push("start"); starts.push(script);
        startedWithDesktop = script.includes("HERDR_PI_GUACD_ENABLED=1 ");
        descriptor = { ...descriptor, pid: 4243 }; return "";
      }
      if (script.includes('for f in "$HOME/.config/herdr-web-ui/bridges/"')) return JSON.stringify(descriptor);
      throw new Error(`Unexpected remote command: ${script}`);
    };
    SshConnection.prototype.forward = async (local: number, _remote: number) => {
      relays.push(Bun.serve({ hostname: "127.0.0.1", port: local,
        fetch(request, server) {
          if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });
          const path = new URL(request.url).pathname;
          if (path === "/api/bridge") {
            operations.push(`verify:${descriptor.pid}`);
            const reported = descriptor.pid === 4242 ? options.current : options.replacement === "env" ? { protocol: 1, desktop: startedWithDesktop } : options.replacement;
            return new Response(JSON.stringify({ ...descriptor, socket_id: "fixture:1", herdr: { version: "0.9.3", protocol: 22 }, ...(reported ? { pi_visual: reported } : {}) }), { headers: { "content-type": "application/json" } });
          }
          if (path === "/api/session") return new Response(JSON.stringify({ snapshot: { panes: [], workspaces: [] } }), { headers: { "content-type": "application/json" } });
          if (path === "/ws" && server.upgrade(request, { data: undefined })) return;
          return new Response("not found", { status: 404 });
        }, websocket: { message() {} },
      }));
    };
    const first = await until(manager.setup({ destination: "fixture-only" }).id);
    expect(first.phase).toBe("connected");
    return await act({ manager, id: first.machine_id, operations, starts, dir, until, restart: create });
  } finally {
    for (const item of managers) item.stop();
    Object.assign(SshConnection.prototype, real);
    install.mockRestore();
    for (const relay of relays) relay.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("installing the Pi visual bridge", () => {
  it("connects an upstream bridge of the same version for terminals, then replaces it only on the deliberate update", async () => {
    await scenario({ current: null, replacement: { protocol: 1 } }, async ({ manager, id, operations, starts, until }) => {
      expect(manager.piVisual(id)).toBeNull(); expect(manager.endpoint(id)).toBeDefined();
      const before = operations.length;
      // the plain Update bridge of a current bridge is a no-op, as before
      expect((await until(manager.updateBridge(id).id)).phase).toBe("connected");
      expect(operations.slice(before)).toEqual(["verify:4242"]);
      const update = await until(manager.updateBridge(id, false, "pi-visual").id);
      expect(update.phase).toBe("connected");
      expect(operations.slice(-5)).toEqual(["install:pi-visual", "verify:4242", "stop:4242", "start", "verify:4243"]);
      expect(manager.piVisual(id)).toEqual({ protocol: 1 });
      // nothing turned desktop viewing on: the bridge is told off, explicitly
      expect(starts.at(-1)).toContain("HERDR_PI_GUACD_ENABLED=0 ");
      expect(manager.piDesktop(id)).toBe(false);
    });
  });
  it("leaves a bridge that already serves the tools running", async () => {
    await scenario({ current: { protocol: 1 } }, async ({ manager, id, operations, until }) => {
      expect((await until(manager.updateBridge(id, false, "pi-visual").id)).phase).toBe("connected");
      expect(operations.some((step) => step.startsWith("install") || step.startsWith("stop:"))).toBe(false);
      expect(manager.piVisual(id)).toEqual({ protocol: 1 });
    });
  });
  it("replaces a bridge whose Pi visual routes are of another protocol", async () => {
    await scenario({ current: { protocol: 99 }, replacement: { protocol: 1 } }, async ({ manager, id, operations, until }) => {
      expect((await until(manager.updateBridge(id, false, "pi-visual").id)).phase).toBe("connected");
      expect(operations).toContain("install:pi-visual");
      expect(manager.piVisual(id)).toEqual({ protocol: 1 });
    });
  });
  it("stops nothing when this server's bundle lacks the tools", async () => {
    await scenario({ current: null, bundleRefuses: true }, async ({ manager, id, operations, until }) => {
      const update = await until(manager.updateBridge(id, false, "pi-visual").id);
      expect(update.phase).toBe("failed");
      expect(update.error).toContain("does not include pi-visual");
      expect(operations.some((step) => step.startsWith("stop:") || step === "start")).toBe(false);
    });
  });
  it("does not call it a success when the new bridge does not serve the tools", async () => {
    await scenario({ current: null, replacement: null }, async ({ manager, id, until }) => {
      const update = await until(manager.updateBridge(id, false, "pi-visual").id);
      expect(update.phase).toBe("failed");
      expect(update.error).toContain("does not serve this server's Pi visual tools");
    });
  });
});

describe("turning Pi desktop viewing on for a PC", () => {
  it("is off until the user turns it on, then restarts the bridge with it and keeps the choice", async () => {
    await scenario({ current: { protocol: 1, desktop: false }, replacement: "env" }, async ({ manager, id, operations, starts, until, restart }) => {
      expect(manager.piDesktop(id)).toBe(false);
      const outcome = manager.setDesktop(id, true);
      expect("job" in outcome).toBe(true);
      const job = await until((outcome as { job: SetupJob }).job.id);
      expect(job.phase).toBe("connected");
      // the bundle already serves the routes: a restart, no download
      expect(operations.slice(-4)).toEqual(["verify:4242", "stop:4242", "start", "verify:4243"]);
      expect(operations.some((step) => step.startsWith("install"))).toBe(false);
      expect(starts.at(-1)).toContain("HERDR_PI_GUACD_ENABLED=1 ");
      expect(manager.piDesktop(id)).toBe(true);
      expect(manager.list().find((machine) => machine.id === id)?.pi_desktop).toBe(true);
      // the choice outlives this server: another manager on the same state reads it
      const later = restart();
      expect((later as unknown as { consented(runtime: unknown): boolean }).consented((later as unknown as { machines: Map<string, unknown> }).machines.get(id))).toBe(true);
      // turning it off takes effect here at once
      expect(manager.setDesktop(id, false)).toEqual({ enabled: false });
      expect(manager.piDesktop(id)).toBe(false);
    });
  });
  it("installs this server's Pi visual bundle first on a bridge without the routes", async () => {
    await scenario({ current: null, replacement: "env" }, async ({ manager, id, operations, starts, until }) => {
      const job = await until((manager.setDesktop(id, true) as { job: SetupJob }).job.id);
      expect(job.phase).toBe("connected");
      expect(operations).toContain("install:pi-visual");
      expect(starts.at(-1)).toContain("HERDR_PI_GUACD_ENABLED=1 ");
      expect(manager.piDesktop(id)).toBe(true);
    });
  });
  it("records nothing when the new bridge still runs without it", async () => {
    await scenario({ current: { protocol: 1, desktop: false }, replacement: { protocol: 1, desktop: false } }, async ({ manager, id, until }) => {
      const job = await until((manager.setDesktop(id, true) as { job: SetupJob }).job.id);
      expect(job.phase).toBe("failed");
      expect(job.error).toContain("still runs with Pi desktop viewing off");
      expect(manager.piDesktop(id)).toBe(false);
    });
  });
  it("never restarts a bridge managed elsewhere, and says what to do there", async () => {
    await scenario({ current: { protocol: 1, desktop: false }, managed: false }, async ({ manager, id, operations, until }) => {
      const job = await until((manager.setDesktop(id, true) as { job: SetupJob }).job.id);
      expect(job.phase).toBe("failed");
      expect(job.error).toContain("HERDR_PI_GUACD_ENABLED=1");
      expect(operations.some((step) => step.startsWith("stop:") || step === "start")).toBe(false);
      expect(manager.piDesktop(id)).toBe(false);
    });
  });
  it("takes a bridge already started with it on as it is", async () => {
    await scenario({ current: { protocol: 1, desktop: true }, managed: false }, async ({ manager, id, operations }) => {
      const before = operations.length;
      expect(manager.setDesktop(id, true)).toEqual({ enabled: true });
      expect(operations.slice(before)).toEqual([]);
      expect(manager.piDesktop(id)).toBe(true);
    });
  });
  it("is dropped with the PC", async () => {
    await scenario({ current: { protocol: 1, desktop: true } }, async ({ manager, id, restart }) => {
      manager.setDesktop(id, true);
      manager.remove(id);
      const later = restart();
      expect(later.piDesktop(id)).toBe(false);
      expect((later as unknown as { readConsent(): Record<string, string> }).readConsent()).toEqual({});
    });
  });
});
