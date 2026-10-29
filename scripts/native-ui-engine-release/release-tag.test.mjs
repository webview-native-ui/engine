import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runtimeFiles } from './release-tag.mjs';

const verify = new URL('./release-tag.mjs', import.meta.url).href;

test('publication accepts only generated resources added to a main commit', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-release-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const run = (command, args) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = (...args) => run('git', args);
  const write = (file, value) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), value);
  };
  const check = () =>
    run(process.execPath, [
      '--input-type=module',
      '-e',
      `import { verifyReleaseTag } from ${JSON.stringify(verify)}; verifyReleaseTag('v0.0.2');`,
    ]);
  git('init', '-b', 'main');
  write('package.json', '{"version":"0.0.2"}');
  write('source.ts', 'reviewed source');
  git('add', '.');
  git('commit', '-m', 'Source');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '--detach');
  for (const file of runtimeFiles) write(file, 'generated runtime');
  git('add', '.');
  git('commit', '-m', 'Release resources');
  git('tag', 'v0.0.2');
  check();
  assert.equal(git('ls-tree', '-r', '--name-only', 'main', '--', ...runtimeFiles), '');
  write('source.ts', 'unreviewed source');
  git('add', '.');
  git('commit', '--amend', '--no-edit');
  git('tag', '-d', 'v0.0.2');
  git('tag', 'v0.0.2');
  assert.throws(check, /Release must not change reviewed source/);
  git('checkout', 'HEAD^', '--', 'source.ts');
  git('rm', runtimeFiles[0]);
  git('commit', '--amend', '--no-edit');
  git('tag', '-d', 'v0.0.2');
  git('tag', 'v0.0.2');
  assert.throws(check, /Release must add both generated resources/);
});

test('npm increments reset lower components and graduate revisions without skipping the stable release', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-version-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [current, increment, expected] of [
    ['1.2.3', 'major', '2.0.0'],
    ['1.2.3', 'minor', '1.3.0'],
    ['1.2.3', 'patch', '1.2.4'],
    ['1.2.3', 'prerelease', '1.2.4-0'],
    ['1.2.4-0', 'prerelease', '1.2.4-1'],
    ['1.2.4-2', 'patch', '1.2.4'],
    ['1.3.0-2', 'minor', '1.3.0'],
    ['2.0.0-2', 'major', '2.0.0'],
  ]) {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: current }));
    const result = execFileSync('npm', ['version', increment, '--no-git-tag-version', '--ignore-scripts'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(cwd, 'cache') },
    }).trim();
    assert.equal(result, `v${expected}`, `${current} → ${increment}`);
  }
});
