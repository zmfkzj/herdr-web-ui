import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { annotations, type ImageReviewDocument } from "../../shared/pi-visual.ts";
import { VisualError } from "./identity.ts";

export const MAX_REVIEW_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_REVIEW_STORAGE_BYTES = 256 * 1024 * 1024;
interface Row { id: string; session: string; revision: number; name: string; mime: string; notes: string; updated: number }
/** A server-owned immutable snapshot, never the mutable path an agent may overwrite next. */
export class ReviewStore {
  private db?: Database;
  constructor(private readonly stateDir: string) {}
  private database(): Database {
    if (this.db) return this.db;
    const dir = join(this.stateDir, "pi-visual"); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "reviews.sqlite");
    const db = new Database(path, { create: true }); chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS reviews (session TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, image BLOB NOT NULL, notes TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(session,id));");
    this.db = db; return db;
  }
  private document(row: Row): ImageReviewDocument {
    return { id: row.id, session: row.session, revision: row.revision, name: row.name, mime: row.mime, annotations: annotations(JSON.parse(row.notes)), updated: row.updated };
  }
  get(session: string, id: string): ImageReviewDocument {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new VisualError("invalid_review", "Invalid image review");
    const row = this.database().query<Row, [string,string]>("SELECT id,session,revision,name,mime,notes,updated FROM reviews WHERE session=? AND id=?").get(session,id);
    if (!row) throw new VisualError("review_not_found", "Image review not found",404);
    return this.document(row);
  }
  open(session: string, bytes: Uint8Array, name: string, mime: string): ImageReviewDocument {
    if (bytes.length === 0 || bytes.length > MAX_REVIEW_IMAGE_BYTES) throw new VisualError("image_too_large", "Review images must be at most 16 MiB",413);
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) throw new VisualError("unsupported_image", "Image reviews support PNG, JPEG, WebP and GIF");
    const id = createHash("sha256").update(bytes).digest("hex"); const db = this.database();
    db.transaction(() => {
      if (db.query("SELECT 1 FROM reviews WHERE session=? AND id=?").get(session,id)) return;
      const usage = db.query<{ bytes: number; count: number }, []>("SELECT COALESCE(SUM(length(image)),0) AS bytes,COUNT(*) AS count FROM reviews").get()!;
      if (usage.bytes + bytes.length > MAX_REVIEW_STORAGE_BYTES || usage.count >= 500) throw new VisualError("review_storage_full", "Review storage is full; export and remove old reviews on the server",413);
      db.query("INSERT INTO reviews VALUES (?,?,0,?,?,?,'[]',?)").run(session,id,name.slice(0,1024),mime,bytes,Date.now());
    }).immediate();
    return this.get(session,id);
  }
  image(session: string, id: string): { bytes: Uint8Array<ArrayBuffer>; mime: string } {
    const doc = this.get(session,id);
    const row = this.database().query<{ image: Uint8Array }, [string,string]>("SELECT image FROM reviews WHERE session=? AND id=?").get(session,id)!;
    return { bytes: new Uint8Array(row.image), mime: doc.mime };
  }
  save(session: string, id: string, revision: unknown, value: unknown): ImageReviewDocument {
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new VisualError("invalid_revision", "Invalid revision");
    let notes; try { notes = annotations(value); } catch { throw new VisualError("invalid_annotations", "Invalid annotation data"); }
    this.get(session,id);
    const result = this.database().query("UPDATE reviews SET notes=?, revision=revision+1, updated=? WHERE session=? AND id=? AND revision=?").run(JSON.stringify(notes),Date.now(),session,id,revision as number);
    if (result.changes !== 1) throw new VisualError("review_conflict", "Another tab changed this review. Copy unsaved comments before reopening it.",409);
    return this.get(session,id);
  }
  close(): void { this.db?.close(); this.db = undefined; }
}
