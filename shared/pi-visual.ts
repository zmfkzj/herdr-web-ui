/** Original Pi + zmfkzj/oh-my-pi-extensions. Not Oh My Pi (omp). */
export interface PiVisualIdentity { session: string; sessionId: string }
export type WorkerState = "running" | "done" | "failed" | "cancelled" | "interrupted" | "queued" | "unknown";
export interface PiVisualWorker {
  job: string; worker: string; role: string; state: WorkerState;
  request: string; summary: string; started: number; ended?: number;
  model?: string; thinking?: string; lastTool?: string; updated?: number;
  children: { id: string; role: string; model?: string }[];
}
export interface PiVisualWorkers extends PiVisualIdentity {
  observedAt: number; workers: PiVisualWorker[]; truncated: boolean;
  /** Recorded state, not a replacement for Pi's runtime or approval protocol. */
  source: "original-pi-orche-records";
}
export type ReviewSource = { kind: "conversation"; ref: string } | { kind: "file"; path: string };
export interface ImageAnnotation {
  id: string; x: number; y: number; width: number; height: number;
  text: string; resolved: boolean;
}
export interface ImageReviewDocument {
  id: string; session: string; revision: number; name: string; mime: string;
  annotations: ImageAnnotation[]; updated: number;
}
export interface PiDesktopRequest { session: string; port: number; password: string; fingerprint: string; readOnly: boolean; width: number; height: number }
export interface PiDesktopTicket { ticket: string; expiresAt: number }
export const MAX_ANNOTATIONS = 100;
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function annotations(value: unknown): ImageAnnotation[] {
  if (!Array.isArray(value) || value.length > MAX_ANNOTATIONS) throw new Error("Invalid annotations");
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!object(item) || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)
      || typeof item.text !== "string" || item.text.length > 4000 || typeof item.resolved !== "boolean") throw new Error("Invalid annotation");
    const { x, y, width, height } = item;
    if (![x, y, width, height].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
      || (x as number) + (width as number) > 1.000001 || (y as number) + (height as number) > 1.000001) throw new Error("Invalid annotation coordinates");
    ids.add(item.id);
    return { id: item.id, text: item.text, resolved: item.resolved, x: x as number, y: y as number, width: width as number, height: height as number };
  });
}
export function reviewSource(value: unknown): ReviewSource {
  if (!object(value)) throw new Error("Invalid image source");
  if (value.kind === "conversation" && typeof value.ref === "string" && value.ref.length > 0 && value.ref.length <= 4096) return { kind: "conversation", ref: value.ref };
  if (value.kind === "file" && typeof value.path === "string" && value.path.length > 0 && value.path.length <= 4096 && !value.path.includes("\0")) return { kind: "file", path: value.path };
  throw new Error("Invalid image source");
}
/** Coordinates always address the immutable original, independent of zoom or viewport size. */
export function rectangle(a: { x: number; y: number }, b: { x: number; y: number }) {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const x = Math.min(clamp(a.x), clamp(b.x)), y = Math.min(clamp(a.y), clamp(b.y));
  return { x, y, width: Math.abs(clamp(a.x) - clamp(b.x)), height: Math.abs(clamp(a.y) - clamp(b.y)) };
}
