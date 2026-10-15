import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { paneGet } from "../herdr/client.ts";
import { piTranscriptPath } from "../pi.ts";
import { object, type PiVisualIdentity } from "../../shared/pi-visual.ts";

export class VisualError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export interface PiPane extends PiVisualIdentity { path: string; cwd: string | null; paneId: string }
export function readHeader(path: string): Record<string, unknown> {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(65536); const got = readSync(fd, bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, got).indexOf(10);
    if (newline < 0) throw new VisualError("pi_session_unavailable", "Pi session header is unavailable", 409);
    const value: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
    if (!object(value) || value.type !== "session" || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value.id)) throw new VisualError("pi_session_unavailable", "Invalid Pi session header", 409);
    return value;
  } finally { closeSync(fd); }
}
export function sessionKey(path: string, id: string): string { return createHash("sha256").update(path).update("\0").update(id).digest("hex"); }
export async function originalPi(paneId: string, expected?: string): Promise<PiPane> {
  if (!paneId || paneId.length > 256) throw new VisualError("invalid_pane", "Invalid pane");
  const pane = await paneGet(paneId);
  if ((pane.agent ?? pane.agent_session?.agent) !== "pi") throw new VisualError("original_pi_required", "This feature requires original Pi, not omp", 409);
  const transcript = await piTranscriptPath(paneId);
  if (!transcript || !("path" in transcript)) throw new VisualError("pi_session_unavailable", "Send a message in Pi before opening visual tools", 409);
  const header = readHeader(transcript.path); const sessionId = header.id as string;
  const session = sessionKey(transcript.path, sessionId);
  if (expected !== undefined && session !== expected) throw new VisualError("pi_session_changed", "Pi session changed; reopen the panel", 409);
  // Resolve again after asynchronous discovery, so a switched pane never gets its predecessor's tools.
  const current = await paneGet(paneId);
  if ((current.agent ?? current.agent_session?.agent) !== "pi" || current.agent_session?.value !== pane.agent_session?.value || current.terminal_id !== pane.terminal_id) throw new VisualError("pi_session_changed", "Pi session changed; reopen the panel", 409);
  return { paneId, path: transcript.path, sessionId, session, cwd: current.foreground_cwd ?? current.cwd ?? null };
}
