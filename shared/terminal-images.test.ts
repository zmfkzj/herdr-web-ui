import { describe, expect, it } from "bun:test";

import { isPiToolCallId, parsePiFileRef, parsePiImageRef, parseTerminalImageMarker, PI_FILE_REF_PATH_MAX, PI_TOOL_CALL_ID_MAX, terminalImagePlacements, TERMINAL_IMAGE_URI_MAX, type MarkerCell } from "./terminal-images.ts";

const DIGEST = "0123456789abcdef0123456789abcdef";
const uri = (fields: Record<string, string | number>) => `x-pi-image:v1?${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("&")}`;
const base = { s: "0190abcd-0000-7000-8000-000000000001", ref: encodeURIComponent("pi:call_01:0"), h: DIGEST, c: 12, r: 6, y: 1 };

describe("terminal image markers", () => {
  it("reads the extension's v1 URI in any key order", () => {
    expect(parseTerminalImageMarker(uri(base))).toEqual({ session: base.s, ref: "pi:call_01:0", digest: DIGEST, cols: 12, rows: 6, row: 1 });
    const { y, ...rest } = base;
    expect(parseTerminalImageMarker(uri({ y, ...rest }))?.row).toBe(1);
    expect(parseTerminalImageMarker(uri({ ...base, r: 1, y: 0 }))?.row).toBe(0);
  });

  it("refuses forged, partial and oversized markers", () => {
    const refused = [
      "x-pi-image:v2?" + uri(base).split("?")[1],
      "https://example.com/?" + uri(base).split("?")[1],
      uri({ ...base, extra: 1 }),
      `${uri(base)}&y=2`,
      uri({ s: base.s, ref: base.ref, h: base.h, c: 12, r: 6 }),
      // another session id shape, a path, a URL, an absolute file as the ref
      uri({ ...base, s: "../etc" }),
      uri({ ...base, ref: encodeURIComponent("/etc/passwd") }),
      uri({ ...base, ref: encodeURIComponent("https://evil.example/x.png") }),
      uri({ ...base, ref: encodeURIComponent("0123abcd-0000-0000-0000-000000000000:0") }),
      uri({ ...base, ref: "%E0%A4%A" }),
      uri({ ...base, h: DIGEST.toUpperCase() }),
      uri({ ...base, h: DIGEST.slice(1) }),
      uri({ ...base, c: 0 }), uri({ ...base, r: 1001 }), uri({ ...base, c: "012" }), uri({ ...base, c: -1 }),
      uri({ ...base, y: 6 }),
      // a taller image never marks its image line
      uri({ ...base, y: 0 }),
      // the URI cap bounds a marker's ref whatever its id (docs/terminal-images.md)
      uri({ ...base, ref: encodeURIComponent(`pi:${"a".repeat(TERMINAL_IMAGE_URI_MAX)}:0`) }),
      `${uri(base)}&pad=${"a".repeat(TERMINAL_IMAGE_URI_MAX)}`,
      uri(base).replace("&h=", "&h=%0A"),
    ];
    for (const value of refused) expect(parseTerminalImageMarker(value)).toBeNull();
  });
});

describe("pasted pictures' file refs in markers", () => {
  it("reads `file:<absolute path>` as the extension encodes it, Korean, spaces, `#` and `%` included", () => {
    const path = "/home/u/.herdr-web-ui/붙여넣기 #1 100%.png";
    expect(parseTerminalImageMarker(uri({ ...base, ref: rfc3986(`file:${path}`) }))?.ref).toBe(`file:${path}`);
    expect(parsePiFileRef(`file:${path}`)).toEqual({ path });
    expect(parsePiFileRef("file:C:\\Users\\a.png")).toEqual({ path: "C:\\Users\\a.png" });
  });

  it("refuses relative, dotted, control-character and oversized paths, and anything past the URI cap", () => {
    for (const ref of ["file:", "file:/", "file:shot.png", "file:~/shot.png", "file:/tmp/../etc/a.png", "file:/tmp/./a.png", "file:/tmp/a\nb.png",
      "file:/tmp/a\u0000.png", `file:/${"a".repeat(PI_FILE_REF_PATH_MAX)}`, "FILE:/tmp/a.png", "file://host/a.png"]) {
      expect([ref, parsePiFileRef(ref)]).toEqual([ref, ref === "file://host/a.png" ? { path: "//host/a.png" } : null]);
      if (ref !== "file://host/a.png") expect(parseTerminalImageMarker(uri({ ...base, ref: rfc3986(ref) }))).toBeNull();
    }
    expect(parseTerminalImageMarker(uri({ ...base, ref: rfc3986(`file:/${"한".repeat(60)}.png`) }))).toBeNull();
    // the image endpoint's tool refs are unchanged
    expect(parsePiImageRef("file:/tmp/a.png")).toBeNull();
  });
});

/** The extension's value encoding: encodeURIComponent, plus RFC 3986's `!'()*` (it leaves those raw). */
const rfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

describe("pi tool call ids in markers", () => {
  // synthetic ids in the shapes pi stores: OpenAI Responses `${call_id}|${item id}` (pi-ai's
  // openai-responses-shared), an Anthropic-style call id behind the same pipe, a base64-ish item id,
  // punctuation RFC 3986 escapes, and the simple ids markers carried before
  const ids = [
    "call_E2E|fc_0123abcd",
    "toolu_01E2EsyntheticAbCdEf|fc_0123abcd",
    "call_test|fc_(x)*!'",
    "call_b64|fc_AbC+/dEf==",
    "call:with:colons|fc_9:0",
    `call_q"uote\\back<>{}[]^\`~#$&@;,?=|fc_1`,
    "call_01", "call-1", "toolu_01AbCdEf",
  ];

  it("reads the exact opaque id, however it is punctuated, as the extension encodes it", () => {
    for (const id of ids) {
      const ref = `pi:${id}:0`;
      expect(parseTerminalImageMarker(uri({ ...base, ref: rfc3986(ref) }))?.ref).toBe(ref);
      // the index is the last colon's digits: an id may hold colons and digits of its own
      expect(parseTerminalImageMarker(uri({ ...base, ref: rfc3986(`pi:${id}:123`) }))?.ref).toBe(`pi:${id}:123`);
    }
    // decoded once: an escape inside the id stays the literal characters it was
    expect(parseTerminalImageMarker(uri({ ...base, ref: rfc3986("pi:call_E2E%7Cfc_1:0") }))?.ref).toBe("pi:call_E2E%7Cfc_1:0");
  });

  it("splits a ref at its last colon, and bounds the id by characters and length alone", () => {
    expect(parsePiImageRef("pi:call_E2E|fc_0123abcd:0")).toEqual({ toolCallId: "call_E2E|fc_0123abcd", index: 0 });
    expect(parsePiImageRef("pi:a:1:2:345")).toEqual({ toolCallId: "a:1:2", index: 345 });
    expect(parsePiImageRef("pi:a::7")).toEqual({ toolCallId: "a:", index: 7 });
    expect(parsePiImageRef("pi::a:7")).toEqual({ toolCallId: ":a", index: 7 });
    for (const bad of ["pi::0", "pi:0", "pi:", "pi:a:", "pi:a:b", "pi:a:1\n", "pi:a\n:1", "pi:a:01234", "xpi:a:0", " pi:a:0"]) expect(parsePiImageRef(bad)).toBeNull();
    const longest = "x".repeat(PI_TOOL_CALL_ID_MAX);
    expect(PI_TOOL_CALL_ID_MAX).toBe(1024);
    expect(isPiToolCallId(longest) && parsePiImageRef(`pi:${longest}:0`)?.toolCallId === longest).toBe(true);
    expect(isPiToolCallId(`${longest}x`) || parsePiImageRef(`pi:${longest}x:0`) !== null).toBe(false);
    // every printable ASCII character but space, and nothing else
    const printable = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join("");
    expect(isPiToolCallId(printable)).toBe(true);
    for (let code = 0; code < 0x110; code++) {
      if (code >= 0x21 && code <= 0x7e) continue;
      const char = String.fromCharCode(code);
      for (const id of [char, `call${char}`, `${char}call`, `ca${char}ll`]) expect(isPiToolCallId(id)).toBe(false);
    }
    expect(isPiToolCallId("")).toBe(false);
  });

  it("takes the longest id the URI cap leaves room for, and nothing past the cap", () => {
    const at = (length: number) => uri({ ...base, ref: rfc3986(`pi:call_E2E|fc_${"a".repeat(length)}:0`) });
    const fits = TERMINAL_IMAGE_URI_MAX - at(0).length;
    expect(at(fits).length).toBe(TERMINAL_IMAGE_URI_MAX);
    expect(parseTerminalImageMarker(at(fits))?.ref).toBe(`pi:call_E2E|fc_${"a".repeat(fits)}:0`);
    expect(parseTerminalImageMarker(at(fits + 1))).toBeNull();
  });

  it("refuses ids that are no printable ASCII word, and refs that are malformed", () => {
    const refused = [
      // the query stays RFC 3986: an unescaped pipe, or the raw `!'()*` plain encodeURIComponent leaves
      uri({ ...base, ref: `pi%3Acall_E2E|fc_0123abcd%3A0` }),
      uri({ ...base, ref: encodeURIComponent("pi:call_test|fc_(x)*!':0") }),
      // space, control characters, DEL and anything outside ASCII, encoded
      ...["%20", "%09", "%0A", "%0D", "%00", "%1B", "%7F", "%C3%A9", "%E2%80%A8", "%E2%A0%80"].map((bad) => uri({ ...base, ref: `pi%3Acall_E2E${bad}fc_1%3A0` })),
      // a line feed closing the id or the index
      uri({ ...base, ref: "pi%3Acall_E2E%7Cfc_1%0A%3A0" }),
      uri({ ...base, ref: "pi%3Acall_E2E%7Cfc_1%3A0%0A" }),
      // no id, no index, an index too long or not a number, no `pi:`, a truncated escape
      uri({ ...base, ref: rfc3986("pi::0") }),
      uri({ ...base, ref: rfc3986("pi:call_E2E|fc_0123abcd") }),
      uri({ ...base, ref: rfc3986("pi:call_E2E|fc_0123abcd:") }),
      uri({ ...base, ref: rfc3986("pi:call_E2E|fc_0123abcd:1000") }),
      uri({ ...base, ref: rfc3986("pi:call_E2E|fc_0123abcd:-1") }),
      uri({ ...base, ref: rfc3986("call_E2E|fc_0123abcd:0") }),
      uri({ ...base, ref: rfc3986("PI:call_E2E|fc_0123abcd:0") }),
      uri({ ...base, ref: "pi%3Acall_E2E%7Cfc_0123abcd%3A0%7" }),
      uri({ ...base, ref: "pi%3Acall_E2E%7" }),
    ];
    for (const value of refused) expect(parseTerminalImageMarker(value)).toBeNull();
  });
});

const cell = (x: number, y: number, row: number, fields: Partial<typeof base> = {}): MarkerCell => ({
  x, y, marker: parseTerminalImageMarker(uri({ ...base, ...fields, y: row }))!,
});
const screen = { cols: 80, rows: 24 };

describe("terminal image placements", () => {
  it("places an image left of its marker column, from the row above the first marker", () => {
    // a 12x6 image at column 2, row 3: markers at column 14 on rows 4..8 (y = 1..5)
    const placements = terminalImagePlacements([1, 2, 3, 4, 5].map((row) => cell(14, 3 + row, row)), screen);
    expect(placements).toEqual([{ image: `${base.s}\npi:call_01:0\n${DIGEST}`, session: base.s, ref: "pi:call_01:0", digest: DIGEST, left: 2, top: 3, cols: 12, rows: 6, firstRow: 3, lastRow: 8 }]);
  });

  it("clips the rows pi scrolled away or cropped", () => {
    // scrolled up by three: rows y = 4, 5 remain at screen rows 1, 2; y = 3 is the cropped image line at row 0
    expect(terminalImagePlacements([cell(14, 1, 4), cell(14, 2, 5)], screen)[0]).toMatchObject({ top: -3, firstRow: 0, lastRow: 2 });
    // pi's fullscreen crop at the bottom: only y = 1, 2 painted, so rows top..top+2
    expect(terminalImagePlacements([cell(14, 11, 1), cell(14, 12, 2)], screen)[0]).toMatchObject({ top: 10, firstRow: 10, lastRow: 12 });
    // a one-row image marks its own row
    expect(terminalImagePlacements([cell(14, 5, 0, { r: 1 })], screen)[0]).toMatchObject({ top: 5, firstRow: 5, lastRow: 5 });
  });

  it("draws only rows that carry a marker, apart around a lost one, and no image line over a bare U+2800", () => {
    // y = 3 (row 6) lost its marker: rows 3..5 and 7..8
    const gap = [1, 2, 4, 5].map((row) => cell(14, 3 + row, row));
    expect(terminalImagePlacements(gap, screen).map((placement) => [placement.firstRow, placement.lastRow])).toEqual([[3, 5], [7, 8]]);
    // y = 1 (row 4) lost its marker and still shows U+2800 there: the image line is not taken over it
    const first = [2, 3, 4, 5].map((row) => cell(14, 3 + row, row));
    expect(terminalImagePlacements(first, screen, (x, y) => x === 14 && y === 4).map((placement) => [placement.firstRow, placement.lastRow])).toEqual([[5, 8]]);
    expect(terminalImagePlacements(first, screen).map((placement) => [placement.firstRow, placement.lastRow])).toEqual([[4, 8]]);
  });

  it("draws the same picture in each place it stands", () => {
    // pi names identical bytes under two tool calls by one ref: two footprints, two placements
    const twice = [cell(14, 2, 1), cell(14, 3, 2), cell(14, 12, 1), cell(14, 13, 2)];
    expect(terminalImagePlacements(twice, screen).map((placement) => placement.top)).toEqual([1, 11]);
  });

  it("keeps different images and the same picture under another tool call apart", () => {
    const two = [cell(14, 2, 1), cell(14, 9, 1, { ref: encodeURIComponent("pi:call_02:0") }), cell(30, 9, 1, { ref: encodeURIComponent("pi:call_02:1"), c: 10 })];
    expect(terminalImagePlacements(two, screen).map((placement) => [placement.ref, placement.left, placement.top])).toEqual([
      ["pi:call_01:0", 2, 1], ["pi:call_02:0", 2, 8], ["pi:call_02:1", 20, 8],
    ]);
  });

  it("ignores cells that place the image off the grid", () => {
    expect(terminalImagePlacements([cell(5, 2, 1)], screen)).toEqual([]);
    expect(terminalImagePlacements([cell(90, 2, 1)], screen)).toEqual([]);
    expect(terminalImagePlacements([cell(14, 30, 1)], screen)).toEqual([]);
  });
});
