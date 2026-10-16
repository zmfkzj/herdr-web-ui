import { describe, expect, it } from "bun:test";
import { completionConflict, guiViewCommand, resolveViewer, TypedLine, type PiGuiViewer } from "./pi-visual.ts";

describe("/gui view commands and pi-gui names", () => {
  const viewers: PiGuiViewer[] = [
    { worker: "main", port: 1, display: "d", pid: 2, startedAt: 10, fingerprint: "" },
    { worker: "W1", port: 1, display: "d", pid: 3, startedAt: 20, fingerprint: "" },
    { worker: "W3-2", port: 1, display: "d", pid: 4, startedAt: 30, fingerprint: "" },
  ];
  it("reads the command the way pi-gui's handler splits it", () => {
    expect(guiViewCommand("/gui view W1")).toEqual({ worker: "W1" });
    expect(guiViewCommand("  /gui   view   main  extra")).toEqual({ worker: "main" });
    expect(guiViewCommand("/gui view")).toEqual({ worker: null });
    expect(guiViewCommand("/gui view W3-2")).toEqual({ worker: "W3-2" });
    for (const text of ["/gui view list", "/gui view stop W1", "/gui view stop", "/gui status", "gui view W1", "/gui viewW1", "/gui view W1\nmore", "/GUI view W1", ""]) expect(guiViewCommand(text)).toBeNull();
  });
  it("resolves exact, then case-insensitive names, and fails clearly otherwise", () => {
    expect((resolveViewer(viewers, "W1") as { viewer: PiGuiViewer }).viewer.pid).toBe(3);
    expect((resolveViewer(viewers, "w3-2") as { viewer: PiGuiViewer }).viewer.pid).toBe(4);
    expect(resolveViewer(viewers, "W9")).toMatchObject({ error: "viewer_missing" });
    for (const bad of ["../W1", "W 1", "", "-W1", "x".repeat(65)]) expect(resolveViewer(viewers, bad)).toMatchObject({ error: "invalid_worker" });
    // pi-gui's own registry: the exact name first, so W1 and w1 stay two desktops
    const both = [...viewers, { ...viewers[1]!, worker: "w1", pid: 9 }];
    expect(resolveViewer(both, "W1")).toMatchObject({ viewer: { pid: 3 } });
    expect(resolveViewer(both, "w1")).toMatchObject({ viewer: { pid: 9 } });
    // two only case-insensitively: ambiguous, never the first
    expect(resolveViewer([{ ...viewers[1]!, worker: "Wa" }, { ...viewers[1]!, worker: "wA", pid: 9 }], "WA")).toMatchObject({ error: "viewer_ambiguous" });
  });
  it("without a name, takes only the one viewer started since the command", () => {
    expect(resolveViewer(viewers, null, 25)).toMatchObject({ viewer: { worker: "W3-2" } });
    expect(resolveViewer(viewers, null, 15)).toMatchObject({ error: "viewer_ambiguous" });
    expect(resolveViewer(viewers, null, 40)).toMatchObject({ error: "viewer_missing" });
    expect(resolveViewer(viewers, null)).toMatchObject({ error: "viewer_missing" });
  });
  it("knows the longer names Pi's completion list offers for a typed one", () => {
    expect(completionConflict("W1", ["main", "W1", "W2"])).toBeNull();
    expect(completionConflict("W1", ["main", "W1", "W10"])).toBe("W10");
    expect(completionConflict("W1", ["W1-2", "W1"])).toBe("W1-2");
    // pi-gui filters case-sensitively
    expect(completionConflict("w1", ["W10"])).toBeNull();
  });
});

describe("a line typed straight into Pi's editor", () => {
  const typed = (...frames: string[]) => { const line = new TypedLine(); return frames.flatMap((frame) => line.feed(frame)); };
  it("submits /gui view on Enter, key by key or in one frame", () => {
    expect(typed(..."/gui view W1\r".split(""))).toEqual([{ worker: "W1", completing: true }]);
    expect(typed("/gui view W1\r")).toEqual([{ worker: "W1", completing: true }]);
    // Esc closes the completion list before Enter: the typed name is what runs
    expect(typed("/gui view W1", "\x1b", "\r")).toEqual([{ worker: "W1", completing: false }]);
    expect(typed("/gui view\r")).toEqual([{ worker: null, completing: true }]);
    // two lines in one frame, the second a command
    expect(typed("hello\r/gui view main\r")).toEqual([{ worker: "main", completing: true }]);
    expect(typed("/gui view list\r", "/gui view stop W1\r", "/gui status\r", "hello\r")).toEqual([]);
  });
  it("follows Backspace, ←, →, Home, End and Delete", () => {
    expect(typed("/gui view W2", "\x7f", "1\r")).toEqual([{ worker: "W1", completing: true }]);
    expect(typed("/gui view 1", "\x1b[D", "W", "\x1b[C", "\r")).toEqual([{ worker: "W1", completing: true }]);
    expect(typed("gui view W1", "\x1b[H", "/", "\x1b[F", "\r")).toEqual([{ worker: "W1", completing: true }]);
    expect(typed("/gui view XW1", "\x01", "\x1b[C".repeat(10), "\x1b[3~", "\x05\r")).toEqual([{ worker: "W1", completing: true }]);
    expect(typed("/gui view W21", "\x1bOD", "\x7f", "\r")).toEqual([{ worker: "W1", completing: true }]);
    // an edit that breaks the command breaks it
    expect(typed("/gui view W1", "\x1b[D", "\x1b[D", "\x7f", "\r")).toEqual([]);
  });
  it("takes a one-line paste as typed text, a multi-line one as unknown", () => {
    expect(typed("\x1b[200~/gui view W1\x1b[201~", "\x1b", "\r")).toEqual([{ worker: "W1", completing: false }]);
    // split across frames
    expect(typed("\x1b[200~/gui vi", "ew W1\x1b[2", "01~\r")).toEqual([{ worker: "W1", completing: true }]);
    expect(typed("\x1b[200~/gui view W1\rmore\x1b[201~\r")).toEqual([]);
  });
  it("passes over mouse and focus reports, which Pi's editor takes no text from", () => {
    expect(typed("\x1b[<0;73;21M", "\x1b[<0;73;21m", "/gui view W1", "\x1b[I", "\x1b[O", "\x1b[M #!", "\r")).toEqual([{ worker: "W1", completing: true }]);
  });
  it("names nothing after a key it cannot follow, until the next line", () => {
    // ↑: history or the completion list's choice; Tab: a completion; a word motion; a modified Enter
    for (const key of ["\x1b[A", "\x1b[B", "\t", "\x1bb", "\x17", "\x1b[13;2u", "\x1b\r", "\n"]) {
      expect(typed("/gui view W1", key, "\r")).toEqual([]);
    }
    const line = new TypedLine();
    line.feed("/gui view W1"); line.lose();
    expect(line.feed("\r")).toEqual([]);
    expect(line.feed("/gui view W2\r")).toEqual([{ worker: "W2", completing: true }]);
  });
  it("empties the line on Ctrl+C or Ctrl+U at its end, as Pi's editor does", () => {
    expect(typed("garbage", "\x03", "/gui view W1\r")).toEqual([{ worker: "W1", completing: true }]);
    expect(typed("garbage", "\x15", "/gui view W1\r")).toEqual([{ worker: "W1", completing: true }]);
    // Ctrl+U in the middle deletes only to the line start: not followed
    expect(typed("/gui view W1", "\x1b[D", "\x15", "\r")).toEqual([]);
  });
  it("is not fooled by a command inside other text", () => {
    expect(typed("echo /gui view W1\r")).toEqual([]);
    expect(typed("/gui view W1 now\r")).toEqual([{ worker: "W1", completing: true }]);
  });
});
