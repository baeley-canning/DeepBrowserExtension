import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const extensionDir = __dirname;
const repoRoot = path.resolve(extensionDir, "..", "..");

describe("desktop extension setup contract", () => {
  it("keeps manifest-referenced extension entrypoints present", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
    const referencedFiles = new Set<string>();

    referencedFiles.add(manifest.background.service_worker);
    referencedFiles.add(manifest.options_ui.page);

    // The UI entrypoint moved from a popup to a docked side panel in 1.7.0 —
    // a popup closes the moment focus leaves it, which is useless for a hunt
    // that runs for minutes. Accept either, but require AT LEAST ONE: a
    // manifest with neither has no way in at all.
    const uiEntrypoints = [manifest.action?.default_popup, manifest.side_panel?.default_path].filter(
      Boolean,
    ) as string[];
    expect(uiEntrypoints.length, "manifest must declare a popup or a side panel").toBeGreaterThan(0);
    for (const f of uiEntrypoints) referencedFiles.add(f);

    for (const script of manifest.content_scripts ?? []) {
      for (const file of script.js ?? []) referencedFiles.add(file);
    }

    // Dynamic import() targets must be web-accessible or they fail at runtime
    // with nothing in the page console — the loader modules are pulled in that
    // way, so a missing entry here is a silently dead content script.
    for (const war of manifest.web_accessible_resources ?? []) {
      for (const file of war.resources ?? []) referencedFiles.add(file);
    }

    for (const file of referencedFiles) {
      expect(fs.existsSync(path.join(extensionDir, file)), `${file} should exist`).toBe(true);
    }
  });

  it("copies the extension options page when the desktop app prepares an unpacked folder", () => {
    const electronMain = fs.readFileSync(path.join(repoRoot, "electron", "main.js"), "utf8");

    expect(electronMain).toContain("\"options.html\"");
    expect(electronMain).toContain("\"options.js\"");
  });

  it("allows desktop RecruitMe to run on a non-3000 localhost port", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));

    expect(manifest.host_permissions).toContain("http://localhost/*");
    expect(manifest.host_permissions).toContain("http://127.0.0.1/*");
    expect(manifest.host_permissions).not.toContain("http://localhost:3000/*");
  });
});
