import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeFiles } from './native-ui-engine-release/release-tag.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(process.env.npm_config_git_tag_version, 'false', 'Use npm run release');
assert.equal(git('branch', '--show-current'), 'main', 'Release from main');
assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'origin/main'), 'Update main before releasing');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;
assert.equal(git('tag', '--list', tag), '', 'Never replace an existing release tag');
assert.deepEqual(
  git('diff', '--name-only', 'HEAD').split('\n').sort(),
  ['package-lock.json', 'package.json'],
  'Only version metadata may change during release',
);
assert.equal(git('ls-files', '--', ...runtimeFiles), '', 'Generated runtime must not be tracked on main');
git('add', 'package.json', 'package-lock.json');
git('commit', '-m', version);

// A temporary index adds generated resources without changing main or its index.
const temporary = mkdtempSync(join(tmpdir(), 'engine-release-index-'));
try {
  const releaseGit = (...args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      env: { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') },
    }).trim();
  releaseGit('read-tree', 'HEAD');
  releaseGit('add', '-f', ...runtimeFiles);
  const commit = git('commit-tree', releaseGit('write-tree'), '-p', 'HEAD', '-m', `Build native runtime for ${tag}`);
  git('tag', '-a', tag, commit, '-m', tag);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
// np's --follow-tags cannot push a tag on a child that is not reachable from main.
git('push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`);
