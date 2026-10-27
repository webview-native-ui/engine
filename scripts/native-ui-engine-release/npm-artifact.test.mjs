import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existingArtifactMatches } from './npm-artifact.mjs';

const published = gzipSync('package contents', { level: 9 });
const integrity = `sha512-${createHash('sha512').update(published).digest('base64')}`;
const metadata = () => Response.json({ dist: { tarball: 'https://registry.npmjs.org/test.tgz', integrity } });
const options = (responses, local = gzipSync('package contents', { level: 1 })) => ({
  name: '@example/engine',
  version: '0.0.1',
  local,
  fetcher: async () => responses.shift(),
});

test('accepts byte-identical tar contents despite gzip differences', async () => {
  assert.equal(await existingArtifactMatches(options([metadata(), new Response(published)])), true);
});
test('only a missing version permits publication', async () => {
  assert.equal(await existingArtifactMatches(options([new Response('', { status: 404 })])), false);
  await assert.rejects(existingArtifactMatches(options([new Response('', { status: 503 })])), /metadata request failed/);
  await assert.rejects(existingArtifactMatches(options([metadata(), new Response('', { status: 500 })])), /tarball request failed/);
});
test('rejects different contents or corrupted downloads', async () => {
  await assert.rejects(
    existingArtifactMatches(options([metadata(), new Response(published)], gzipSync('different'))),
    /different package contents/,
  );
  await assert.rejects(existingArtifactMatches(options([metadata(), new Response(gzipSync('corrupted'))])), /integrity mismatch/);
});
