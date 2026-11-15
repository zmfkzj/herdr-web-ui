import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionTracker } from "../completion.ts";
import { handleMachineRequest } from "../machine-api.ts";
import { MachineManager } from "../machines.ts";
import type { PushService } from "../push.ts";
import type { SetupJob } from "../../shared/machines.ts";

// The Pi visual tools' changes to a PC (installing this server's bundle, its desktop switch) are changes to that PC: the
// owner's, from this app's own page, as every other (machine-owner-guard.test.ts). Opening a pane's desktop is driving
// that PC's pane, not changing it. Isolated state, no PC is reached.
const PC = "00000000-0000-4000-8000-000000000001";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function manager(): MachineManager {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pi-visual-owner-"));
  const reconnect = spyOn(MachineManager.prototype as unknown as { reconnect(): Promise<void> }, "reconnect").mockImplementation(async () => {});
  const made = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
  cleanups.push(() => { made.stop(); reconnect.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  return made;
}
const ask = (pcs: MachineManager, path: string, owner: boolean, body: unknown, headers: Record<string, string> = { "x-herdr-update": "1" }) =>
  handleMachineRequest(new Request(`http://localhost:7317/api/machines/${path}`, { method: "POST", headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    pcs, undefined, undefined, false, undefined, undefined, undefined, undefined, owner);

describe("the Pi visual bridge install route", () => {
  it("passes the feature from the body beside the revision shown, for the owner only", async () => {
    const pcs = manager();
    const update = spyOn(pcs, "updateBridge").mockImplementation(() => ({ id: "job" }) as SetupJob);
    spyOn(pcs, "resolveFor").mockImplementation(async () => {});
    expect((await ask(pcs, `${PC}/update-bridge`, true, { feature: "pi-visual", revision: "r1" })).status).toBe(202);
    expect(update).toHaveBeenLastCalledWith(PC, false, "r1", { feature: "pi-visual" });
    expect((await ask(pcs, `${PC}/update-bridge`, true, {})).status).toBe(202);
    expect(update).toHaveBeenLastCalledWith(PC, false, undefined, {});
    const unknown = await ask(pcs, `${PC}/update-bridge`, true, { feature: "other" });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe("invalid_feature");
    // never anyone else's, nor without the update header, nor with a query
    expect((await ask(pcs, `${PC}/update-bridge`, false, { feature: "pi-visual" })).status).toBe(403);
    expect((await ask(pcs, `${PC}/update-bridge`, true, { feature: "pi-visual" }, {})).status).toBe(403);
    expect((await ask(pcs, `${PC}/update-bridge?feature=pi-visual`, true, {})).status).toBe(403);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("turns a PC's desktop viewing on or off for the owner only", async () => {
    const pcs = manager();
    const set = spyOn(pcs, "setDesktop").mockImplementation((_id, enabled) => ({ enabled }));
    expect((await ask(pcs, `${PC}/pi-desktop`, false, { enabled: true })).status).toBe(403);
    expect((await ask(pcs, `${PC}/pi-desktop`, true, { enabled: true }, {})).status).toBe(403);
    expect(set).not.toHaveBeenCalled();
    expect((await ask(pcs, `${PC}/pi-desktop`, true, { enabled: true })).status).toBe(200);
    expect(set).toHaveBeenLastCalledWith(PC, true);
  });

  it("leaves a pane's desktop to the PC's own rules, not the owner's guard", async () => {
    const pcs = manager();
    // a PC that is not connected answers so: the owner's guard did not refuse it first
    const response = await ask(pcs, `${PC}/pane/pi-visual/desktop?pane_id=p1`, false, {}, {});
    expect(response.status).not.toBe(403);
  });
});
