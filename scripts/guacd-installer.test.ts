import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const installer = "install-guacd-h264-ubuntu26.04-v3.sh";
const companion = "install-guacd-h264-ubuntu26.04-v3.check.sh";

describe("retained Ubuntu 26.04 guacd installer", () => {
  it("keeps the latest actual revision and its check companion, not the superseded installers", () => {
    expect(readdirSync(root).filter((name) => /^install-guacd-h264-ubuntu26\.04.*\.sh$/.test(name)).sort())
      .toEqual([companion, installer]);
    const source = readFileSync(resolve(root, installer), "utf8");
    expect(source).toContain("# Revision 4");
    expect(source).toContain("GUACAMOLE-2136");
    expect(source).toContain("GUACAMOLE-2070");
    expect(source).toContain("probe_h264_decoder");
    // Recovery did not disappear with the old -resume.sh: the latest installer owns it too.
    expect(source).toContain("--resume: reuse installed FreeRDP and finish guacd");
    const check = readFileSync(resolve(root, companion), "utf8");
    expect(check).toContain(`installer=$here/${installer}`);
    expect(check).toContain("the installer's main flow is never executed");
  });

  it("parses both scripts and shows installer help without installing or starting anything", () => {
    if (!Bun.which("bash")) return; // native Windows has no bash; inventory is still checked above
    for (const name of [installer, companion]) {
      const parsed = Bun.spawnSync(["bash", "-n", resolve(root, name)]);
      expect(parsed.exitCode).toBe(0);
    }
    const help = Bun.spawnSync(["bash", resolve(root, installer), "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain(`${installer} [--resume [BUILD_DIRECTORY]]`);
    expect(help.stdout.toString()).toContain("Nothing is deleted.");
  });
});
