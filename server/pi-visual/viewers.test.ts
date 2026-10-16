import { describe, expect, it } from "bun:test";
import { discoverViewers, publicViewer, type ViewerSystem } from "./viewers.ts";

/** A self-signed fixture certificate (CN=pi-gui-view-fixture); never a real viewer's. */
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBlDCCATmgAwIBAgIUDrzfFKtig6rD0nBi4H6aZwy6rTYwCgYIKoZIzj0EAwIw
HjEcMBoGA1UEAwwTcGktZ3VpLXZpZXctZml4dHVyZTAgFw0yNjEwMTYwMTE4NDVa
GA8yMTI2MDkyMjAxMTg0NVowHjEcMBoGA1UEAwwTcGktZ3VpLXZpZXctZml4dHVy
ZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABDdGRzLieigcOePvEtWgBfpbrWlc
no9o83PlCHFiVt4lES9RWQtYmCu3JteFI+LJzY9tNpsH1/u5tAuEBRDTV8qjUzBR
MB0GA1UdDgQWBBSd8WgEIG1/yati7R+ENkPm/sq/tTAfBgNVHSMEGDAWgBSd8WgE
IG1/yati7R+ENkPm/sq/tTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kA
MEYCIQDJduyAxjsybwVA+8Jj789qLlBbgqJrkqkvsQ6L/Iz5JAIhAPV9xn7r5GJD
9KbfqIKE/NUjhDDYrl2Bue+3x11/KEYo
-----END CERTIFICATE-----
`;
const FINGERPRINT = "8a459e45dcc4d477454e75f48ceb73c3a04ddf2a326811739cf4441994b63f6d";

interface Proc { ppid: number; uid?: number; start: number; cmdline?: string[]; env?: Record<string, string> }
/** A process table and file system of fixtures: pane p1 runs Pi 100, pane p2 runs Pi 200. */
function system(procs: Record<number, Proc>, files: Record<string, string>, options: { foreground?: Record<string, number[]>; dirs?: string[] } = {}): ViewerSystem {
  return {
    supported: () => true,
    foreground: async (pane) => options.foreground?.[pane] ?? (pane === "p1" ? [100] : pane === "p2" ? [200] : []),
    ppid: (pid) => procs[pid]?.ppid,
    startedAt: (pid) => procs[pid]?.start,
    uid: (pid) => procs[pid] ? procs[pid]!.uid ?? 1000 : undefined,
    cmdline: (pid) => procs[pid]?.cmdline,
    environ: (pid) => procs[pid]?.env,
    tail: (path) => files[path],
    privateFile: (path) => files[path] === undefined ? undefined : Buffer.from(files[path]!),
    privateDir: (path) => (options.dirs ?? ["/tmp/computer-use-mcp-isolated-aaaaaa", "/tmp/computer-use-mcp-isolated-bbbbbb"]).includes(path),
    realpath: (path) => path,
    myUid: () => 1000,
  };
}
const T0 = Date.parse("2026-10-16T01:00:00.000Z");
const line = (pi: number, worker: string, krdp: number, port: number, display = "wayland-virtual-7", at = T0) =>
  `${new Date(at).toISOString()} [gui] main pid=${pi} view ${worker}: krdp pid ${krdp} listening on 127.0.0.1:${port} for ${display}`;
const krdp = (pi: number, port: number, dir = "/tmp/computer-use-mcp-isolated-aaaaaa", display = "wayland-virtual-7", start = T0 - 2000, password = "fixture-pass"): Proc => ({
  ppid: pi, start,
  cmdline: ["/usr/bin/krdpserver", "--username=pi", `--password=${password}`, "--address=127.0.0.1", `--port=${port}`, `--certificate=${dir}/pi-gui-view-x/tls.crt`, `--certificate-key=${dir}/pi-gui-view-x/tls.key`],
  env: { XDG_RUNTIME_DIR: dir, WAYLAND_DISPLAY: display },
});
const pi = (home = "/home/u", start = T0 - 600_000): Proc => ({ ppid: 1, start, env: { HOME: home } });

describe("pi-gui viewer discovery", () => {
  it("finds the viewer a pane's own Pi process started, with its pinned certificate and password kept server-side", async () => {
    const found = await discoverViewers("p1", system({ 100: pi(), 300: krdp(100, 3390) }, {
      "/home/u/.pi/agent/gui.log": `${line(100, "W1", 300, 3390)}\n`, "/tmp/computer-use-mcp-isolated-aaaaaa/pi-gui-view-x/tls.crt": FIXTURE_CERT,
    }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ worker: "W1", port: 3390, pid: 300, display: "wayland-virtual-7", fingerprint: FINGERPRINT, password: "fixture-pass", startedAt: T0 });
    expect(JSON.stringify(publicViewer(found[0]!))).not.toContain("fixture-pass");
  });

  it("keeps two panes with the same worker names apart: each sees only its Pi's viewers", async () => {
    const procs = { 100: pi(), 200: pi(), 300: krdp(100, 3390), 400: krdp(200, 3391, "/tmp/computer-use-mcp-isolated-bbbbbb", "wayland-virtual-9") };
    const files = {
      "/home/u/.pi/agent/gui.log": [line(100, "W1", 300, 3390), line(200, "W1", 400, 3391, "wayland-virtual-9")].join("\n"),
      "/tmp/computer-use-mcp-isolated-aaaaaa/pi-gui-view-x/tls.crt": FIXTURE_CERT, "/tmp/computer-use-mcp-isolated-bbbbbb/pi-gui-view-x/tls.crt": FIXTURE_CERT,
    };
    expect((await discoverViewers("p1", system(procs, files))).map((v) => [v.worker, v.port])).toEqual([["W1", 3390]]);
    expect((await discoverViewers("p2", system(procs, files))).map((v) => [v.worker, v.port])).toEqual([["W1", 3391]]);
    expect(await discoverViewers("p3", system(procs, files))).toEqual([]);
  });

  it("refuses orphaned, reused, foreign and non-loopback viewers", async () => {
    const cert = { "/tmp/computer-use-mcp-isolated-aaaaaa/pi-gui-view-x/tls.crt": FIXTURE_CERT };
    const log = { "/home/u/.pi/agent/gui.log": line(100, "W1", 300, 3390) };
    const check = async (proc: Proc, extra: Record<string, string> = {}) => discoverViewers("p1", system({ 100: pi(), 300: proc }, { ...log, ...cert, ...extra }));
    // the viewer outlived its Pi (reparented), or the pid now belongs to a process started after the line
    expect(await check({ ...krdp(100, 3390), ppid: 1 })).toEqual([]);
    expect(await check({ ...krdp(100, 3390), start: T0 + 60_000 })).toEqual([]);
    expect(await check({ ...krdp(100, 3390), uid: 0 })).toEqual([]);
    expect(await check({ ...krdp(100, 3390), cmdline: krdp(100, 3390).cmdline!.map((arg) => arg === "--address=127.0.0.1" ? "--address=0.0.0.0" : arg) })).toEqual([]);
    expect(await check({ ...krdp(100, 3391) })).toEqual([]);
    expect(await check({ ...krdp(100, 3390), env: { XDG_RUNTIME_DIR: "/tmp/computer-use-mcp-isolated-aaaaaa", WAYLAND_DISPLAY: "wayland-0" } })).toEqual([]);
    // a certificate outside the viewer's private runtime directory is not its own
    expect(await check({ ...krdp(100, 3390), cmdline: krdp(100, 3390).cmdline!.map((arg) => arg.startsWith("--certificate=") ? "--certificate=/home/u/tls.crt" : arg) }, { "/home/u/tls.crt": FIXTURE_CERT })).toEqual([]);
    expect(await discoverViewers("p1", system({ 100: pi(), 300: krdp(100, 3390) }, { ...log, ...cert }, { dirs: [] }))).toEqual([]);
    // a Pi process started after the viewer cannot be its parent
    expect(await discoverViewers("p1", system({ 100: pi("/home/u", T0), 300: krdp(100, 3390) }, { ...log, ...cert }))).toEqual([]);
  });

  it("takes the latest line per desktop across a rotated log, and the Pi process's own agent dir", async () => {
    const procs = { 100: { ...pi(), env: { HOME: "/home/u", PI_CODING_AGENT_DIR: "~/custom-agent" } }, 300: krdp(100, 3390, undefined, undefined, T0 - 2000), 301: krdp(100, 3392, undefined, undefined, T0 + 8000) };
    const found = await discoverViewers("p1", system(procs, {
      "/home/u/custom-agent/gui.log.1": line(100, "W1", 300, 3390),
      "/home/u/custom-agent/gui.log": `noise\n${line(100, "W1", 301, 3392, undefined, T0 + 10_000)}\n${line(100, "main", 300, 3390)}`,
      "/home/u/.pi/agent/gui.log": line(100, "W2", 300, 3390),
      "/tmp/computer-use-mcp-isolated-aaaaaa/pi-gui-view-x/tls.crt": FIXTURE_CERT,
    }));
    expect(found.map((v) => [v.worker, v.pid, v.port])).toEqual([["main", 300, 3390], ["W1", 301, 3392]]);
  });

  it("finds nothing where the OS has no /proc", async () => {
    expect(await discoverViewers("p1", { ...system({}, {}), supported: () => false })).toEqual([]);
  });
});
