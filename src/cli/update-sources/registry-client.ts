/**
 * registry-client.ts — Direct npm registry HTTP fetch (#1176).
 * No npm/pnpm CLI dependency. Pure fetch() + tar.
 */
import { writeFileSync } from "node:fs";

const REGISTRY = "https://registry.npmjs.org";
const METADATA_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 120_000;

export interface ResolvedVersion {
  version: string;
  tarballUrl: string;
}

/** Resolve a dist-tag (alpha, latest) to a concrete version + tarball URL. */
export async function resolveVersion(packageName: string, tag: string): Promise<ResolvedVersion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  try {
    const res = await fetch(`${REGISTRY}/${packageName}`, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Registry returned ${res.status} for ${packageName}`);
    const data = await res.json() as { "dist-tags"?: Record<string, string>; versions?: Record<string, { dist?: { tarball?: string } }> };
    const version = data["dist-tags"]?.[tag];
    if (!version) throw new Error(`No dist-tag '${tag}' for ${packageName}`);
    const tarballUrl = data.versions?.[version]?.dist?.tarball;
    if (!tarballUrl) throw new Error(`No tarball URL for ${packageName}@${version}`);
    return { version, tarballUrl };
  } finally {
    clearTimeout(timer);
  }
}

/** Download a tarball to a local file path. */
export async function downloadTarball(url: string, destPath: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TARBALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Tarball download failed: ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(destPath, buf);
  } finally {
    clearTimeout(timer);
  }
}
