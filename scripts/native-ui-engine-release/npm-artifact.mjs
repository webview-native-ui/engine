import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function existingArtifactMatches({ name, version, local, fetcher = fetch }) {
  const metadata = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (metadata.status === 404) return false;
  if (!metadata.ok) throw new Error(`npm metadata request failed: ${metadata.status}`);
  const { dist } = await metadata.json();
  const response = await fetcher(dist.tarball, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`npm tarball request failed: ${response.status}`);
  const published = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(published).digest('base64')}`;
  if (integrity !== dist.integrity) throw new Error('Published npm tarball integrity mismatch');
  // Compression can differ across Node/npm versions; every tar byte must match.
  if (!gunzipSync(local).equals(gunzipSync(published))) {
    throw new Error('This npm version already exists with different package contents');
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json'], { encoding: 'utf8' }));
  const exists = await existingArtifactMatches({ name, version, local: readFileSync(packed.filename) });
  console.log(exists ? 'Identical npm package already published; skipping upload' : 'npm version is available');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `exists=${exists}\n`);
}
