import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const installer = "install-guacd-h264-ubuntu26.04-v3.sh";
const companion = "install-guacd-h264-ubuntu26.04-v3.check.sh";
const hasBash = !!Bun.which("bash"); // native Windows has no bash; the inventory is still checked
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "guacd-installer-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs bash with only the installer's function block loaded: its main flow never runs. */
function functions(script: string): { code: number; out: string } {
  const loaded = `set -Eeuo pipefail
eval "$(sed -n '/^# BEGIN testable functions/,/^# END testable functions$/p' "$INSTALLER")"
${script}`;
  const run = Bun.spawnSync(["bash", "-c", loaded], {
    env: { ...process.env, INSTALLER: resolve(root, installer), LC_ALL: "C" },
  });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

function osRelease(name: string, lines: string[]): string {
  const file = join(scratch, `os-release-${name}`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** A cached build directory as the installer leaves it, without sources or objects. */
function cachedBuild(home: string, name: string, gcc: string, target?: string): string {
  const dir = join(home, ".cache", "herdr-guacd", name);
  mkdirSync(join(dir, "freerdp"), { recursive: true });
  mkdirSync(join(dir, "freerdp-build", "CMakeFiles", "3.28.3"), { recursive: true });
  mkdirSync(join(dir, "guacamole", "src", "protocols", "rdp"), { recursive: true });
  writeFileSync(join(dir, "guacamole", "configure"), "");
  writeFileSync(join(dir, "guacamole", "src", "protocols", "rdp", "settings.c"), "");
  writeFileSync(join(dir, "freerdp-build", "CMakeCache.txt"),
    `CMAKE_INSTALL_PREFIX:PATH=/opt/herdr-guacd\nCMAKE_HOME_DIRECTORY:INTERNAL=${join(dir, "freerdp")}\n`);
  writeFileSync(join(dir, "freerdp-build", "CMakeFiles", "3.28.3", "CMakeCCompiler.cmake"),
    `set(CMAKE_C_COMPILER_VERSION "${gcc}")\n`);
  if (target) writeFileSync(join(dir, "herdr-build-target"), `# fixture\ntarget=${target}\n`);
  return dir;
}

describe("retained Ubuntu 24.04 / 26.04 guacd installer", () => {
  it("keeps one installer and its check companion, not superseded or per-release copies", () => {
    expect(readdirSync(root).filter((name) => name.startsWith("install-guacd")).sort())
      .toEqual([companion, installer]);
    const source = readFileSync(resolve(root, installer), "utf8");
    expect(source).toContain("# Revision 5 (Ubuntu 24.04 and 26.04)");
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
    if (!hasBash) return;
    for (const name of [installer, companion]) {
      const parsed = Bun.spawnSync(["bash", "-n", resolve(root, name)]);
      expect(parsed.exitCode).toBe(0);
    }
    const help = Bun.spawnSync(["bash", resolve(root, installer), "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain(`${installer} [--resume | --rebuild-guacd [BUILD_DIRECTORY]]`);
    expect(help.stdout.toString()).toContain("Supported: Ubuntu 24.04 LTS and 26.04 LTS");
    expect(help.stdout.toString()).toContain("Nothing is deleted.");
  });

  it("accepts Ubuntu 24.04 and 26.04 point releases and explains every other system", () => {
    if (!hasBash) return;
    const detect = (file: string, arch = "amd64") =>
      functions(`detect_target_release "${file}" ${arch} && echo "TARGET=$build_target"`);
    const noble = detect(osRelease("noble", ["ID=ubuntu", 'VERSION_ID="24.04"', "VERSION_CODENAME=noble",
      'PRETTY_NAME="Ubuntu 24.04.5 LTS"']));
    expect(noble.code).toBe(0);
    expect(noble.out).toContain("TARGET=ubuntu-24.04-amd64");
    const resolute = detect(osRelease("resolute", ["ID=ubuntu", 'VERSION_ID="26.04"',
      "VERSION_CODENAME=resolute", 'PRETTY_NAME="Ubuntu 26.04.1 LTS"']), "arm64");
    expect(resolute.code).toBe(0);
    expect(resolute.out).toContain("TARGET=ubuntu-26.04-arm64");

    const refused: [string, string[], string][] = [
      ["jammy", ["ID=ubuntu", "VERSION_ID=22.04", "VERSION_CODENAME=jammy"], "Unsupported Ubuntu release"],
      ["questing", ["ID=ubuntu", "VERSION_ID=25.10", "VERSION_CODENAME=questing"], "Unsupported Ubuntu release"],
      ["mint", ["ID=linuxmint", 'ID_LIKE="ubuntu debian"', "VERSION_ID=22.1", "UBUNTU_CODENAME=noble"],
        "Ubuntu derivatives and other distributions are not supported"],
      ["no-version", ["ID=ubuntu", "VERSION_CODENAME=noble"], "(VERSION_ID=missing)"],
      ["mixed", ["ID=ubuntu", "VERSION_ID=24.04", "VERSION_CODENAME=resolute"],
        "VERSION_ID=24.04 requires VERSION_CODENAME=noble, found resolute"],
    ];
    for (const [name, lines, message] of refused) {
      const result = detect(osRelease(name, lines));
      expect(result.code).not.toBe(0);
      expect(result.out).toContain(message);
      expect(result.out).not.toContain("TARGET=");
    }
    expect(detect(join(scratch, "missing-os-release")).out).toContain("Cannot read");
  });

  it("stops before apt installs anything when a dependency has no candidate", () => {
    if (!hasBash) return;
    const bin = join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "apt-cache"), `#!/bin/sh
printf '%s:\\n  Installed: (none)\\n' "$2"
if [ "$2" = ninja-build ]; then echo '  Candidate: (none)'; else echo '  Candidate: 1.0-1'; fi
`, { mode: 0o755 });
    const result = functions(`PATH="${bin}:$PATH" check_package_candidates`);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("for: ninja-build\n");
    expect(result.out).toContain("universe");
    const list = functions(`printf '%s\\n' "\${build_packages[@]}"`).out.trim().split("\n");
    expect(new Set(list).size).toBe(list.length);
    expect(list).toContain("libicu-dev");
  });

  it("resumes only cached builds and prefixes made for this release, keeping unrecorded 26.04 ones", () => {
    if (!hasBash) return;
    const home = join(scratch, "home");
    const noble = cachedBuild(home, "build.noble", "13.3.0", "ubuntu-24.04-amd64");
    const legacy = cachedBuild(home, "build.legacy", "15.2.0");
    const check = (target: string, gcc: number, dir: string) =>
      functions(`build_target=${target} host_gcc_major=${gcc} check_build_dir_target "${dir}"`);

    expect(check("ubuntu-24.04-amd64", 13, noble).code).toBe(0);
    expect(check("ubuntu-26.04-amd64", 15, noble).out)
      .toContain("was created for ubuntu-24.04-amd64; this system is ubuntu-26.04-amd64");
    expect(check("ubuntu-24.04-arm64", 13, noble).code).not.toBe(0);
    const kept = check("ubuntu-26.04-amd64", 15, legacy);
    expect(kept.code).toBe(0);
    expect(kept.out).toContain("earlier Ubuntu 26.04-only revision");
    expect(readdirSync(legacy)).not.toContain("herdr-build-target");
    expect(check("ubuntu-24.04-amd64", 13, legacy).out).toContain("cannot be reused on ubuntu-24.04-amd64");
    expect(check("ubuntu-26.04-amd64", 14, legacy).out).toContain("configured by GCC 15; /usr/bin/gcc is GCC 14");

    // Automatic selection skips the incompatible directory instead of counting it.
    const selected = functions(`HOME="${home}" prefix=/opt/herdr-guacd resume_dir= \
build_target=ubuntu-26.04-amd64 host_gcc_major=15; select_resume_work; echo "WORK=$work"`);
    expect(selected.code).toBe(0);
    expect(selected.out).toContain(`Skipping incompatible cached build ${noble}`);
    expect(selected.out).toContain(`WORK=${legacy}`);
    const explicit = functions(`HOME="${home}" prefix=/opt/herdr-guacd resume_dir="${noble}" \
build_target=ubuntu-26.04-amd64 host_gcc_major=15; select_resume_work`);
    expect(explicit.code).not.toBe(0);
    expect(explicit.out).toContain("cannot be resumed on this system; nothing was modified");

    const prefix = join(scratch, "prefix");
    mkdirSync(join(prefix, "share", "herdr-guacd"), { recursive: true });
    const prefixCheck = (target: string) =>
      functions(`prefix="${prefix}" build_target=${target} check_prefix_target`);
    expect(prefixCheck("ubuntu-26.04-amd64").out).toContain("no record (earlier Ubuntu 26.04-only revision)");
    expect(prefixCheck("ubuntu-24.04-amd64").code).not.toBe(0);
    writeFileSync(join(prefix, "share", "herdr-guacd", "build-target"), "target=ubuntu-24.04-amd64\n");
    expect(prefixCheck("ubuntu-24.04-amd64").code).toBe(0);
    expect(prefixCheck("ubuntu-26.04-amd64").out).toContain("was built for ubuntu-24.04-amd64");
  });

  // guacd 1.6.0 called gdi_init() in PreConnect; FreeRDP 3.31+ creates the cache it needs only later,
  // so every RDP connection aborted on WINPR_ASSERT(cache->brush) before the first frame
  it("moves guacd's GDI setup to PostConnect (GUACAMOLE-2328) once, and refuses partial or diverged rdp.c", () => {
    if (!hasBash || !Bun.which("python3")) return;
    const text = readFileSync(resolve(root, installer), "utf8");
    const opener = text.indexOf("<<'PY_POSTCONNECT_GDI'");
    expect(opener).toBeGreaterThan(0);
    const edit = text.slice(text.indexOf("\n", opener) + 1, text.indexOf("\nPY_POSTCONNECT_GDI\n"));
    // the shape of guacamole-server 1.6.0's src/protocols/rdp/rdp.c around the callbacks
    const pristine = [
      "static BOOL rdp_freerdp_pre_connect(freerdp* instance) {", "",
      "    rdpContext* context = GUAC_RDP_CONTEXT(instance);",
      "    rdpGraphics* graphics = context->graphics;", "",
      "    guac_client* client = ((rdp_freerdp_context*) context)->client;", "",
      "    if (settings->remote_app != NULL)", "        guac_rdp_rail_load_plugin(context);", "",
      "    /* Init FreeRDP internal GDI implementation */",
      "    if (!gdi_init(instance, guac_rdp_get_native_pixel_format(FALSE)))", "        return FALSE;", "",
      "    graphics_register_pointer(graphics, &pointer);",
      "    GUAC_RDP_CONTEXT(instance)->update->EndPaint = guac_rdp_gdi_end_paint;", "",
      "    GUAC_RDP_CONTEXT(instance)->update->altsec->FrameMarker = guac_rdp_gdi_frame_marker;", "",
      "    #ifndef RDP_INST_HAS_LOAD_CHANNELS", "        rdp_freerdp_load_channels(instance);", "    #endif", "",
      "    return TRUE;", "}", "",
      "static int guac_rdp_handle_connection(guac_client* client) {",
      "    rdp_inst->PreConnect = rdp_freerdp_pre_connect;",
      "    rdp_inst->Authenticate = rdp_freerdp_authenticate;", "}", "",
    ].join("\n");
    const dir = join(scratch, "rdp-2328");
    mkdirSync(join(dir, "src", "protocols", "rdp"), { recursive: true });
    writeFileSync(join(dir, "edit.py"), edit);
    const rdp = join(dir, "src", "protocols", "rdp", "rdp.c");
    const apply = () => {
      const run = Bun.spawnSync(["python3", join(dir, "edit.py")], { cwd: dir });
      return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
    };
    writeFileSync(rdp, pristine);
    expect(apply()).toEqual({ code: 0, out: "GUACAMOLE-2328 PostConnect GDI change applied.\n" });
    const fixed = readFileSync(rdp, "utf8");
    const pre = fixed.slice(fixed.indexOf("rdp_freerdp_pre_connect(freerdp"), fixed.indexOf("rdp_freerdp_post_connect(freerdp"));
    const post = fixed.slice(fixed.indexOf("static BOOL rdp_freerdp_post_connect"), fixed.indexOf("static int guac_rdp_handle_connection"));
    expect(pre).not.toContain("gdi_init(instance");
    expect(pre).not.toContain("rdpGraphics* graphics");
    expect(pre).toContain("guac_rdp_rail_load_plugin(context);");
    expect(pre).toContain("rdp_freerdp_load_channels(instance);");
    expect(fixed).toContain("Local backport of GUACAMOLE-2328");
    for (const line of ["rdpGraphics* graphics = context->graphics;", "gdi_init(instance", "graphics_register_pointer", "guac_rdp_gdi_end_paint", "guac_rdp_gdi_frame_marker"]) expect(post).toContain(line);
    // handlers stay after gdi_init(), which installs FreeRDP's own EndPaint
    expect(post.indexOf("gdi_init(instance")).toBeLessThan(post.indexOf("guac_rdp_gdi_end_paint"));
    expect(fixed.match(/rdp_inst->PostConnect = rdp_freerdp_post_connect;/g)).toHaveLength(1);
    expect(fixed.indexOf("rdp_inst->PreConnect")).toBeLessThan(fixed.indexOf("rdp_inst->PostConnect"));
    // a repeat run keeps the file as is
    expect(apply()).toEqual({ code: 0, out: "Existing GUACAMOLE-2328 PostConnect GDI change retained.\n" });
    expect(readFileSync(rdp, "utf8")).toBe(fixed);
    // the marker alone (GDI still in PreConnect) is refused, untouched
    const partial = pristine.replace("static BOOL rdp_freerdp_pre_connect", "/* Local backport of GUACAMOLE-2328 */\nstatic BOOL rdp_freerdp_pre_connect");
    writeFileSync(rdp, partial);
    expect(apply()).toMatchObject({ code: 1, out: expect.stringContaining("Partial or diverged GUACAMOLE-2328") });
    expect(readFileSync(rdp, "utf8")).toBe(partial);
    // diverged source (no PreConnect GDI block to move) is refused, untouched
    const diverged = pristine.replace("    /* Init FreeRDP internal GDI implementation */\n", "");
    writeFileSync(rdp, diverged);
    expect(apply()).toMatchObject({ code: 1, out: expect.stringContaining("refusing the GUACAMOLE-2328 edit") });
    expect(readFileSync(rdp, "utf8")).toBe(diverged);
  });
});
