### Fixed
- A bridge update that finds a bundle manifest of another version (a local `remote-bundles/`
  manifest built before an app update raised the runtime version) now names that manifest, both
  versions and the `bun run build:remote <platform>` command, or the `HERDR_WEB_BUNDLE_MANIFEST`
  override to fix, instead of only "Remote bundle version mismatch". It still refuses to install
  the mismatched bundle.
