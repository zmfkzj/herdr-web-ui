import { describe, expect, it } from "bun:test";
import { GuiViewGrants, GuiViewTyping, GUI_VIEW_GRANT_MS, RelayedGuiViews, type GrantOrigin } from "./grants.ts";

const A: GrantOrigin = { binding: "browser-a", deviceId: "device-a", machine: "pc-1" };

describe("/gui view grants", () => {
  it("lets only the browser that ran the command open what it named, on that PC's pane, for a while", () => {
    let now = 0;
    const grants = new GuiViewGrants(() => now);
    expect(grants.observe(A, "p1", "/gui view w1")).toBe(true);
    expect(grants.observe(A, "p1", "hello")).toBe(false);
    // the name as typed: which viewer it means is the PC's to resolve (exact first, as pi-gui does)
    expect(grants.find(A, "p1", "W1")?.worker).toBe("w1");
    expect(grants.find(A, "p1", "w1")?.worker).toBe("w1");
    for (const [origin, pane, worker] of [[{ ...A, binding: "browser-b" }, "p1", "W1"], [{ ...A, machine: "pc-2" }, "p1", "W1"], [{ ...A, machine: "local" }, "p1", "W1"], [A, "p2", "W1"], [A, "p1", "W2"]] as const) {
      expect(grants.find(origin, pane, worker)).toBeUndefined();
    }
    now = GUI_VIEW_GRANT_MS - 1;
    expect(grants.find(A, "p1", "W1")).toBeDefined();
    now = GUI_VIEW_GRANT_MS;
    expect(grants.find(A, "p1", "W1")).toBeUndefined();
  });
  it("is used once, and a command without a name may open any desktop the PC finds started since", () => {
    const grants = new GuiViewGrants(() => 5);
    grants.observe(A, "p1", "/gui view");
    const grant = grants.find(A, "p1", "W3-2")!;
    expect(grant).toMatchObject({ worker: null, at: 5 });
    grants.take(grant);
    expect(grants.find(A, "p1", "W3-2")).toBeUndefined();
  });
  it("belongs to the bridge connection it was made on: a reconnect leaves it behind", () => {
    const first = {}, second = {};
    const grants = new GuiViewGrants();
    grants.observe({ ...A, connection: first }, "p1", "/gui view W1");
    expect(grants.find({ ...A, connection: first }, "p1", "W1")).toBeDefined();
    expect(grants.find({ ...A, connection: second }, "p1", "W1")).toBeUndefined();
    expect(grants.find(A, "p1", "W1")).toBeUndefined();
  });
  it("goes with a revoked device, and with typing the pane refused", () => {
    let now = 100;
    const grants = new GuiViewGrants(() => now);
    grants.observe(A, "p1", "/gui view W1");
    grants.observe({ ...A, binding: "browser-b", deviceId: "device-b" }, "p1", "/gui view W1");
    grants.forget((grant) => grant.deviceId === "device-a");
    expect(grants.find(A, "p1", "W1")).toBeUndefined();
    expect(grants.find({ ...A, binding: "browser-b", deviceId: "device-b" }, "p1", "W1")).toBeDefined();
    now = 200;
    grants.observe(A, "p1", "/gui view W2");
    grants.withdraw(A, "p1", 150);
    expect(grants.find(A, "p1", "W2")).toBeUndefined();
  });
});

describe("/gui view typed into a terminal", () => {
  it("grants on the Enter of an accepted line, per pane, only while the connection may type", () => {
    const grants = new GuiViewGrants();
    let origin: GrantOrigin | null = A;
    const typing = new GuiViewTyping(grants, () => origin);
    typing.input("p1", "/gui view W1");
    typing.input("p2", "/gui vi");
    expect(grants.count()).toBe(0);
    typing.input("p1", "\r");
    expect(grants.find(A, "p1", "W1")).toBeDefined();
    expect(grants.find(A, "p2", "W1")).toBeUndefined();
    // an arrow key frame: the line is no longer known
    typing.input("p2", "ew W2"); typing.keys("p2"); typing.input("p2", "\r");
    expect(grants.find(A, "p2", "W2")).toBeUndefined();
    // observing (or a revoked connection): nothing it types grants
    origin = null;
    typing.input("p1", "/gui view W3\r");
    expect(grants.find(A, "p1", "W3")).toBeUndefined();
    // a detach or role change forgets the half-typed line
    origin = A;
    typing.input("p1", "/gui view W4"); typing.reset("p1"); typing.input("p1", "\r");
    expect(grants.find(A, "p1", "W4")).toBeUndefined();
  });
});

describe("/gui view through a relayed PC socket", () => {
  const frame = (value: unknown) => JSON.stringify(value);
  it("grants typing the PC took, and takes back what it refused", () => {
    let now = 1000;
    const grants = new GuiViewGrants(() => now);
    const connection = {};
    const origin = { ...A, connection };
    const relayed = new RelayedGuiViews(grants, origin, false, () => now);
    relayed.client(frame({ type: "input", pane_id: "p1", text: "/gui view W1\r" }));
    expect(grants.find(origin, "p1", "W1")).toBeDefined();
    // the PC answers that the pane was not ready: nothing ran
    relayed.server(frame({ type: "error", code: "input_not_ready", message: "x", pane_id: "p1" }));
    expect(grants.find(origin, "p1", "W1")).toBeUndefined();
    // observe mode, then interact again
    relayed.client(frame({ type: "role", mode: "observe" }));
    relayed.client(frame({ type: "input", pane_id: "p1", text: "/gui view W2\r" }));
    expect(grants.find(origin, "p1", "W2")).toBeUndefined();
    relayed.client(frame({ type: "role", mode: "interact" }));
    relayed.client(frame({ type: "input", pane_id: "p1", text: "/gui view W2\r" }));
    expect(grants.find(origin, "p1", "W2")).toBeDefined();
    // a refusal without a pane (observe mode on the PC) takes back what was just granted
    now += 1000;
    relayed.server(frame({ type: "error", code: "read_only", message: "x" }));
    expect(grants.find(origin, "p1", "W2")).toBeUndefined();
  });
  it("grants a submit only when the PC says it typed it now", () => {
    const grants = new GuiViewGrants();
    const origin = { ...A, connection: {} };
    const relayed = new RelayedGuiViews(grants, origin, false);
    relayed.client(frame({ type: "submit", id: 1, pane_id: "p1", text: "/gui view W1", payload: "" }));
    expect(grants.find(origin, "p1", "W1")).toBeUndefined();
    relayed.server(frame({ type: "submit-result", id: 1, pane_id: "p1", ok: false, code: "agent_blocked" }));
    expect(grants.find(origin, "p1", "W1")).toBeUndefined();
    relayed.client(frame({ type: "submit", id: 2, pane_id: "p1", text: "/gui view W1", payload: "", delivery: "queue" }));
    relayed.server(frame({ type: "submit-result", id: 2, pane_id: "p1", ok: true, pending: { id: "x" } }));
    expect(grants.find(origin, "p1", "W1")).toBeUndefined();
    relayed.client(frame({ type: "submit", id: 3, pane_id: "p1", text: "/gui view W1", payload: "" }));
    relayed.server(frame({ type: "submit-result", id: 3, pane_id: "p2", ok: true }));
    expect(grants.find(origin, "p1", "W1")).toBeUndefined();
    relayed.client(frame({ type: "submit", id: 4, pane_id: "p1", text: "/gui view W1", payload: "" }));
    relayed.server(frame({ type: "submit-result", id: 4, pane_id: "p1", ok: true }));
    expect(grants.find(origin, "p1", "W1")).toBeDefined();
  });
  it("grants nothing for a watch device", () => {
    const grants = new GuiViewGrants();
    const relayed = new RelayedGuiViews(grants, A, true);
    relayed.client(frame({ type: "input", pane_id: "p1", text: "/gui view W1\r" }));
    expect(grants.count()).toBe(0);
  });
});
