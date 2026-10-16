import { describe, expect, it } from "bun:test";

import { parseTerminalImageMarker, terminalImagePlacements, TERMINAL_IMAGE_URI_MAX, type MarkerCell } from "./terminal-images.ts";

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
      uri({ ...base, ref: encodeURIComponent(`pi:${"a".repeat(130)}:0`) }),
      `${uri(base)}&pad=${"a".repeat(TERMINAL_IMAGE_URI_MAX)}`,
      uri(base).replace("&h=", "&h=%0A"),
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
