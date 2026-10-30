/*!
 * @webview-native-ui/engine
 * Copyright (c) 2026 Masahiko Sakakibara (rdlabo)
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const runtimeFiles = ['ios/Sources/WebViewNativeUIEngine/Resources/native-ui-engine.js', 'runtime/native-ui-engine.js'];

export function verifyReleaseTag(tag) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(tag, `v${version}`, 'Tag must match package version');
  const sha = git('rev-parse', 'HEAD');
  assert.equal(git('rev-parse', `refs/tags/${tag}^{commit}`), sha, 'Checkout must match the release tag');
  const parents = git('rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);
  assert.equal(parents.length, 1, 'Release must have one source parent');
  git('merge-base', '--is-ancestor', parents[0], 'origin/main');
  assert.deepEqual(
    git('diff', '--name-status', '--no-renames', parents[0], sha).split('\n').sort(),
    runtimeFiles.map((file) => `A\t${file}`),
    'Release must only add both generated resources',
  );
  return { sha, version };
}
