/**
 * Inline images in the terminal (docs/terminal-images.md). The pi images extension marks each
 * row of an image it draws natively with one linked U+2800 cell right of the image; herdr keeps
 * the link, not the pixels. This module finds those cells on the xterm screen, fetches each image
 * from the pane's own pi session, and draws it over its rows in a layer above the text.
 *
 * Nothing here writes to the terminal, reads its scrollback or decides what a cell holds: the
 * attach stream stays the truth. A marker cell counts from the print that wrote it under its link
 * until anything else is written over it, it is erased, or the screen moves; the image only when
 * the server finds it in the session the marker names with the digest it names.
 */
import type { IBuffer, IDisposable, Terminal } from "@xterm/xterm";

import { machinePath } from "../../shared/machines.ts";
import { attachmentFileName, mentionFileName, type GalleryImage } from "./imageViewer.ts";
import {
  PI_SESSION_HEADER,
  TERMINAL_IMAGE_MARKER_CHAR,
  TERMINAL_IMAGE_SCHEME,
  parsePiFileRef,
  parsePiImageRef,
  parseTerminalImageMarker,
  terminalImagePlacements,
  type MarkerCell,
  type TerminalImageMarker,
  type TerminalImagePlacement,
} from "../../shared/terminal-images.ts";

/** More marker cells than a screen can honestly hold are forged: the rest are not recorded. */
export const MAX_MARKER_CELLS = 2048;

interface Cursor { x: number; y: number }

/**
 * The marker cells written to one screen. herdr's attach stream only places the cursor and
 * writes cells (it never scrolls), and a cell it rewrites comes with its link or without one, so
 * a cell is a marker exactly when the last print over it was the one character printed under a
 * marker link. Writes are followed as the parser makes them (`hyperlink`, `printed`, `shifted`);
 * erasing is caught by the cell no longer showing U+2800 (`validate`); anything that moves rows
 * (a scroll, a wrapping print, inserted or deleted lines) forgets every marker, failing closed
 * until herdr writes them again.
 */
export class TerminalImageMarkers {
  #cells = new Map<string, MarkerCell>();
  /** the marker link the stream has open (until its next OSC 8), and whether nothing was printed under it yet */
  #open: { marker: TerminalImageMarker; fresh: boolean } | null = null;

  /**
   * An OSC 8 payload (`params;uri`): it ends the link before it and may open a marker link.
   * Answers whether it was an image marker link (valid or not).
   */
  hyperlink(payload: string): boolean {
    this.#open = null;
    const separator = payload.indexOf(";");
    if (separator === -1) return false;
    const uri = payload.slice(separator + 1);
    if (!uri.startsWith(TERMINAL_IMAGE_SCHEME)) return false;
    const marker = parseTerminalImageMarker(uri);
    if (marker !== null) this.#open = { marker, fresh: true };
    return true;
  }

  /**
   * Characters were printed, the cursor going from `from` to `to`. On one row they covered
   * [from.x, to.x) (insert mode pushes the rest of the row along; a print that does not advance
   * changed the cell before or the last one); those cells stop being markers, but for the single
   * cell printed first under a fresh marker link, which becomes one. A print that left its row
   * wrapped, and may have scrolled: every marker is forgotten.
   */
  printed(from: Cursor, to: Cursor, cols: number, insert = false): void {
    const open = this.#open;
    if (open) this.#open = { marker: open.marker, fresh: false };
    if (this.#cells.size === 0 && !open?.fresh) return;
    if (to.y !== from.y || to.x < from.x) {
      this.clear();
      return;
    }
    const start = to.x === from.x ? from.x - 1 : from.x;
    const end = insert ? cols : Math.max(to.x, from.x + 1);
    for (let x = Math.max(0, start); x < end; x++) this.#cells.delete(`${x},${from.y}`);
    if (open?.fresh && to.x === from.x + 1 && from.x < cols && from.y >= 0) {
      if (this.#cells.size >= MAX_MARKER_CELLS) return;
      this.#cells.set(`${from.x},${from.y}`, { x: from.x, y: from.y, marker: open.marker });
    }
  }

  /** Cells of row `y` from `x` on moved sideways (inserted or deleted characters). */
  shifted(at: Cursor): void {
    for (const [key, cell] of this.#cells) if (cell.y === at.y && cell.x >= at.x) this.#cells.delete(key);
  }

  /** Drop the cells that no longer show the marker character; true when any went. */
  validate(charAt: (x: number, y: number) => string | undefined): boolean {
    let changed = false;
    for (const [key, cell] of this.#cells) {
      if (charAt(cell.x, cell.y) === TERMINAL_IMAGE_MARKER_CHAR) continue;
      this.#cells.delete(key);
      changed = true;
    }
    return changed;
  }

  /** Forget every marker cell (the screen moved, or is another one). */
  clear(): void { this.#cells.clear(); }

  /** A terminal reset: no cell and no open link survive it. */
  reset(): void {
    this.#cells.clear();
    this.#open = null;
  }

  has(x: number, y: number): boolean { return this.#cells.has(`${x},${y}`); }

  get size(): number { return this.#cells.size; }

  placements(screen: { cols: number; rows: number }, charAt: (x: number, y: number) => string | undefined = () => undefined): TerminalImagePlacement[] {
    // a U+2800 that is no marker where a marker could be: one overwritten without its link
    const bare = (x: number, y: number) => !this.has(x, y) && charAt(x, y) === TERMINAL_IMAGE_MARKER_CHAR;
    return terminalImagePlacements(this.#cells.values(), screen, bare);
  }
}

/** The character a screen cell shows, by cursor coordinates (rows from the active buffer's base). */
export function screenCharAt(buffer: IBuffer, x: number, y: number): string | undefined {
  return buffer.getLine(buffer.baseY + y)?.getCell(x)?.getChars();
}

type PrintHandler = { print: (data: Uint32Array, start: number, end: number) => void };

/**
 * Follow what one terminal's parser writes, for `markers`: its prints, and the controls that move
 * cells. xterm 5.5 has no public print hook, so this terminal's own InputHandler `print` is wrapped
 * (the parser calls it through the instance); without that internal, null, and no image is drawn.
 */
export function followTerminalWrites(term: Terminal, markers: TerminalImageMarkers): IDisposable | null {
  const handler = (term as unknown as { _core?: { _inputHandler?: Partial<PrintHandler> } })._core?._inputHandler;
  if (!handler || typeof handler.print !== "function" || Object.prototype.hasOwnProperty.call(handler, "print")) return null;
  const original = handler.print;
  const cursor = (): Cursor => ({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY });
  function print(this: PrintHandler, data: Uint32Array, start: number, end: number): void {
    const from = cursor();
    original!.call(this, data, start, end);
    markers.printed(from, cursor(), term.cols, term.modes.insertMode);
  }
  handler.print = print;
  const forget = () => { markers.clear(); return false; };
  const shift = () => { markers.shifted(cursor()); return false; };
  const disposables: IDisposable[] = [
    // a scroll (a line feed or a wrap at the bottom, IND, NEL) moves every row
    term.onScroll(() => markers.clear()),
    ...["S", "T", "L", "M"].map((final) => term.parser.registerCsiHandler({ final }, forget)),
    ...["@", "P"].map((final) => term.parser.registerCsiHandler({ final }, shift)),
    term.parser.registerEscHandler({ final: "M" }, forget),
  ];
  return {
    dispose: () => {
      if (handler.print === print) delete handler.print;
      for (const disposable of disposables) disposable.dispose();
    },
  };
}

/** Bounds of what a terminal decodes for images. */
export const IMAGE_LIMITS = {
  /** bytes of one image */
  bytes: 8 * 1024 * 1024,
  /** decoded pixels of one image, and its longest side */
  pixels: 4096 * 4096,
  side: 8192,
  /** images fetched or decoded at the same time */
  concurrent: 2,
  /** images kept decoded, and their total encoded bytes */
  entries: 32,
  cacheBytes: 48 * 1024 * 1024,
  /** images that failed, remembered so a screen of forged markers fetches each once */
  failures: 256,
} as const;

const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Width and height in an image's header, read without decoding; null when it is not that type. */
export function imageDimensions(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  const u32 = (at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
  const le16 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
  const le24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
  const ascii = (at: number, text: string) => [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));
  if (type === "image/png") {
    if (bytes.length < 24 || u32(0) !== 0x89504e47 || u32(4) !== 0x0d0a1a0a || !ascii(12, "IHDR")) return null;
    return { width: u32(16), height: u32(20) };
  }
  if (type === "image/gif") {
    if (bytes.length < 10 || !(ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return null;
    return { width: le16(6), height: le16(8) };
  }
  if (type === "image/webp") {
    if (bytes.length < 30 || !ascii(0, "RIFF") || !ascii(8, "WEBP")) return null;
    if (ascii(12, "VP8 ")) return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (ascii(12, "VP8L")) {
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (ascii(12, "VP8X")) return { width: le24(24) + 1, height: le24(27) + 1 };
    return null;
  }
  if (type === "image/jpeg") {
    if (bytes.length < 4 || u16(0) !== 0xffd8) return null;
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return null;
      const kind = bytes[at + 1]!;
      if (kind === 0xff) { at++; continue; }
      if (kind === 0xd8 || kind === 0x01 || (kind >= 0xd0 && kind <= 0xd7)) { at += 2; continue; }
      const length = u16(at + 2);
      // start-of-frame markers, except DHT, JPG and DAC that share the range
      if (kind >= 0xc0 && kind <= 0xcf && kind !== 0xc4 && kind !== 0xc8 && kind !== 0xcc) return { width: u16(at + 7), height: u16(at + 5) };
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }
  return null;
}

export interface LoadedImage { url: string; width: number; height: number; bytes: number; type: string }
type Entry =
  | { state: "ready"; image: LoadedImage }
  | { state: "loading" }
  /** `retry`: when it may be asked for again; a refusal that cannot change has none */
  | { state: "failed"; retry: number | null; attempts: number };

/** Why an image is not drawn; for tests and diagnostics, never shown as UI. */
export type ImageRefusal = "status" | "session" | "type" | "size" | "header" | "pixels" | "decode" | "network";
/** A missing image may only be late (pi writes its result as it draws it): asked again after these. */
const RETRY_MS = [1_000, 4_000, 15_000];

/**
 * Fetches, checks and decodes images for one terminal, bounded in bytes, pixels, concurrency and
 * cache. A key names one image in one place: PC, pane, session, ref and digest. An image the
 * server does not have is asked for again a few times; one it refused for what it is (another
 * session, type, size) stays refused for the key, so a forged marker costs one request.
 */
export class TerminalImageLoader {
  #entries = new Map<string, Entry>();
  #queue: (() => void)[] = [];
  #active = 0;
  #failures: string[] = [];
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #disposed = false;
  /** runs when an image becomes ready, or may be asked for again */
  onChange: (() => void) | null = null;
  readonly refusals: { key: string; reason: ImageRefusal }[] = [];

  constructor(
    private readonly decode: (blob: Blob) => Promise<{ url: string; width: number; height: number }> = decodeBlob,
    private readonly request: (url: string) => Promise<Response> = (url) => fetch(url, { credentials: "same-origin", cache: "no-store" }),
    private readonly now: () => number = Date.now,
  ) {}

  /** The image when it is ready; otherwise null, and `onChange` runs once it is. */
  get(key: string, url: string, session: string, inUse: () => Set<string>): LoadedImage | null {
    const entry = this.#entries.get(key);
    if (entry?.state === "ready") {
      // most recently used last
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      return entry.image;
    }
    if (entry?.state === "loading") return null;
    if (entry?.state === "failed" && (entry.retry === null || this.now() < entry.retry)) return null;
    const attempts = entry?.state === "failed" ? entry.attempts : 0;
    this.#entries.set(key, { state: "loading" });
    void this.#load(key, url, session).then((result) => {
      if (this.#disposed) { if ("image" in result) URL.revokeObjectURL(result.image.url); return; }
      if ("image" in result) {
        this.#entries.set(key, { state: "ready", image: result.image });
        this.#evict(inUse());
        this.onChange?.();
        return;
      }
      const delay = result.retryable ? RETRY_MS[attempts] : undefined;
      this.#entries.set(key, { state: "failed", retry: delay === undefined ? null : this.now() + delay, attempts: attempts + 1 });
      if (attempts === 0) this.#failures.push(key);
      while (this.#failures.length > IMAGE_LIMITS.failures) this.#entries.delete(this.#failures.shift()!);
      if (delay !== undefined) {
        const timer = setTimeout(() => { this.#timers.delete(timer); if (!this.#disposed) this.onChange?.(); }, delay);
        this.#timers.add(timer);
      }
    });
    return null;
  }

  #refuse(key: string, reason: ImageRefusal, retryable = false): { retryable: boolean } {
    this.refusals.push({ key, reason });
    if (this.refusals.length > 64) this.refusals.shift();
    return { retryable };
  }

  async #slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#active >= IMAGE_LIMITS.concurrent) await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active++;
    try { return await work(); }
    finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }

  #load(key: string, url: string, session: string): Promise<{ image: LoadedImage } | { retryable: boolean }> {
    return this.#slot(async () => {
      if (this.#disposed) return { retryable: false };
      let response: Response;
      try { response = await this.request(url); } catch { return this.#refuse(key, "network", true); }
      if (!response.ok) return this.#refuse(key, "status", response.status === 404 || response.status >= 500);
      // a bridge that did not check the session (an older bundle) answers without the echo
      if (response.headers.get(PI_SESSION_HEADER) !== session) return this.#refuse(key, "session");
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!TYPES.has(type)) return this.#refuse(key, "type");
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > IMAGE_LIMITS.bytes) return this.#refuse(key, "size");
      const bytes = await readBounded(response, IMAGE_LIMITS.bytes);
      if (bytes === null) return this.#refuse(key, "size");
      const size = imageDimensions(bytes, type);
      if (size === null) return this.#refuse(key, "header");
      if (size.width < 1 || size.height < 1 || size.width > IMAGE_LIMITS.side || size.height > IMAGE_LIMITS.side
        || size.width * size.height > IMAGE_LIMITS.pixels) return this.#refuse(key, "pixels");
      if (this.#disposed) return { retryable: false };
      try {
        const decoded = await this.decode(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
        return { image: { ...decoded, bytes: bytes.length, type } };
      } catch { return this.#refuse(key, "decode"); }
    });
  }

  /** Keep the cache within its bounds, never dropping an image on screen. */
  #evict(inUse: Set<string>): void {
    const ready = [...this.#entries].filter((pair): pair is [string, Extract<Entry, { state: "ready" }>] => pair[1].state === "ready");
    let total = ready.reduce((sum, [, entry]) => sum + entry.image.bytes, 0);
    let count = ready.length;
    for (const [key, entry] of ready) {
      if (count <= IMAGE_LIMITS.entries && total <= IMAGE_LIMITS.cacheBytes) break;
      if (inUse.has(key)) continue;
      URL.revokeObjectURL(entry.image.url);
      this.#entries.delete(key);
      count--;
      total -= entry.image.bytes;
    }
  }

  /** Images decoded now (for tests). */
  get cached(): number { return [...this.#entries.values()].filter((entry) => entry.state === "ready").length; }

  /** Forget everything decoded or pending (the terminal went away). */
  dispose(): void {
    this.#disposed = true;
    this.onChange = null;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const entry of this.#entries.values()) if (entry.state === "ready") URL.revokeObjectURL(entry.image.url);
    this.#entries.clear();
    for (const resolve of this.#queue.splice(0)) resolve();
  }
}

/** Read a body, giving up past `limit` bytes. */
async function readBounded(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.length > limit ? null : buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) { void reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}

async function decodeBlob(blob: Blob): Promise<{ url: string; width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return { url, width: image.naturalWidth, height: image.naturalHeight };
}

export interface TerminalImageSource {
  /** the cache key: PC, pane, session and image */
  key: string;
  url: string;
}

/**
 * Where a placement's image is asked for: the PC and pane of the terminal that shows it (never
 * the marker's say), with the marker's session and digest for the server to check.
 */
export function terminalImageSource(machineId: string, paneId: string | null, placement: Pick<TerminalImagePlacement, "image" | "ref" | "session" | "digest">): TerminalImageSource | null {
  if (!paneId) return null;
  const query = new URLSearchParams({ pane_id: paneId, ref: placement.ref, session: placement.session, digest: placement.digest });
  return { key: `${machineId}\n${paneId}\n${placement.image}`, url: machinePath(machineId, `pane/conversation/image?${query.toString()}`) };
}

/**
 * The picture a click on a terminal image opens in the image viewer (ImageLightbox, then
 * ImageReview for comments), named by the same server URL the chat uses for it, never the
 * terminal's decoded copy: a tool result's image by its `pi:` ref, as the chat's tool images are,
 * and a pasted picture's file by its path, as an `@path` mention is (the file viewer's endpoint,
 * which ImageReview takes as a file source). `label` captions a tool image.
 */
export function terminalImageGallery(machineId: string, paneId: string, placement: Pick<TerminalImagePlacement, "ref">, type: string, label: string): GalleryImage | null {
  const file = parsePiFileRef(placement.ref);
  if (file !== null) {
    return {
      src: machinePath(machineId, `fs/file?${new URLSearchParams({ path: file.path, pane_id: paneId }).toString()}`),
      name: file.path,
      file: mentionFileName(file.path),
    };
  }
  if (parsePiImageRef(placement.ref) === null) return null;
  return {
    src: machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: placement.ref }).toString()}`),
    name: label,
    file: attachmentFileName(type, 0),
  };
}

/**
 * The layer one terminal draws its images in: a box over `.xterm-screen`, clipped to it, that
 * takes no pointer events but on the images themselves: a click on one runs `onOpen` with its
 * placement (the pane opens it in the image viewer); a press there starts no terminal selection.
 * Placements are recomputed after each parsed write; an image loading for a placement that has
 * since gone is not drawn. Without a way to follow the terminal's writes (another xterm build),
 * nothing is drawn.
 */
export class TerminalImageLayer {
  readonly markers = new TerminalImageMarkers();
  readonly loader: TerminalImageLoader;
  /** whether writes are followed; false draws nothing */
  readonly following: boolean;
  #follow: IDisposable | null;
  #layer: HTMLDivElement | null = null;
  #shown = new Map<string, HTMLDivElement>();
  /** what each drawn box shows now, for its click */
  #drawn = new WeakMap<HTMLDivElement, { placement: TerminalImagePlacement; image: LoadedImage }>();
  /** runs when an image drawn in the terminal is clicked */
  onOpen: ((placement: TerminalImagePlacement, image: LoadedImage) => void) | null = null;
  #placements: TerminalImagePlacement[] = [];
  #frame: number | null = null;
  #resize: ResizeObserver | null = null;
  #disposed = false;

  constructor(
    private readonly term: Terminal,
    private readonly source: (placement: TerminalImagePlacement) => TerminalImageSource | null,
    loader?: TerminalImageLoader,
  ) {
    this.loader = loader ?? new TerminalImageLoader();
    // an image that became ready, or may be asked for again, is drawn where it is wanted now
    this.loader.onChange = () => this.#render();
    this.#follow = followTerminalWrites(term, this.markers);
    this.following = this.#follow !== null;
  }

  /** The OSC 8 handler's view: a link ends, a marker link may open. */
  hyperlink(payload: string): void {
    this.markers.hyperlink(payload);
  }

  /** Everything drawn so far stops counting (a resize, another pane, a buffer switch). */
  clear(): void {
    this.markers.clear();
    this.#placements = [];
    this.#render();
  }

  /** A terminal reset (RIS): no marker cell and no open link survive it. */
  reset(): void {
    this.markers.reset();
    this.#placements = [];
    this.#render();
  }

  /** After a parsed write: re-read the marker cells on the next frame. */
  schedule(): void {
    if (this.#disposed || this.#frame !== null) return;
    if (this.markers.size === 0 && this.#placements.length === 0) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.update();
    });
  }

  update(): void {
    if (this.#disposed) return;
    const buffer = this.term.buffer.active;
    const charAt = (x: number, y: number) => screenCharAt(buffer, x, y);
    this.markers.validate(charAt);
    this.#placements = this.following ? this.markers.placements({ cols: this.term.cols, rows: this.term.rows }, charAt) : [];
    this.#render();
  }

  /** The placements drawn now (for tests and diagnostics). */
  get placements(): readonly TerminalImagePlacement[] { return this.#placements; }

  #ensureLayer(): HTMLDivElement | null {
    if (this.#layer?.isConnected) return this.#layer;
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return null;
    const layer = document.createElement("div");
    layer.className = "terminal-image-layer";
    layer.setAttribute("aria-hidden", "true");
    screen.appendChild(layer);
    this.#layer = layer;
    // a font or zoom change resizes the cells without a write
    this.#resize?.disconnect();
    this.#resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.#render());
    this.#resize?.observe(screen);
    return layer;
  }

  #render(): void {
    if (this.#disposed) return;
    const wanted = new Map<string, { placement: TerminalImagePlacement; source: TerminalImageSource }>();
    for (const placement of this.#placements) {
      const source = this.source(placement);
      if (source) wanted.set(`${source.key}\n${placement.left}\n${placement.top}\n${placement.cols}\n${placement.rows}\n${placement.firstRow}`, { placement, source });
    }
    for (const [key, element] of this.#shown) {
      if (wanted.has(key)) continue;
      element.remove();
      this.#shown.delete(key);
    }
    if (wanted.size === 0) return;
    const layer = this.#ensureLayer();
    const screen = layer?.parentElement;
    if (!layer || !screen) return;
    const cellWidth = screen.clientWidth / this.term.cols;
    const cellHeight = screen.clientHeight / this.term.rows;
    if (!(cellWidth > 0) || !(cellHeight > 0)) return;
    const inUse = () => new Set([...wanted.values()].map(({ source }) => source.key));
    for (const [key, { placement, source }] of wanted) {
      const image = this.loader.get(source.key, source.url, placement.session, inUse);
      if (!image) continue;
      let box = this.#shown.get(key);
      if (!box) {
        box = document.createElement("div");
        box.className = "terminal-image";
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.decoding = "async";
        img.src = image.url;
        box.appendChild(img);
        // a press on the picture is the viewer's, not the start of a terminal selection
        box.addEventListener("mousedown", (event) => { if (event.button === 0) event.stopPropagation(); });
        const opened = box;
        box.addEventListener("click", (event) => {
          const drawn = this.#drawn.get(opened);
          if (event.button !== 0 || !drawn || !this.onOpen) return;
          event.preventDefault();
          event.stopPropagation();
          this.onOpen(drawn.placement, drawn.image);
        });
        layer.appendChild(box);
        this.#shown.set(key, box);
      }
      this.#drawn.set(box, { placement, image });
      box.dataset["ref"] = placement.ref;
      // cells: left, top, cols, rows, first and last visible row (tests and diagnostics read them)
      box.dataset["cells"] = [placement.left, placement.top, placement.cols, placement.rows, placement.firstRow, placement.lastRow].join(",");
      // the box is the visible rows; the image inside keeps the whole footprint's place
      box.style.left = `${placement.left * cellWidth}px`;
      box.style.top = `${placement.firstRow * cellHeight}px`;
      box.style.width = `${placement.cols * cellWidth}px`;
      box.style.height = `${(placement.lastRow - placement.firstRow + 1) * cellHeight}px`;
      const img = box.firstElementChild as HTMLImageElement;
      img.style.top = `${(placement.top - placement.firstRow) * cellHeight}px`;
      img.style.width = `${placement.cols * cellWidth}px`;
      img.style.height = `${placement.rows * cellHeight}px`;
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#follow?.dispose();
    this.#follow = null;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    for (const element of this.#shown.values()) element.remove();
    this.#shown.clear();
    this.#resize?.disconnect();
    this.#resize = null;
    this.#layer?.remove();
    this.#layer = null;
    this.loader.dispose();
  }
}
