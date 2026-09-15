const PUBLIC_RELEASE_REPOSITORY = "sidey-app/SIDEY";

export function releaseRepository(environment = process.env) {
  const repository = environment.DOWNLOAD_METRICS_RELEASE_REPOSITORY ?? PUBLIC_RELEASE_REPOSITORY;
  if (repository !== PUBLIC_RELEASE_REPOSITORY) {
    throw new Error("DOWNLOAD_METRICS_RELEASE_REPOSITORY must be sidey-app/SIDEY");
  }
  return repository;
}

const ASSET_PATTERNS = {
  direct_dmg: /^SIDEY-macOS-arm64-v([0-9]+\.[0-9]+\.[0-9]+)\.dmg$/,
  homebrew_dmg: /^SIDEY-macOS-arm64-v([0-9]+\.[0-9]+\.[0-9]+)-homebrew\.dmg$/,
  windows_installer:
    /^SIDEY-Windows-x64-v([0-9]+\.[0-9]+\.[0-9]+)(?:\.msi|-Setup\.exe)$/,
};

export function classifyReleaseAssets(releases) {
  const snapshots = [];

  for (const release of releases) {
    if (release.draft || release.prerelease || !Array.isArray(release.assets)) continue;

    const hasHomebrewAsset = release.assets.some((asset) =>
      ASSET_PATTERNS.homebrew_dmg.test(asset.name),
    );

    for (const asset of release.assets) {
      let channel;
      let version;

      const homebrewMatch = asset.name.match(ASSET_PATTERNS.homebrew_dmg);
      const directMatch = asset.name.match(ASSET_PATTERNS.direct_dmg);
      const windowsMatch = asset.name.match(ASSET_PATTERNS.windows_installer);

      if (homebrewMatch) {
        channel = "homebrew_dmg";
        version = homebrewMatch[1];
      } else if (directMatch) {
        channel = hasHomebrewAsset ? "direct_dmg" : "legacy_unclassified";
        version = directMatch[1];
      } else if (windowsMatch) {
        channel = "windows_msi";
        version = windowsMatch[1];
      } else {
        continue;
      }

      if (!Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.download_count)) {
        throw new Error(`GitHub returned an invalid asset counter for ${asset.name}`);
      }

      snapshots.push({
        asset_id: asset.id,
        asset_name: asset.name,
        release_tag: release.tag_name,
        version,
        channel,
        download_count: asset.download_count,
      });
    }
  }

  return snapshots;
}

export async function collect({ environment = process.env, fetchImpl = fetch,
  write = (message) => process.stdout.write(message) } = {}) {
  const repository = releaseRepository(environment);
  const githubToken = environment.GITHUB_TOKEN;
  const ingestUrl = environment.DOWNLOAD_METRICS_INGEST_URL;
  const ingestKey = environment.DOWNLOAD_METRICS_INGEST_KEY;

  if (!githubToken || !ingestUrl || !ingestKey) {
    throw new Error(
      "GITHUB_TOKEN, DOWNLOAD_METRICS_INGEST_URL, and DOWNLOAD_METRICS_INGEST_KEY are required",
    );
  }

  const releasesResponse = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!releasesResponse.ok) {
    throw new Error(`GitHub releases request failed: ${releasesResponse.status}`);
  }

  const snapshots = classifyReleaseAssets(await releasesResponse.json());
  if (snapshots.length === 0) {
    throw new Error("No stable SIDEY installation assets were found");
  }

  const ingestResponse = await fetchImpl(ingestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sidey-ingest-key": ingestKey,
    },
    body: JSON.stringify({
      collectedAt: new Date().toISOString(),
      snapshots,
    }),
  });
  if (!ingestResponse.ok) {
    throw new Error(
      `Download metrics ingest failed: ${ingestResponse.status} ${await ingestResponse.text()}`,
    );
  }

  const result = await ingestResponse.json();
  write(
    `Recorded ${result.insertedCount} of ${snapshots.length} SIDEY download counters\n`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  collect().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
