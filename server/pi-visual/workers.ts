import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { piEntryIndex } from "../pi-tree.ts";
import { piAgentDir } from "../pi-models.ts";
import { object, type PiVisualWorker, type PiVisualWorkers, type WorkerState } from "../../shared/pi-visual.ts";
import type { PiPane } from "./identity.ts";

const STATES = new Set<WorkerState>(["running", "done", "failed", "cancelled", "interrupted"]);
const text = (v: unknown, limit = 2000): string => typeof v === "string" ? v.slice(0, limit) : "";
const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
export function contained(path: string, root: string): string | null {
  try { const canonical = realpathSync(path), base = realpathSync(root), rel = relative(base, canonical); return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? canonical : null; } catch { return null; }
}
function range(path: string, start: number, end: number): string {
  if (end - start > 2 * 1024 * 1024) throw new Error("Record exceeds visual reader limit");
  const fd = openSync(path, "r");
  try { const bytes = Buffer.alloc(end - start); return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, start)).toString("utf8"); } finally { closeSync(fd); }
}
/** Only the current on-disk Pi branch. No omp task format and no cwd/newest-file guessing. */
export function jobEntries(path: string): { entries: Record<string, unknown>[]; truncated: boolean } {
  const index = piEntryIndex(path);
  if (!index?.entries.length) return { entries: [], truncated: false };
  const byId = new Map(index.entries.map(entry => [entry.id, entry]));
  const branch = []; const seen = new Set<string>(); let entry = index.entries.at(-1);
  while (entry && !seen.has(entry.id)) { seen.add(entry.id); branch.push(entry); entry = entry.parent ? byId.get(entry.parent) : undefined; }
  const custom = branch.filter(entry => entry.type === "custom").reverse();
  let budget = 8 * 1024 * 1024, truncated = custom.length > 2000;
  const entries: Record<string, unknown>[] = [];
  // Spend the read budget on newest facts first; older unrelated custom entries
  // must not hide the latest end event and leave a finished job showing running.
  for (const entry of custom.slice(-2000).reverse()) {
    if (entry.end - entry.start > 512 * 1024 || (budget -= entry.end - entry.start) < 0) { truncated = true; continue; }
    const row: unknown = JSON.parse(range(path, entry.start, entry.end));
    if (object(row) && row.customType === "orche-job" && object(row.data)) entries.push(row.data);
  }
  return { entries: entries.reverse(), truncated };
}
export function foldJobs(entries: Record<string, unknown>[]): PiVisualWorker[] {
  const jobs = new Map<string, PiVisualWorker>();
  for (const data of entries) {
    if (typeof data.job !== "string" || !/^[JQ]\d+$/.test(data.job)) continue;
    if (data.event === "start" || data.event === "queue") {
      jobs.set(data.job, { job: data.job, worker: text(data.worker, 80), role: text(data.role, 80), state: data.event === "start" ? "running" : "queued", request: text(data.request), summary: "", started: number(data.at) ?? 0,
        ...(text(data.model) ? { model: text(data.model, 200) } : {}), ...(text(data.thinking) ? { thinking: text(data.thinking, 80) } : {}), children: [] });
    } else {
      const job = jobs.get(data.job); if (!job) continue;
      if (data.event === "end") { job.state = STATES.has(data.status as WorkerState) ? data.status as WorkerState : "unknown"; job.ended = number(data.at); job.summary = text(data.summary); }
      if (data.event === "queue-end") { job.state = data.outcome === "started" ? "done" : "cancelled"; job.ended = number(data.at); job.summary = text(data.reason) || text(data.started); }
    }
  }
  return [...jobs.values()];
}
function enrich(job: PiVisualWorker, record: string, pane: PiPane, root: string): void {
  const file = contained(join(record, "run.json"), join(root, pane.sessionId));
  if (!file) return;
  const size = statSync(file).size; if (size > 2 * 1024 * 1024) return;
  const manifest: unknown = JSON.parse(range(file, 0, size));
  if (!object(manifest) || manifest.version !== 1 || !object(manifest.parentSession) || manifest.parentSession.id !== pane.sessionId || manifest.parentSession.file !== pane.path) return;
  if (!object(manifest.worker) || manifest.worker.id !== job.worker) return;
  if (job.state === "running" && STATES.has(manifest.status as WorkerState)) job.state = manifest.status as WorkerState;
  const assignment = object(manifest.assignment) ? manifest.assignment : {};
  job.model = text(assignment.model, 200) || job.model;
  job.thinking = text(assignment.thinking, 80) || job.thinking;
  job.summary = text(manifest.summary) || text(manifest.failure) || job.summary;
  if (typeof manifest.end === "string" && Number.isFinite(Date.parse(manifest.end))) job.ended = Date.parse(manifest.end);
  if (Array.isArray(manifest.agents)) job.children = manifest.agents.filter(object).filter(a => typeof a.id === "string" && a.id !== job.worker).slice(0,32).map(a => ({ id: text(a.id,80), role:text(a.role,80), ...(text(a.model) ? { model:text(a.model,200) } : {}) }));
  const transcript = typeof manifest.worker.sessionFile === "string" ? contained(manifest.worker.sessionFile, join(root,pane.sessionId)) : null;
  // Persistent workers reuse this file across assignments. Do not attribute a
  // later assignment's latest tool to an already finished job.
  if (transcript && job.state === "running") {
    const stat = statSync(transcript); job.updated = stat.mtimeMs;
    // Only complete tail records. A cut image/UTF-8 line is discarded, never parsed as another job.
    const from = Math.max(0, stat.size - 256 * 1024); const tail = range(transcript,from,stat.size).split("\n");
    if (from > 0) tail.shift(); tail.pop();
    for (const line of tail.reverse()) {
      try { const row: unknown = JSON.parse(line); if (!object(row) || !object(row.message)) continue;
        if (row.message.role === "toolResult" && typeof row.message.toolName === "string") { job.lastTool = text(row.message.toolName,100); break; }
      } catch { /* incomplete records are not state */ }
    }
  }
  if (job.state === "running" && object(manifest.owner) && Number.isSafeInteger(manifest.owner.pid) && (manifest.owner.pid as number) > 0) {
    try { process.kill(manifest.owner.pid as number,0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") job.state = "interrupted"; }
  }
}
export function readWorkers(pane: PiPane, root = process.env["HERDR_PI_ORCHE_RECORDS_DIR"] || join(piAgentDir(),"orche","records")): PiVisualWorkers {
  const { entries, truncated } = jobEntries(pane.path); const all = foldJobs(entries);
  const active = all.filter(job => job.state === "running" || job.state === "queued");
  const ended = all.filter(job => job.state !== "running" && job.state !== "queued").slice(-30).reverse();
  const workers = [...active.slice(-30), ...ended];
  for (const job of workers) {
    const record = [...entries].reverse().find(row => row.job === job.job && typeof row.record === "string")?.record;
    if (typeof record === "string") { try { enrich(job,record,pane,root); } catch { /* native record temporarily unavailable; job entry stays authoritative */ } }
  }
  return { session: pane.session, sessionId: pane.sessionId, observedAt: Date.now(), source: "original-pi-orche-records", workers, truncated: truncated || all.length > workers.length };
}
