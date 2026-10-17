/**
 * Inline images in the terminal (docs/terminal-images.md): the marker contract agreed with the pi
 * images extension. herdr 0.9.5 re-renders a pane as cells and drops Kitty graphics, but keeps OSC 8
 * hyperlinks, so the extension leaves, on each row of an image it draws natively, one blank cell
 * (U+2800) right of the image, linked to an `x-pi-image:` URI naming the image. The browser draws
 * the image over those rows after fetching it from the pane's own pi session. Pure: no I/O.
 */

export const TERMINAL_IMAGE_SCHEME = "x-pi-image:";
/** The marker cell's character: BRAILLE PATTERN BLANK, one cell wide and drawn empty. */
export const TERMINAL_IMAGE_MARKER_CHAR = "\u2800";
/** The extension emits nothing longer; herdr 0.9.5 drops links past about 2 KiB. */
export const TERMINAL_IMAGE_URI_MAX = 512;
/** The image endpoint's answer to a session-bound read: the session it checked. */
export const PI_SESSION_HEADER = "x-herdr-pi-session";
/** A placement larger than this (in cells) is not believed. */
export const TERMINAL_IMAGE_MAX_CELLS = 1000;

/** pi's own session id rule (session-manager assertValidSessionId), bounded. */
export const PI_SESSION_ID = /^(?=.{1,128}$)[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/**
 * The longest pi tool call id taken. pi stores a provider's id as it came, opaque: OpenAI Responses
 * ids are `${call_id}|${item id}` (pi-ai's openai-responses-shared), and some providers' item ids run
 * to hundreds of characters of base64 (`+/=`). A marker's ref is bounded further by
 * TERMINAL_IMAGE_URI_MAX once encoded.
 */
export const PI_TOOL_CALL_ID_MAX = 1024;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * A pi tool call id, as the chat, the image endpoint and a marker name it: 1 to 1024 printable
 * ASCII characters, space excluded (no control character, no non-ASCII). Otherwise opaque: compared
 * whole, never split, decoded or used as a path.
 */
export function isPiToolCallId(value: string): boolean {
  return value.length >= 1 && value.length <= PI_TOOL_CALL_ID_MAX && PRINTABLE_ASCII.test(value);
}

/**
 * The image endpoint's pi ref, `pi:<tool call id>:<nth supported image of its result>`: the index is
 * the digits after the last colon (1 to 3), the id everything between (it may hold colons). Null for
 * anything else.
 */
export function parsePiImageRef(ref: string): { toolCallId: string; index: number } | null {
  if (!ref.startsWith("pi:")) return null;
  const colon = ref.lastIndexOf(":");
  const toolCallId = ref.slice(3, colon), index = ref.slice(colon + 1);
  if (colon <= 3 || !/^\d{1,3}$/.test(index) || !isPiToolCallId(toolCallId)) return null;
  return { toolCallId, index: Number(index) };
}

/** The longest image file path a `file:` ref names. */
export const PI_FILE_REF_PATH_MAX = 1024;

/**
 * The image endpoint's file ref, `file:<absolute path>`: an image pi drew from a file rather than a
 * tool result (a picture the user pasted, before and after it is sent). Absolute (POSIX `/…` or a
 * Windows drive `C:\…`), at most 1024 characters, no control character and no `.`/`..` segment.
 * Served only for a terminal marker's session-and-digest-bound read, never by ref alone.
 */
export function parsePiFileRef(ref: string): { path: string } | null {
  if (!ref.startsWith("file:")) return null;
  const path = ref.slice(5);
  if (path.length < 2 || path.length > PI_FILE_REF_PATH_MAX || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) return null;
  if (path.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) return null;
  return { path };
}

const DIGEST = /^[0-9a-f]{32}$/;
const COUNT = /^(?:0|[1-9]\d{0,3})$/;
const KEYS = ["s", "ref", "h", "c", "r", "y"] as const;

export interface TerminalImageMarker {
  /** pi session id that drew the image */
  session: string;
  /** the image endpoint's ref: `pi:<tool call id>:<n>`, or `file:<absolute path>` */
  ref: string;
  /** first 32 hex digits of the SHA-256 of the image's bytes */
  digest: string;
  cols: number;
  rows: number;
  /** the footprint row this marker cell stands on */
  row: number;
}

/**
 * The marker a hyperlink URI is, or null. Strict: version 1, exactly the six keys once each, in
 * any order, each value RFC 3986 percent-encoded (the query holds unreserved characters, `%`, `:`,
 * `=` and `&` only; the extension escapes `!'()*` too). Anything else (another scheme, a forged or
 * oversized value, a raw `|`) is no marker.
 */
export function parseTerminalImageMarker(uri: string): TerminalImageMarker | null {
  if (uri.length > TERMINAL_IMAGE_URI_MAX || !uri.startsWith(`${TERMINAL_IMAGE_SCHEME}v1?`)) return null;
  const query = uri.slice(TERMINAL_IMAGE_SCHEME.length + 3);
  if (!/^[A-Za-z0-9._~%:=&-]+$/.test(query)) return null;
  const values = new Map<string, string>();
  for (const pair of query.split("&")) {
    const at = pair.indexOf("=");
    if (at <= 0) return null;
    const key = pair.slice(0, at);
    if (!(KEYS as readonly string[]).includes(key) || values.has(key)) return null;
    let value: string;
    try { value = decodeURIComponent(pair.slice(at + 1)); } catch { return null; }
    values.set(key, value);
  }
  if (values.size !== KEYS.length) return null;
  const [session, ref, digest, c, r, y] = KEYS.map((key) => values.get(key)!);
  if (!PI_SESSION_ID.test(session!) || (parsePiImageRef(ref!) === null && parsePiFileRef(ref!) === null) || !DIGEST.test(digest!)) return null;
  if (!COUNT.test(c!) || !COUNT.test(r!) || !COUNT.test(y!)) return null;
  const cols = Number(c), rows = Number(r), row = Number(y);
  if (cols < 1 || rows < 1 || cols > TERMINAL_IMAGE_MAX_CELLS || rows > TERMINAL_IMAGE_MAX_CELLS || row >= rows) return null;
  // a one-row image marks its only row; taller ones never mark row 0 (pi's fullscreen crop draws
  // the image line there), so a row-0 marker on a taller image is not one the extension wrote
  if (rows > 1 && row === 0) return null;
  return { session: session!, ref: ref!, digest: digest!, cols, rows, row };
}

/** One marker cell seen on screen: where, and what it said. */
export interface MarkerCell {
  x: number;
  y: number;
  marker: TerminalImageMarker;
}

/** An image to draw: its identity, its whole footprint and the rows of it that are visible. */
export interface TerminalImagePlacement {
  /** session, ref and digest: the image itself */
  image: string;
  session: string;
  ref: string;
  digest: string;
  /** the footprint, in screen cells; `top` may be above the screen */
  left: number;
  top: number;
  cols: number;
  rows: number;
  /** the screen rows the image shows on, inclusive */
  firstRow: number;
  lastRow: number;
}

export const imageKey = (marker: Pick<TerminalImageMarker, "session" | "ref" | "digest">): string =>
  `${marker.session}\n${marker.ref}\n${marker.digest}`;

/**
 * The placements a screen's live marker cells describe. Cells of one placement agree on the image
 * and its footprint (left = x - cols, top = y - row). The same picture can stand in two places
 * (pi names identical bytes by one ref), so each footprint is drawn. A cell a frame moved away is
 * gone already: something else was written over it. An image shows on the rows that still carry
 * its marker, and on the row above the first of them (the image line itself, which carries none)
 * unless that row's marker cell shows U+2800 without the link (`bareMarkerAt`): a marker
 * overwritten there. Rows pi cropped away or someone overwrote carry no marker and are not drawn;
 * a footprint split by such a row is drawn as one placement per run of rows.
 */
export function terminalImagePlacements(
  cells: Iterable<MarkerCell>,
  screen: { cols: number; rows: number },
  bareMarkerAt: (x: number, y: number) => boolean = () => false,
): TerminalImagePlacement[] {
  const groups = new Map<string, MarkerCell[]>();
  for (const cell of cells) {
    const left = cell.x - cell.marker.cols;
    const top = cell.y - cell.marker.row;
    if (left < 0 || cell.x >= screen.cols || cell.y < 0 || cell.y >= screen.rows) continue;
    const footprint = `${imageKey(cell.marker)}\n${cell.marker.cols}\n${cell.marker.rows}\n${left}\n${top}`;
    const group = groups.get(footprint);
    if (group) group.push(cell); else groups.set(footprint, [cell]);
  }
  const placements: TerminalImagePlacement[] = [];
  for (const group of groups.values()) {
    const { marker, x, y } = group[0]!;
    const left = x - marker.cols;
    const top = y - marker.row;
    const rows = new Set(group.map((cell) => cell.y));
    const first = Math.min(...rows);
    if (marker.rows > 1 && first - 1 >= 0 && !bareMarkerAt(x, first - 1)) rows.add(first - 1);
    const sorted = [...rows].sort((a, b) => a - b);
    for (let at = 0; at < sorted.length;) {
      let end = at;
      while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
      placements.push({
        image: imageKey(marker), session: marker.session, ref: marker.ref, digest: marker.digest,
        left, top, cols: marker.cols, rows: marker.rows, firstRow: sorted[at]!, lastRow: sorted[end]!,
      });
      at = end + 1;
    }
  }
  return placements.sort((a, b) => a.firstRow - b.firstRow || a.left - b.left);
}
