import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import { bundleFile, bundleManifestSource } from "./remote-bundle.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(platform: string) {
  const directory = mkdtempSync(join(tmpdir(), "herdr-bundle-source-")); roots.push(directory);
  const bytes = Buffer.from(`private runtime for ${platform}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(directory, "bundle.tgz"), bytes);
  const manifest = join(directory, `manifest-${platform}.json`);
  writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { [platform]: { url: "bundle.tgz", sha256 } } }));
  return { directory, manifest, bytes, sha256 };
}

describe("remote bundle sources", () => {
  it("installs each Mac architecture from local manifests without a published release", async () => {
    for (const platform of ["darwin-arm64", "darwin-x64"]) {
      const { directory, manifest, bytes, sha256 } = fixture(platform);
      const options = { directory, manifest: "" }; // Explicitly test automatic discovery, independent of the test runner's environment.
      expect(await bundleManifestSource(platform, options)).toBe(manifest);
      const asset = await bundleFile(platform, new AbortController().signal, options);
      expect(readFileSync(asset.path)).toEqual(bytes);
      expect(asset.size).toBe(bytes.length);
      expect(asset.sha256).toBe(sha256);
    }
  });

  it("keeps explicit manifest configuration ahead of automatic discovery", async () => {
    const local = fixture("darwin-arm64");
    const override = fixture("darwin-arm64");
    expect(await bundleManifestSource("darwin-arm64", { directory: local.directory, manifest: override.manifest })).toBe(override.manifest);
    await expect(bundleFile("darwin-arm64", new AbortController().signal, { directory: local.directory, manifest: join(local.directory, "missing.json") })).rejects.toThrow("ENOENT");
  });

  it("uses the release only when the requested platform has no local manifest", async () => {
    const { directory } = fixture("linux-x64");
    expect(await bundleManifestSource("darwin-arm64", { directory, manifest: "" })).toBe(`https://github.com/devswha/herdr-web-ui/releases/download/remote-v${REMOTE_BUNDLE_VERSION}/manifest.json`);
    await expect(bundleManifestSource("../linux-x64", { directory })).rejects.toThrow("Unsupported bundle platform");
  });

  it("rejects corrupted local bytes instead of silently falling back to another source", async () => {
    const { directory } = fixture("darwin-arm64");
    writeFileSync(join(directory, "bundle.tgz"), "changed after manifest creation");
    await expect(bundleFile("darwin-arm64", new AbortController().signal, { directory, manifest: "" })).rejects.toThrow("checksum mismatch");
  });

  it("rejects incompatible manifests, path traversal and cancelled setup", async () => {
    const { directory, manifest, sha256 } = fixture("darwin-arm64");
    const options = { directory, manifest: "" };
    writeFileSync(manifest, JSON.stringify({ version: "incompatible", assets: {} }));
    await expect(bundleFile("darwin-arm64", new AbortController().signal, options)).rejects.toThrow("version mismatch");
    writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "darwin-arm64": { url: "../bundle.tgz", sha256 } } }));
    await expect(bundleFile("darwin-arm64", new AbortController().signal, options)).rejects.toThrow("Bundle URL must use HTTPS");
    const controller = new AbortController(); controller.abort(new Error("test cancelled"));
    await expect(bundleFile("darwin-arm64", controller.signal, options)).rejects.toThrow("test cancelled");
  });

  it("fails closed on a local manifest left behind by an app update and says how to rebuild it", async () => {
    const { directory, manifest, sha256 } = fixture("linux-x64");
    const stale = String(Number(REMOTE_BUNDLE_VERSION) - 2);
    // no archive beside it: the version is refused before any asset is looked at
    rmSync(join(directory, "bundle.tgz"));
    writeFileSync(manifest, JSON.stringify({ version: stale, features: ["pi-visual"], assets: { "linux-x64": { url: "bundle.tgz", sha256 } } }));
    const update = bundleFile("linux-x64", new AbortController().signal, { directory, manifest: "", feature: "pi-visual" });
    await expect(update).rejects.toThrow("Remote bundle version mismatch");
    await expect(update).rejects.toThrow(`(${manifest}) is version ${stale}, but this web server needs ${REMOTE_BUNDLE_VERSION}`);
    await expect(update).rejects.toThrow("run bun run build:remote linux-x64");
    // the rebuilt manifest passes the version check and still has to pass the feature and checksum checks
    writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "linux-x64": { url: "bundle.tgz", sha256 } } }));
    await expect(bundleFile("linux-x64", new AbortController().signal, { directory, manifest: "", feature: "pi-visual" })).rejects.toThrow("does not include pi-visual");
    writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, features: ["pi-visual"], assets: { "linux-x64": { url: "bundle.tgz", sha256 } } }));
    writeFileSync(join(directory, "bundle.tgz"), "not the archive the manifest names");
    await expect(bundleFile("linux-x64", new AbortController().signal, { directory, manifest: "", feature: "pi-visual" })).rejects.toThrow("checksum mismatch");
    writeFileSync(join(directory, "bundle.tgz"), `private runtime for linux-x64`);
    expect((await bundleFile("linux-x64", new AbortController().signal, { directory, manifest: "", feature: "pi-visual" })).sha256).toBe(sha256);
  });

  it("points a version mismatch at an explicit manifest override, and never repeats a configured URL", async () => {
    const local = fixture("linux-x64");
    const override = fixture("linux-x64");
    writeFileSync(override.manifest, JSON.stringify({ version: "0", assets: {} }));
    // a rebuilt remote-bundles/ manifest does not help while the override still selects the stale one
    const configured = bundleFile("linux-x64", new AbortController().signal, { directory: local.directory, manifest: override.manifest });
    await expect(configured).rejects.toThrow(`the manifest HERDR_WEB_BUNDLE_MANIFEST names (${override.manifest}) is version 0`);
    await expect(configured).rejects.toThrow("or unset HERDR_WEB_BUNDLE_MANIFEST");
    const original = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return Response.json({ version: "0", assets: { "linux-x64": { url: "https://bundles.invalid/bundle.tgz", sha256: local.sha256 } } });
    }) as typeof fetch;
    try {
      const secret = "https://user:token@bundles.invalid/manifest.json";
      const remote = bundleFile("linux-x64", new AbortController().signal, { directory: local.directory, manifest: secret, cacheDir: join(local.directory, "cache") });
      await expect(remote).rejects.toThrow("the manifest HERDR_WEB_BUNDLE_MANIFEST names is version 0");
      const message = await remote.catch((error: Error) => error.message);
      expect(message).not.toContain("token");
      // the published release, chosen when no manifest is local or configured
      const release = bundleFile("darwin-arm64", new AbortController().signal, { directory: local.directory, manifest: "", cacheDir: join(local.directory, "cache") });
      await expect(release).rejects.toThrow(`the published remote-v${REMOTE_BUNDLE_VERSION} release manifest is version 0`);
      // only the manifests were read: no asset download began
      expect(fetched.every((url) => url.endsWith("manifest.json"))).toBe(true);
    } finally { globalThis.fetch = original; }
  });

  it("installs a bundle for the Pi visual bridge only when its manifest carries the feature", async () => {
    const { directory, manifest, sha256 } = fixture("linux-x64");
    const options = { directory, manifest: "", feature: "pi-visual" };
    // upstream's manifests name no features: nothing is uploaded for a feature they lack
    await expect(bundleFile("linux-x64", new AbortController().signal, options)).rejects.toThrow("does not include pi-visual");
    writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, features: ["pi-visual"], assets: { "linux-x64": { url: "bundle.tgz", sha256 } } }));
    expect((await bundleFile("linux-x64", new AbortController().signal, options)).sha256).toBe(sha256);
  });

  it("reuses a cached release bundle by checksum and never trusts a changed one", async () => {
    const { directory, manifest, bytes, sha256 } = fixture("linux-x64");
    // an unreachable release URL: only the cache can answer
    writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "linux-x64": { url: "https://bundles.invalid/bundle.tgz", sha256 } } }));
    const cacheDir = join(directory, "cache"); mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, `${sha256}.tgz`), bytes);
    const options = { directory, manifest: "", cacheDir };
    const cached = await bundleFile("linux-x64", new AbortController().signal, options);
    expect(cached.path).toBe(join(cacheDir, `${sha256}.tgz`));
    writeFileSync(join(cacheDir, `${sha256}.tgz`), "tampered");
    await expect(bundleFile("linux-x64", new AbortController().signal, options)).rejects.toThrow();
    await expect(bundleFile("linux-x64", new AbortController().signal, { directory, manifest: "" })).rejects.toThrow("No bundle cache directory");
  });
});
