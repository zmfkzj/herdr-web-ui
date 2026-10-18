import { afterAll, beforeAll, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createServer } from "./index.ts";
import { forgetPiModels } from "./pi-models.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// Real herdr metadata + HTTP + native files, all under an owned workspace/store.
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-pi-contract-"));
const sessionDir = join(root, ".pi", "agent", "sessions");
const slug = join(sessionDir, `--${root.replaceAll("/", "-")}--`);
const transcript = join(slug, "session.jsonl");
const workspaces: string[] = [];
const fakePi = join(root, "bin", "pi");
let paneId: string;
let server: ReturnType<typeof createServer>;
// herdr keeps one session report per pane and refuses one older than the last.
let seq = Date.now() * 1000;
const nextSeq = () => ++seq;
const reportSession = (path: string, target = paneId) =>
  herdrRpc("pane.report_agent_session", { pane_id: target, source: "herdr:pi", agent: "pi", seq: nextSeq(), agent_session_path: path, session_start_source: "startup" });

const page = (entries: unknown[]) => [
  { type: "session", version: 3, id: "session", timestamp: new Date().toISOString(), cwd: root },
  ...entries,
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

const turns = (prompt: string, answer: string) => page([
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
  { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: [{ type: "text", text: prompt }] } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
    role: "assistant", model: "pi-contract-model", provider: "test", stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0 },
    content: [{ type: "text", text: answer }],
  } },
]);

async function createPiPane(): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-pi-contract" });
  workspaces.push(created.workspace.workspace_id);
  const target = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: target, text: `${fakePi}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === target);
    if (pane?.agent === "pi") break;
    if (Date.now() > deadline) throw new Error("test pi did not start");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: target, source: "herdr:pi", agent: "pi", state: "idle", seq: nextSeq() });
  return target;
}

beforeAll(async () => {
  process.env["PI_CODING_AGENT_SESSION_DIR"] = sessionDir;
  mkdirSync(slug, { recursive: true });
  // herdr takes a session report only from an agent holding the pane: one it detected
  // running there, reporting under its own integration source. A fake pi stands in.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(fakePi, "#!/bin/sh\nsleep 600\n");
  chmodSync(fakePi, 0o755);
  paneId = await createPiPane();
  await reportSession(transcript);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push") });
});

afterAll(async () => {
  server?.stop();
  for (const workspaceId of workspaces) await workspaceClose(workspaceId);
  delete process.env["PI_CODING_AGENT_SESSION_DIR"];
  rmSync(root, { recursive: true, force: true });
});

const read = async (target = paneId): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(target)}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};


it.skipIf(process.platform !== "linux")("serves a fresh Pi session in its pane-owned profile before its first message", async () => {
  const profileDir = join(root, "fictional-pi-profile");
  const profileSessions = join(profileDir, "sessions");
  mkdirSync(profileSessions, { recursive: true });
  const profileBin = join(root, "profile-bin");
  mkdirSync(profileBin, { recursive: true });
  const profilePi = join(profileBin, "pi");
  writeFileSync(profilePi, `#!/bin/bash\nexport PI_CODING_AGENT_DIR='${profileDir}'\nexec -a pi /bin/sleep 600\n`);
  chmodSync(profilePi, 0o755);

  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-pi-custom-profile" });
  workspaces.push(created.workspace.workspace_id);
  const target = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: target, text: `${profilePi}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === target);
    if (pane?.agent === "pi") break;
    if (Date.now() > deadline) throw new Error("custom-profile Pi fixture was not detected");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: target, source: "herdr:pi", agent: "pi", state: "idle", seq: nextSeq() });
  const fresh = join(profileSessions, `--${root.replaceAll("/", "-")}--`, "2026-10-16_fresh.jsonl");
  await reportSession(fresh, target);

  const beforeMessage = await read(target);
  expect(beforeMessage).toMatchObject({ source: "pi-transcript", turns: [], cursor: null, history_id: "unwritten:2026-10-16_fresh" });

  mkdirSync(dirname(fresh), { recursive: true });
  writeFileSync(fresh, turns("Synthetic new profile session", "First response in the profile session"));
  const afterMessage = await read(target);
  expect(afterMessage.source).toBe("pi-transcript");
  expect(afterMessage.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(afterMessage.turns[0]!.parts).toEqual([{ kind: "text", text: "Synthetic new profile session" }]);
});

it("serves a pi pane's native transcript over HTTP", async () => {
  writeFileSync(transcript, turns("Check chat", "Answer one"));
  const first = await read();
  expect(first.source).toBe("pi-transcript");  expect(first.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(first.turns[0]!.parts).toEqual([{ kind: "text", text: "Check chat" }]);
  // the figure pi's own footer shows: input + output + both cache tiers
  // the figure pi's own footer shows: input + output + both cache tiers
  expect(first.metadata).toEqual({ model: "pi-contract-model", reasoning_effort: null, context: { used: 35, window: null } });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

it("offers a tool's own picture over the image endpoint", async () => {
  writeFileSync(transcript, page([
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "open shot.png" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
      role: "assistant", model: "pi-contract-model", provider: "test", stopReason: "toolUse", usage: { input: 4, output: 1 },
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } }],
    } },
    { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-30T00:00:03Z", message: {
      role: "toolResult", toolCallId: "call-1", toolName: "read",
      content: [{ type: "text", text: "read 1 image" }, { type: "image", mimeType: "image/png", data: PNG.toString("base64") }],
    } },
  ]));
  // the tests after this one read the session this file first held, so put it back
  try {
    const conversation = await read();
    const tool = conversation.turns.flatMap((turn) => turn.parts).find((part) => part.kind === "tool");
    expect(tool !== undefined && tool.kind === "tool" && tool.images).toEqual([{ media_type: "image/png", ref: "pi:call-1:0" }]);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?pane_id=${encodeURIComponent(paneId)}&ref=${encodeURIComponent("pi:call-1:0")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    // a ref naming no image, and one that is no pi ref at all
      const miss = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?pane_id=${encodeURIComponent(paneId)}&ref=${encodeURIComponent("pi:call-9:0")}`);
      expect(miss.status).toBe(404);
  } finally {
    writeFileSync(transcript, turns("Check chat", "Answer one"));
  }
});

it("binds a terminal image read to the pane's current pi session (same ref, another session)", async () => {
  const toolImage = (id: string, bytes: Buffer) => [
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: `open ${id}` } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
      role: "assistant", model: "pi-contract-model", provider: "test", stopReason: "toolUse", usage: { input: 4, output: 1 },
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } }],
    } },
    { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-30T00:00:03Z", message: {
      role: "toolResult", toolCallId: "call-1", toolName: "read",
      content: [{ type: "text", text: "read 1 image" }, { type: "image", mimeType: "image/png", data: bytes.toString("base64") }],
    } },
  ];
  const other = Buffer.concat([PNG, Buffer.from("second session")]);
  const second = join(slug, "session-two.jsonl");
  writeFileSync(transcript, page(toolImage("first", PNG)));
  writeFileSync(second, [{ type: "session", version: 3, id: "session-two", timestamp: new Date().toISOString(), cwd: root }, ...toolImage("second", other)].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const digestOf = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 32);
  const image = (session: string, digest = digestOf(PNG), ref = "pi:call-1:0") => fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref, session, digest })}`);
  try {
    const bound = await image("session");
    expect(bound.status).toBe(200);
    expect(bound.headers.get("x-herdr-pi-session")).toBe("session");
    // the answer is about the pane's session now, which can change under the same URL
    expect(bound.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await bound.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await image("session-two")).status).toBe(404);
    // the ref is there, but not the picture the marker drew
    expect((await image("session", digestOf(other))).status).toBe(404);
    expect((await image("bad id!")).status).toBe(400);
    expect((await image("session", "NOT-A-DIGEST")).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: "pi:call-1:0", session: "session" })}`)).status).toBe(400);
    // a session-bound read is a pi tool image or nothing: a Claude-shaped ref is refused
    expect((await image("session", digestOf(PNG), "0123abcd-0000-0000-0000-000000000000:0")).status).toBe(404);
    // the pane moves to another pi session that has the same tool call id: the old marker's
    // session no longer resolves, the new one serves its own bytes
    await reportSession(second);
    expect((await image("session")).status).toBe(404);
    expect((await image("session-two")).status).toBe(404);
    const moved = await image("session-two", digestOf(other));
    expect(moved.status).toBe(200);
    expect(Buffer.from(await moved.arrayBuffer()).equals(other)).toBe(true);
  } finally {
    await reportSession(transcript);
    writeFileSync(transcript, turns("Check chat", "Answer one"));
    rmSync(second, { force: true });
  }
});

it("serves provider-composite tool call ids (call_…|fc_…) to the chat and to a terminal marker, over HTTP", async () => {
  // synthetic ids in the shapes pi stores for OpenAI Responses (`${call_id}|${item id}`) and an
  // Anthropic-style call id behind the same pipe; punctuation RFC 3986 escapes on the wire
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const calls = [
    { id: "call_E2E|fc_0123abcd", type: "image/png", bytes: PNG },
    { id: "toolu_01E2EsyntheticAbCdEf|fc_0123abcd", type: "image/jpeg", bytes: JPEG },
    { id: `call_test|fc_(x)*!'"\\+/=`, type: "image/png", bytes: Buffer.concat([PNG, Buffer.from("punctuated")]) },
  ];
  const long = "z".repeat(6000);
  const entries: unknown[] = [
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "open the pictures" } },
  ];
  calls.forEach((call, index) => {
    entries.push({ type: "message", id: `a${index}`, parentId: index === 0 ? "u1" : `r${index - 1}`, timestamp: "2026-09-30T00:00:02Z", message: {
      role: "assistant", model: "pi-contract-model", provider: "test", stopReason: "toolUse", usage: { input: 4, output: 1 },
      content: [{ type: "toolCall", id: call.id, name: "read", arguments: { path: `shot-${index}` } }],
    } });
    entries.push({ type: "message", id: `r${index}`, parentId: `a${index}`, timestamp: "2026-09-30T00:00:03Z", message: {
      role: "toolResult", toolCallId: call.id, toolName: "read",
      content: [{ type: "text", text: long }, { type: "image", mimeType: call.type, data: call.bytes.toString("base64") }],
    } });
  });
  writeFileSync(transcript, page(entries));
  const digestOf = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 32);
  const get = (path: string, query: Record<string, string>) => fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/${path}?${new URLSearchParams({ pane_id: paneId, ...query })}`);
  try {
    const tools = (await read()).turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
    expect(tools.map((tool) => tool.kind === "tool" && tool.output_ref)).toEqual(calls.map((call) => call.id));
    for (const [index, call] of calls.entries()) {
      const tool = tools[index]!;
      if (tool.kind !== "tool") throw new Error("not a tool");
      // the chat: the page's own refs, sent back exactly as the client sends them
      expect(tool.images).toEqual([{ media_type: call.type, ref: `pi:${call.id}:0` }]);
      const chatImage = await get("image", { ref: tool.images![0]!.ref });
      expect(chatImage.status).toBe(200);
      expect(chatImage.headers.get("content-type")).toBe(call.type);
      expect(Buffer.from(await chatImage.arrayBuffer()).equals(call.bytes)).toBe(true);
      const output = await get("tool-output", { ref: tool.output_ref! });
      expect(output.status).toBe(200);
      expect(await output.text()).toBe(long);
      // a terminal marker's read: bound to the session and the digest of the picture
      const bound = await get("image", { ref: `pi:${call.id}:0`, session: "session", digest: digestOf(call.bytes) });
      expect(bound.status).toBe(200);
      expect(bound.headers.get("x-herdr-pi-session")).toBe("session");
      expect(Buffer.from(await bound.arrayBuffer()).equals(call.bytes)).toBe(true);
      expect((await get("image", { ref: `pi:${call.id}:0`, session: "session-two", digest: digestOf(call.bytes) })).status).toBe(404);
      expect((await get("image", { ref: `pi:${call.id}:0`, session: "session", digest: digestOf(Buffer.from("other")) })).status).toBe(404);
      expect((await get("image", { ref: `pi:${call.id}:1`, session: "session", digest: digestOf(call.bytes) })).status).toBe(404);
    }
    // exact ids only: a part of one, another spelling of its pipe, or an id outside the grammar
    for (const ref of ["pi:call_E2E:0", "pi:fc_0123abcd:0", "pi:call_E2E%7Cfc_0123abcd:0", "pi:call_E2E\n|fc_0123abcd:0", "pi:call_E2E |fc_0123abcd:0"]) {
      expect((await get("image", { ref })).status).toBe(404);
    }
    expect((await get("tool-output", { ref: "call_E2E" })).status).toBe(404);
    expect((await get("tool-output", { ref: "call_E2E|fc_0123abcd\u0000" })).status).toBe(404);
  } finally {
    writeFileSync(transcript, turns("Check chat", "Answer one"));
  }
});

it("serves a pasted picture's file to a terminal marker only, bound to the pi session and the digest of its bytes", async () => {
  writeFileSync(transcript, turns("Check chat", "Answer one"));
  const folder = join(root, ".herdr-web-ui");
  mkdirSync(folder, { recursive: true });
  // what herdr-web-ui's upload names a paste, plus Korean, spaces, `#` and `%` the marker percent-encodes
  const pasted = join(folder, "붙여넣기 #1 100%.png");
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const bytes = Buffer.concat([PNG, Buffer.from("pasted")]);
  writeFileSync(pasted, bytes);
  const digestOf = (value: Buffer) => new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 32);
  const get = (query: Record<string, string>) => fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ...query })}`);
  const bound = (path: string, digest = digestOf(bytes), session = "session") => get({ ref: `file:${path}`, session, digest });
  try {
    const response = await bound(pasted);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-herdr-pi-session")).toBe("session");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    // never by ref alone (the chat's reads), nor for another session or other bytes
    expect((await get({ ref: `file:${pasted}` })).status).toBe(404);
    expect((await bound(pasted, digestOf(bytes), "session-two")).status).toBe(404);
    expect((await bound(pasted, digestOf(PNG))).status).toBe(404);
    // the file changed since pi drew it: the old marker shows nothing, not the new bytes
    writeFileSync(pasted, Buffer.concat([PNG, Buffer.from("edited")]));
    expect((await bound(pasted)).status).toBe(404);
    // typed by its bytes, not its name
    const misnamed = join(folder, "photo.png");
    writeFileSync(misnamed, JPEG);
    const typed = await bound(misnamed, digestOf(JPEG));
    expect(typed.status).toBe(200);
    expect(typed.headers.get("content-type")).toBe("image/jpeg");
    // no image, no file, a folder, a relative or dotted path
    const text = join(folder, "notes.txt");
    writeFileSync(text, "secret");
    expect((await bound(text, digestOf(Buffer.from("secret")))).status).toBe(404);
    expect((await bound(join(folder, "gone.png"))).status).toBe(404);
    expect((await bound(folder)).status).toBe(404);
    expect((await get({ ref: "file:shot.png", session: "session", digest: digestOf(bytes) })).status).toBe(404);
    expect((await bound(`${folder}/../.herdr-web-ui/photo.png`, digestOf(JPEG))).status).toBe(404);
    // past the browser's own bound
    const large = join(folder, "large.png");
    const big = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]);
    writeFileSync(large, big);
    expect((await bound(large, digestOf(big))).status).toBe(404);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

it("resolves pi's context window from the agent dir pi reads its models from", async () => {
  writeFileSync(transcript, turns("Check chat", "Answer one"));
  expect((await read()).metadata?.context?.window).toBeNull();
  // the window is nowhere in the transcript: pi's own catalog is the only disk answer for it
  const agentDir = join(root, "agent-dir");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { test: { models: [{ id: "pi-contract-model", contextWindow: 200_000 }] } } }));
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  try {
    // the window is read as the metadata is rebuilt, so a new answer carries it
    writeFileSync(transcript, turns("Check chat twice", "Answer two"));
    const withWindow = await read();
    expect(withWindow.metadata?.context).toEqual({ used: 35, window: 200_000 });
  } finally {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previous;
    forgetPiModels();
    // the tests after this one read the session this file first held
    writeFileSync(transcript, turns("Check chat", "Answer one"));
  }
});

it("follows the pane to a new session file when /new or /resume replaces it", async () => {  const before = await read();
  const replacement = join(slug, "replacement.jsonl");
  writeFileSync(replacement, turns("New topic", "Answer from the new session"));
  // pi emits no history marker: the integration re-reports the path herdr holds.
  await reportSession(replacement);
  const after = await read();
  expect(after.source).toBe("pi-transcript");
  expect(after.history_id).not.toBe(before.history_id);
  expect(after.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(after.turns[0]!.parts).toEqual([{ kind: "text", text: "New topic" }]);
  // the previous conversation is gone: it lived in the abandoned file
  expect(JSON.stringify(after.turns)).not.toContain("Check chat");
});

it("shows the branch /tree leaves the leaf on, and invalidates the pages held before it", async () => {
  await reportSession(transcript); // /resume back to the session this pane began on
  const before = await read();
  expect(JSON.stringify(before.turns)).toContain("Answer one");
  // pi writes the new answer beside the old one, parented to the prompt, and moves the leaf
  const branched = [...turns("Check chat", "Answer one").trimEnd().split("\n")];
  const prompt = JSON.parse(branched[2]!);
  branched.push(JSON.stringify({
    type: "message", id: "a2", parentId: prompt.id, timestamp: new Date().toISOString(),
    message: { role: "assistant", model: "pi-contract-model", stopReason: "stop", content: [{ type: "text", text: "the retried answer" }] },
  }));
  writeFileSync(transcript, branched.join("\n") + "\n");
  const after = await read();
  expect(after.source).toBe("pi-transcript");
  expect(after.history_id).not.toBe(before.history_id); // same file, same size class: the tree moved
  expect(JSON.stringify(after.turns)).toContain("the retried answer");
  expect(JSON.stringify(after.turns)).not.toContain("Answer one");
});

it("counts the turns a /tree left behind, over HTTP", async () => {
  // shaped like a real file: a parentless model_change is where the first turns hang, and a
  // navigation re-hangs a new turn beside an abandoned one there, exactly as /tree leaves it
  writeFileSync(transcript, page([
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "the question" } },
    { type: "message", id: "a-gone", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: { role: "assistant", content: "the abandoned answer" } },
    { type: "message", id: "u2", parentId: "m1", timestamp: "2026-09-30T00:00:03Z", message: { role: "user", content: "the retried question" } },
    { type: "message", id: "a-live", parentId: "u2", timestamp: "2026-09-30T00:00:04Z", message: { role: "assistant", content: "the answer in play" } },
  ]));
  const branched = await read();
  // pi moved its leaf and wrote nothing, so the page is built from the live branch alone; the
  // count is the only thing that can tell the reader the file holds more than this
  expect(JSON.stringify(branched.turns)).not.toContain("abandoned");
  expect(branched.abandoned).toEqual({ count: 2, branches: 1, summary: null });

  // answering /tree's "Summarize branch?" writes pi's own account of the abandoned path
  writeFileSync(transcript, page([
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "the question" } },
    { type: "message", id: "a-gone", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: { role: "assistant", content: "the abandoned answer" } },
    { type: "branch_summary", id: "bs", parentId: "m1", timestamp: "2026-09-30T00:00:03Z", fromId: "a-gone", summary: "Tried the first question; it failed." },
    { type: "message", id: "u2", parentId: "bs", timestamp: "2026-09-30T00:00:04Z", message: { role: "user", content: "the retried question" } },
    { type: "message", id: "a-live", parentId: "u2", timestamp: "2026-09-30T00:00:05Z", message: { role: "assistant", content: "the answer in play" } },
  ]));
  expect((await read()).abandoned?.summary).toBe("Tried the first question; it failed.");

  // a session no /tree touched answers zero, not absent: the client shows nothing at 0
  writeFileSync(transcript, turns("Check chat", "Answer one"));
  expect((await read()).abandoned).toEqual({ count: 0, branches: 0, summary: null });
});

it("answers a session pi has not written yet as an empty conversation, then follows the file it writes", async () => {
  const target = await createPiPane();
  const fresh = join(slug, "fresh.jsonl");
  await reportSession(fresh, target);
  expect(await read(target)).toMatchObject({ source: "pi-transcript", turns: [], cursor: null, history_id: "unwritten:fresh" });
  // a cursor from another conversation is refused, whichever way it points
  for (const cursor of ["before", "since", "from"]) {
    const stale = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(target)}&${cursor}=${encodeURIComponent("other:0")}`);
    expect(stale.status).toBe(409);
  }
  // at work on its first turn, pi has written nothing yet: the terminal shows the turn (a status
  // report carries the session too: one without it would drop the session herdr holds)
  await herdrRpc("pane.report_agent", { pane_id: target, source: "herdr:pi", agent: "pi", state: "working", seq: nextSeq(), agent_session_path: fresh });
  try {
    expect(await read(target)).toEqual({ source: "scrollback", turns: [] });
    const stale = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(target)}&from=${encodeURIComponent("other:0")}`);
    expect(stale.status).toBe(409);
  } finally {
    await herdrRpc("pane.report_agent", { pane_id: target, source: "herdr:pi", agent: "pi", state: "idle", seq: nextSeq(), agent_session_path: fresh });
  }
  writeFileSync(fresh, turns("First prompt", "First answer"));
  const written = await read(target);
  expect(written.source).toBe("pi-transcript");
  expect(written.history_id).not.toBe("unwritten:fresh");
  expect(written.turns[0]!.parts).toEqual([{ kind: "text", text: "First prompt" }]);
  // a transcript read and then removed is missing, not a conversation not begun
  rmSync(fresh);
  expect(await read(target)).toEqual({ source: "scrollback", turns: [] });
});

it("distinguishes unwritten sessions with the same filename in different folders", async () => {
  const target = await createPiPane();
  const first = join(slug, "shared-name.jsonl");
  const other = join(sessionDir, "other-project");
  mkdirSync(other);
  const fresh = join(other, "shared-name.jsonl");
  writeFileSync(first, turns("Earlier prompt", "Earlier answer"));
  await reportSession(first, target);
  expect((await read(target)).source).toBe("pi-transcript");
  await reportSession(fresh, target);
  expect(await read(target)).toMatchObject({ source: "pi-transcript", turns: [], history_id: "unwritten:shared-name" });
  writeFileSync(fresh, turns("Fresh prompt", "Fresh answer"));
  expect((await read(target)).turns[0]!.parts).toEqual([{ kind: "text", text: "Fresh prompt" }]);
  rmSync(fresh);
  expect(await read(target)).toEqual({ source: "scrollback", turns: [] });
  // Another spelling of the same directory must not make a removed transcript unwritten again.
  const alias = join(sessionDir, "alias-project");
  symlinkSync(other, alias, "dir");
  await reportSession(join(alias, "shared-name.jsonl"), target);
  expect(await read(target)).toEqual({ source: "scrollback", turns: [] });
});

it("falls back to the scrollback when the reported path leaves the store", async () => {
  const outside = join(root, "outside.jsonl");
  writeFileSync(outside, turns("Must not be read", "no"));
  await reportSession(outside);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ source: "scrollback", turns: [] });
});
