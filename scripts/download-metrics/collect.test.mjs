import assert from "node:assert/strict";
import test from "node:test";
import { classifyReleaseAssets, collect, releaseRepository } from "./collect.mjs";

const asset = (id, name, downloadCount) => ({ id, name, download_count: downloadCount });

test("keeps pre-split DMG counters historically unclassified", () => {
  const result = classifyReleaseAssets([
    {
      tag_name: "v1.0.4",
      draft: false,
      prerelease: false,
      assets: [
        asset(1, "SIDEY-macOS-arm64-v1.0.4.dmg", 100),
        asset(2, "SIDEY-macOS-arm64-v1.0.4.zip", 50),
        asset(3, "SIDEY-macOS-arm64-v1.0.4.dmg.sha256", 12),
      ],
    },
  ]);

  assert.deepEqual(result, [
    {
      asset_id: 1,
      asset_name: "SIDEY-macOS-arm64-v1.0.4.dmg",
      release_tag: "v1.0.4",
      version: "1.0.4",
      channel: "legacy_unclassified",
      download_count: 100,
    },
  ]);
});

test("separates direct, Homebrew, and Windows installer assets after the split", () => {
  const result = classifyReleaseAssets([
    {
      tag_name: "v1.0.5",
      draft: false,
      prerelease: false,
      assets: [
        asset(10, "SIDEY-macOS-arm64-v1.0.5.dmg", 7),
        asset(11, "SIDEY-macOS-arm64-v1.0.5-homebrew.dmg", 9),
      ],
    },
    {
      tag_name: "windows-v1.0.3",
      draft: false,
      prerelease: false,
      assets: [asset(12, "SIDEY-Windows-x64-v1.0.3.msi", 11)],
    },
    {
      tag_name: "windows-v1.0.6",
      draft: false,
      prerelease: false,
      assets: [asset(13, "SIDEY-Windows-x64-v1.0.6-Setup.exe", 17)],
    },
  ]);

  assert.deepEqual(
    result.map(({ channel, download_count }) => [channel, download_count]),
    [
      ["direct_dmg", 7],
      ["homebrew_dmg", 9],
      ["windows_msi", 11],
      ["windows_msi", 17],
    ],
  );
});

test("ignores drafts and prereleases", () => {
  const result = classifyReleaseAssets([
    {
      tag_name: "v2.0.0-beta",
      draft: false,
      prerelease: true,
      assets: [asset(20, "SIDEY-macOS-arm64-v2.0.0.dmg", 999)],
    },
    {
      tag_name: "v2.0.0",
      draft: true,
      prerelease: false,
      assets: [asset(21, "SIDEY-macOS-arm64-v2.0.0.dmg", 999)],
    },
  ]);

  assert.deepEqual(result, []);
});


test("private backend workflow always queries the explicit public release repository", async () => {
  assert.equal(releaseRepository({ GITHUB_REPOSITORY: "sidey-app/sidey-backend" }), "sidey-app/SIDEY");
  assert.equal(releaseRepository({ DOWNLOAD_METRICS_RELEASE_REPOSITORY: "sidey-app/SIDEY" }), "sidey-app/SIDEY");
  for (const repository of ["sidey-app/sidey-backend", "another/repo", "", "sidey-app/SIDEY/releases"]) {
    assert.throws(() => releaseRepository({ DOWNLOAD_METRICS_RELEASE_REPOSITORY: repository }), /must be sidey-app\/SIDEY/);
  }
  const calls = [];
  const output = [];
  await collect({
    environment: { GITHUB_REPOSITORY: "sidey-app/sidey-backend", GITHUB_TOKEN: "test-token",
      DOWNLOAD_METRICS_INGEST_URL: "https://metrics.invalid/ingest", DOWNLOAD_METRICS_INGEST_KEY: "test-key" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return { ok: true, json: async () => [{ tag_name: "windows-v1.0.6", draft: false,
        prerelease: false, assets: [asset(13, "SIDEY-Windows-x64-v1.0.6-Setup.exe", 17)] }] };
      return { ok: true, json: async () => ({ insertedCount: 1 }) };
    },
    write: (message) => output.push(message),
  });
  assert.equal(calls[0].url, "https://api.github.com/repos/sidey-app/SIDEY/releases?per_page=100");
  assert.equal(calls[1].url, "https://metrics.invalid/ingest");
  assert.equal(JSON.parse(calls[1].options.body).snapshots[0].download_count, 17);
  assert.equal(output.length, 1);
});

test("misconfigured release repository fails before any collection request", async () => {
  let requested = false;
  await assert.rejects(collect({ environment: { DOWNLOAD_METRICS_RELEASE_REPOSITORY: "sidey-app/sidey-backend" },
    fetchImpl: async () => { requested = true; } }), /must be sidey-app\/SIDEY/);
  assert.equal(requested, false);
});
