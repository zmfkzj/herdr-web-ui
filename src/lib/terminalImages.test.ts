import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/xterm";

import { hyperlinkFilter } from "./terminalFileLinks.ts";
import { IMAGE_LIMITS, imageDimensions, MAX_MARKER_CELLS, TerminalImageLayer, TerminalImageLoader, TerminalImageMarkers, terminalImageGallery, terminalImageSource } from "./terminalImages.ts";
import { sourceFromImage } from "./pi-visual/api.ts";

const DIGEST = "0123456789abcdef0123456789abcdef";
const SESSION = "0190abcd-0000-7000-8000-000000000001";
/** The extension's value encoding: encodeURIComponent, plus RFC 3986's `!'()*` (it leaves those raw). */
const rfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const uri = (y: number, ref = "pi:call_01:0") => `x-pi-image:v1?s=${SESSION}&ref=${rfc3986(ref)}&h=${DIGEST}&c=12&r=6&y=${y}`;
const link = (y: number, ref?: string) => `;${uri(y, ref)}`;

/** Cursor to a screen cell, as herdr's attach stream places it (0-based here, 1-based on the wire). */
const at = (row: number, col: number) => `\x1b[${row + 1};${col + 1}H`;
/** One marker cell as the extension writes it and herdr re-emits it: link, U+2800, end of link. */
const marker = (y: number, ref?: string) => `\x1b]8;;${uri(y, ref)}\x1b\\\u2800\x1b]8;;\x1b\\`;
/** A 12 x 6 image at column 2, row 3: its markers at column 14, rows 4..8 (y = 1..5). */
const image = (ref?: string, top = 3) => [1, 2, 3, 4, 5].map((y) => at(top + y, 14) + marker(y, ref)).join("");

/** A real xterm (5.5, headless), wired as PaneTerminal wires it: the layer sees each OSC 8 first. */
function terminal(cols = 40, rows = 12) {
  const term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 0 });
  const layer = new TerminalImageLayer(term, () => null);
  const filter = hyperlinkFilter();
  term.parser.registerOscHandler(8, (payload) => {
    layer.hyperlink(payload);
    return filter.handler(payload);
  });
  term.parser.registerEscHandler({ final: "c" }, () => {
    layer.reset();
    return false;
  });
  const write = async (data: string) => {
    await new Promise<void>((resolve) => term.write(data, resolve));
    layer.update();
    return layer.placements.map((placement) => `${placement.ref} ${placement.left},${placement.top} rows ${placement.firstRow}-${placement.lastRow}`);
  };
  return { term, layer, write };
}

/**
 * herdr 0.9.5 attach bytes, captured from an isolated herdr by scripts/terminal-image-attach-probe.ts
 * (server WebSocket; a loopback MachineRelay carried the same bytes). `{URIn}` stands for the marker URI
 * of row n. draw: five markers of a 12 x 6 image at column 14, rows 4..8, and one more at row 12;
 * bare: the program rewrote row 8's marker as U+2800 without the link; bareAll: rows 4..7 too;
 * restore: the markers written again.
 */
const HERDR_MARKER_FRAMES = {
  draw: "\u001b[?2026h\u001b[?25l\u001b]8;;\u001b\\\u001b[5;3H\u001b[0;39;48;5;236m            \u001b]8;;{URI1}\u001b\\\u2800\u001b[6;3H\u001b]8;;\u001b\\            \u001b]8;;{URI2}\u001b\\\u2800\u001b[7;3H\u001b]8;;\u001b\\            \u001b]8;;{URI3}\u001b\\\u2800\u001b[8;3H\u001b]8;;\u001b\\            \u001b]8;;{URI4}\u001b\\\u2800\u001b[9;3H\u001b]8;;\u001b\\            \u001b]8;;{URI5}\u001b\\\u2800\u001b[13;15H\u001b[0;39;49m\u001b]8;;\u001b\\\u001b]8;;{URI1}\u001b\\\u2800\u001b]8;;\u001b\\\u001b[0m\u001b[21;1H\u001b[?25h\u001b[?2026l\u001b[21;1H\u001b[?25h",
  bare: "\u001b[?2026h\u001b[?25l\u001b]8;;\u001b\\\u001b[9;15H\u001b[0;39;48;5;236m\u2800\u001b[0m\u001b[21;1H\u001b[?25h\u001b[?2026l\u001b[21;1H\u001b[?25h",
  bareAll: "\u001b[?2026h\u001b[?25l\u001b]8;;\u001b\\\u001b[5;15H\u001b[0;39;49m\u2800\u001b[6;15H\u2800\u001b[7;15H\u2800\u001b[8;15H\u2800\u001b[0m\u001b[21;1H\u001b[?25h\u001b[?2026l\u001b[21;1H\u001b[?25h",
  restore: "\u001b[?2026h\u001b[?25l\u001b]8;;\u001b\\\u001b[5;15H\u001b[0;39;48;5;236m\u001b]8;;{URI1}\u001b\\\u2800\u001b[6;15H\u001b]8;;\u001b\\\u001b]8;;{URI2}\u001b\\\u2800\u001b[7;15H\u001b]8;;\u001b\\\u001b]8;;{URI3}\u001b\\\u2800\u001b[8;15H\u001b]8;;\u001b\\\u001b]8;;{URI4}\u001b\\\u2800\u001b[9;15H\u001b]8;;\u001b\\\u001b]8;;{URI5}\u001b\\\u2800\u001b]8;;\u001b\\\u001b[0m\u001b[21;1H\u001b[?25h\u001b[?2026l\u001b[21;1H\u001b[?25h",
} as const;

describe("terminal image markers from real herdr attach bytes", () => {
  it("drops a marker herdr rewrote as a bare U+2800, keeps the rest, and takes it back when rewritten", async () => {
    const { term, write } = terminal(80, 24);
    const frame = (name: keyof typeof HERDR_MARKER_FRAMES) => HERDR_MARKER_FRAMES[name].replace(/\{URI(\d)\}/g, (_, y: string) => uri(Number(y)));
    expect(await write(frame("draw"))).toEqual(["pi:call_01:0 2,3 rows 3-8", "pi:call_01:0 2,11 rows 11-12"]);
    expect(await write(frame("bare"))).toEqual(["pi:call_01:0 2,3 rows 3-7", "pi:call_01:0 2,11 rows 11-12"]);
    // the cell still shows U+2800: only the link went
    expect(term.buffer.active.getLine(8)?.getCell(14)?.getChars()).toBe("\u2800");
    expect(await write(frame("bareAll"))).toEqual(["pi:call_01:0 2,11 rows 11-12"]);
    expect(await write(frame("restore"))).toEqual(["pi:call_01:0 2,3 rows 3-8", "pi:call_01:0 2,11 rows 11-12"]);
  });

  it("is not thrown by where the stream is cut into chunks", async () => {
    const { write } = terminal(80, 24);
    const draw = HERDR_MARKER_FRAMES.draw.replace(/\{URI(\d)\}/g, (_, y: string) => uri(Number(y)));
    // one write per character: an OSC, its U+2800 and the end of its link in separate writes
    for (const char of draw.slice(0, -1)) await write(char);
    expect(await write(draw.slice(-1))).toEqual(["pi:call_01:0 2,3 rows 3-8", "pi:call_01:0 2,11 rows 11-12"]);
  });
});

describe("terminal image markers on a real xterm", () => {
  it("follows the terminal's writes (xterm 5.5's print), and lets go on dispose", () => {
    const { term, layer } = terminal();
    const handler = (term as unknown as { _core: { _inputHandler: object } })._core._inputHandler;
    expect(layer.following).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(handler, "print")).toBe(true);
    layer.dispose();
    expect(Object.prototype.hasOwnProperty.call(handler, "print")).toBe(false);
  });

  it("places an image where herdr writes its markers", async () => {
    const { write } = terminal();
    expect(await write(image())).toEqual(["pi:call_01:0 2,3 rows 3-8"]);
    // a frame that rewrites the same markers (a redraw) keeps it where it is
    expect(await write(image())).toEqual(["pi:call_01:0 2,3 rows 3-8"]);
    // a provider's composite id (OpenAI Responses `${call_id}|${item id}`), punctuated, is the same
    const { write: writeComposite } = terminal();
    expect(await writeComposite(image("pi:call_E2E|fc_(x)*!':0"))).toEqual(["pi:call_E2E|fc_(x)*!':0 2,3 rows 3-8"]);
  });

  it("forgets a marker cell overwritten by U+2800 without its link (the glyph alone proves nothing)", async () => {
    const { write } = terminal();
    await write(image());
    // herdr rewrites a cell whose link went: the bare character, the link already ended
    expect(await write(`${at(8, 14)}\u2800`)).toEqual(["pi:call_01:0 2,3 rows 3-7"]);
    // with an explicit end of link first, as herdr writes it after a linked cell
    expect(await write(`\x1b]8;;https://example.com/\x1b\\x${at(7, 14)}\x1b]8;;\x1b\\\u2800`)).toEqual(["pi:call_01:0 2,3 rows 3-6"]);
    // every marker overwritten so: the image is gone, though every cell still shows U+2800
    expect(await write([4, 5, 6].map((row) => `${at(row, 14)}\u2800`).join(""))).toEqual([]);
  });

  it("draws only the rows that still carry a marker, and not the image line over an overwritten first marker", async () => {
    const { write } = terminal();
    await write(image());
    expect(await write(`${at(6, 14)}\u2800`)).toEqual(["pi:call_01:0 2,3 rows 3-5", "pi:call_01:0 2,3 rows 7-8"]);
    // the first marker (y = 1, row 4) overwritten: row 4 is not taken for the image line
    expect(await write(`${at(4, 14)}\u2800`)).toEqual(["pi:call_01:0 2,3 rows 5-5", "pi:call_01:0 2,3 rows 7-8"]);
  });

  it("ends a marker under another link, a run printed through it, or a different marker", async () => {
    const { write } = terminal();
    await write(image());
    expect(await write(`${at(8, 14)}\x1b]8;;https://example.com/\x1b\\\u2800\x1b]8;;\x1b\\`)).toEqual(["pi:call_01:0 2,3 rows 3-7"]);
    expect(await write(`${at(7, 12)}ab\u2800`)).toEqual(["pi:call_01:0 2,3 rows 3-6"]);
    // another image's marker written over this one's cell: that cell is the other image's now
    expect(await write(at(6, 14) + marker(1, "pi:call_02:0"))).toEqual(["pi:call_01:0 2,3 rows 3-5", "pi:call_02:0 2,5 rows 5-6"]);
  });

  it("marks nothing for a marker link with no cell, more than one, or a forged one", async () => {
    const { write } = terminal();
    expect(await write(`${at(4, 14)}\x1b]8;;${uri(1)}\x1b\\\x1b]8;;\x1b\\`)).toEqual([]);
    expect(await write(`${at(4, 14)}\x1b]8;;${uri(1)}\x1b\\\u2800\u2800\x1b]8;;\x1b\\`)).toEqual([]);
    expect(await write(`${at(4, 14)}\x1b]8;;x-pi-image:v1?s=x\x1b\\\u2800\x1b]8;;\x1b\\`)).toEqual([]);
    // printing after a marker's own cell, under its link still open, adds nothing
    expect(await write(`${at(9, 20)}\x1b]8;;${uri(2)}\x1b\\\u2800${at(10, 20)}\u2800\x1b]8;;\x1b\\`)).toEqual(["pi:call_01:0 8,7 rows 8-9"]);
  });

  it("forgets markers on erase, scroll, inserted characters and reset; the next full frame brings them back", async () => {
    const { write } = terminal();
    await write(image());
    expect(await write(`${at(8, 0)}\x1b[2K`)).toEqual(["pi:call_01:0 2,3 rows 3-7"]);
    expect(await write(`${at(7, 0)}\x1b[2@`)).toEqual(["pi:call_01:0 2,3 rows 3-6"]);
    expect(await write(image())).toEqual(["pi:call_01:0 2,3 rows 3-8"]);
    // a line feed at the bottom scrolls every row: nothing herdr wrote stays where it was noted
    expect(await write(`${at(11, 0)}\n`)).toEqual([]);
    // herdr's full frame: erase, then every cell again
    expect(await write(`\x1b[2J${image()}`)).toEqual(["pi:call_01:0 2,3 rows 3-8"]);
    expect(await write("\x1b[3S")).toEqual([]);
    expect(await write(`\x1b[2J${image()}`)).toEqual(["pi:call_01:0 2,3 rows 3-8"]);
    expect(await write("\x1bc")).toEqual([]);
    // after a reset the stream's open link is gone too: a bare U+2800 marks nothing
    expect(await write(`\x1b]8;;${uri(1)}\x1b\\\x1bc${at(4, 14)}\u2800`)).toEqual([]);
  });

  it("records no more than a screen can honestly hold", () => {
    const markers = new TerminalImageMarkers();
    for (let i = 0; i < MAX_MARKER_CELLS + 50; i++) {
      const x = 14 + (i % 50), y = Math.floor(i / 50);
      markers.hyperlink(link(1, `pi:call_${i}:0`));
      markers.printed({ x, y }, { x: x + 1, y }, 200);
    }
    expect(markers.size).toBe(MAX_MARKER_CELLS);
    markers.clear();
    expect(markers.size).toBe(0);
  });
});

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

describe("imageDimensions", () => {
  it("reads the header of each supported type without decoding", () => {
    expect(imageDimensions(png(64, 32), "image/png")).toEqual({ width: 64, height: 32 });
    expect(imageDimensions(new Uint8Array([...new TextEncoder().encode("GIF89a"), 10, 0, 20, 0]), "image/gif")).toEqual({ width: 10, height: 20 });
    // JPEG: SOI, an APP0 segment, then SOF0 with height 300 and width 400
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0]);
    expect(imageDimensions(jpeg, "image/jpeg")).toEqual({ width: 400, height: 300 });
    const webp = new Uint8Array(30);
    webp.set(new TextEncoder().encode("RIFF"), 0);
    webp.set(new TextEncoder().encode("WEBPVP8X"), 8);
    webp.set([99, 0, 0, 49, 0, 0], 24);
    expect(imageDimensions(webp, "image/webp")).toEqual({ width: 100, height: 50 });
  });

  it("answers null for bytes that are not the type they claim", () => {
    expect(imageDimensions(png(1, 1), "image/jpeg")).toBeNull();
    expect(imageDimensions(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml")).toBeNull();
    expect(imageDimensions(new Uint8Array([0x89, 0x50]), "image/png")).toBeNull();
  });
});

const answer = (body: Uint8Array, headers: Record<string, string> = {}, status = 200) =>
  new Response(body as Uint8Array<ArrayBuffer>, { status, headers: { "content-type": "image/png", "x-herdr-pi-session": SESSION, ...headers } });
// fixed wait: one macrotask turn lets the stubbed fetch, read and decode chains settle
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await Bun.sleep(1); };

describe("TerminalImageLoader", () => {
  const decode = async (blob: Blob) => ({ url: `blob:${blob.size}`, width: 1, height: 1 });
  const none = () => new Set<string>();

  it("draws an image only with the session echo, a supported type and a sane size", async () => {
    const answers: Record<string, () => Response> = {
      ok: () => answer(png(64, 64)),
      old: () => answer(png(64, 64), { "x-herdr-pi-session": "" }),
      other: () => answer(png(64, 64), { "x-herdr-pi-session": "another-session" }),
      svg: () => answer(new TextEncoder().encode("<svg/>"), { "content-type": "image/svg+xml" }),
      liar: () => answer(new TextEncoder().encode("<svg/>")),
      huge: () => answer(png(IMAGE_LIMITS.side + 1, 2)),
      wide: () => answer(png(4096, 4097)),
      big: () => answer(new Uint8Array(IMAGE_LIMITS.bytes + 1)),
    };
    const loader = new TerminalImageLoader(decode, async (url) => answers[url]!());
    let changes = 0;
    loader.onChange = () => { changes++; };
    for (const key of Object.keys(answers)) expect(loader.get(key, key, SESSION, none)).toBeNull();
    await flush();
    expect(loader.get("ok", "ok", SESSION, none)?.url).toMatch(/^blob:/);
    for (const key of Object.keys(answers).filter((key) => key !== "ok")) expect(loader.get(key, key, SESSION, none)).toBeNull();
    expect(Object.fromEntries(loader.refusals.map(({ key, reason }) => [key, reason]))).toEqual({
      old: "session", other: "session", svg: "type", liar: "header", huge: "pixels", wide: "pixels", big: "size",
    });
    expect(changes).toBe(1);
    loader.dispose();
  });

  it("asks again for an image the pane's session has not written yet, and once for a forged one", async () => {
    let now = 0;
    const asked: string[] = [];
    let written = false;
    const loader = new TerminalImageLoader(decode, async (url) => {
      asked.push(url);
      if (url === "late") return written ? answer(png(8, 8)) : new Response("{}", { status: 404 });
      return answer(png(8, 8), { "content-type": "image/svg+xml" });
    }, () => now);
    loader.get("late", "late", SESSION, none);
    loader.get("forged", "forged", SESSION, none);
    await flush();
    // within the back-off nothing is asked again; a refused type is never asked again
    expect(loader.get("late", "late", SESSION, none)).toBeNull();
    now = 2_000;
    written = true;
    loader.get("forged", "forged", SESSION, none);
    expect(loader.get("late", "late", SESSION, none)).toBeNull();
    await flush();
    expect(loader.get("late", "late", SESSION, none)).not.toBeNull();
    expect(asked).toEqual(["late", "forged", "late"]);
    loader.dispose();
  });

  it("decodes two at a time and keeps the cache bounded without dropping what is on screen", async () => {
    let running = 0, peak = 0, decoded = 0;
    const loader = new TerminalImageLoader(async (blob) => {
      running++; peak = Math.max(peak, running);
      // fixed wait: a decode that takes time, so loads overlap and the limit shows
      await Bun.sleep(2);
      running--; decoded++;
      return { url: `blob:${blob.size}`, width: 1, height: 1 };
    }, async () => answer(png(8, 8)));
    const keys = Array.from({ length: IMAGE_LIMITS.entries + 8 }, (_, i) => `k${i}`);
    const shown = new Set(["k0"]);
    for (const key of keys) loader.get(key, key, SESSION, () => shown);
    for (let i = 0; i < 200 && decoded < keys.length; i++) await Bun.sleep(5);
    await flush();
    expect(peak).toBe(IMAGE_LIMITS.concurrent);
    expect(loader.cached).toBe(IMAGE_LIMITS.entries);
    expect(loader.get("k0", "k0", SESSION, () => shown)).not.toBeNull();
    loader.dispose();
    expect(loader.cached).toBe(0);
  });
});

describe("terminalImageSource", () => {
  const placement = { image: `${SESSION}\npi:call_01:0\n${DIGEST}`, ref: "pi:call_01:0", session: SESSION, digest: DIGEST };

  it("asks the terminal's own PC and pane, with the marker's session and digest", () => {
    const local = terminalImageSource("local", "w1:p1", placement)!;
    expect(local.url).toBe(`/api/pane/conversation/image?pane_id=w1%3Ap1&ref=pi%3Acall_01%3A0&session=${SESSION}&digest=${DIGEST}`);
    const remote = terminalImageSource("pc 2", "w1:p1", placement)!;
    expect(remote.url.startsWith("/api/machines/pc%202/pane/conversation/image?pane_id=w1%3Ap1&")).toBe(true);
    // the same ref and session on two PCs, or two panes, are two images
    expect(new Set([local.key, remote.key, terminalImageSource("local", "w1:p2", placement)!.key]).size).toBe(3);
    expect(terminalImageSource("local", null, placement)).toBeNull();
  });

  it("sends a composite tool call id whole, so the PC's server reads back the marker's own ref", () => {
    const ref = "pi:call_E2E|fc_(x)*!'+/=:0";
    const composite = { image: `${SESSION}\n${ref}\n${DIGEST}`, ref, session: SESSION, digest: DIGEST };
    for (const machine of ["local", "pc 2"]) {
      const url = new URL(terminalImageSource(machine, "w1:p1", composite)!.url, "http://127.0.0.1");
      expect(url.pathname).toBe(machine === "local" ? "/api/pane/conversation/image" : "/api/machines/pc%202/pane/conversation/image");
      expect(Object.fromEntries(url.searchParams)).toEqual({ pane_id: "w1:p1", ref, session: SESSION, digest: DIGEST });
    }
  });
});

describe("terminalImageGallery", () => {
  const origin = "http://127.0.0.1:7391";

  it("opens a tool image by the chat's own URL, which image comments take as a conversation source", () => {
    const ref = "pi:call_E2E|fc_(x)*!'+/=:0";
    for (const machine of ["local", "pc 2"]) {
      const image = terminalImageGallery(machine, "w1:p1", { ref }, "image/jpeg", "Attached image")!;
      const url = new URL(image.src, origin);
      expect(url.pathname).toBe(machine === "local" ? "/api/pane/conversation/image" : "/api/machines/pc%202/pane/conversation/image");
      expect(Object.fromEntries(url.searchParams)).toEqual({ pane_id: "w1:p1", ref });
      expect(image).toMatchObject({ name: "Attached image", file: "image-1.jpg" });
      expect(sourceFromImage(image.src, machine, "w1:p1", origin)).toEqual({ kind: "conversation", ref });
    }
  });

  it("opens a pasted picture by its file, as an @path mention is, which image comments take as a file source", () => {
    const path = "/home/u/.herdr-web-ui/붙여넣기 #1 100%.png";
    for (const machine of ["local", "pc 2"]) {
      const image = terminalImageGallery(machine, "w1:p1", { ref: `file:${path}` }, "image/png", "Attached image")!;
      const url = new URL(image.src, origin);
      expect(url.pathname).toBe(machine === "local" ? "/api/fs/file" : "/api/machines/pc%202/fs/file");
      expect(Object.fromEntries(url.searchParams)).toEqual({ path, pane_id: "w1:p1" });
      expect(image).toMatchObject({ name: path, file: "붙여넣기 #1 100%.png" });
      expect(sourceFromImage(image.src, machine, "w1:p1", origin)).toEqual({ kind: "file", path });
    }
  });

  it("opens nothing for a ref that is neither", () => {
    expect(terminalImageGallery("local", "w1:p1", { ref: "0123abcd-0000-0000-0000-000000000000:0" }, "image/png", "x")).toBeNull();
    expect(terminalImageGallery("local", "w1:p1", { ref: "file:relative.png" }, "image/png", "x")).toBeNull();
  });

  it("places a pasted picture's file-ref markers like a tool image's", async () => {
    const { write } = terminal();
    expect(await write(image("file:/home/u/.herdr-web-ui/paste 1.png"))).toEqual(["file:/home/u/.herdr-web-ui/paste 1.png 2,3 rows 3-8"]);
  });
});

