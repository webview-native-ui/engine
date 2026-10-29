import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runtimeFiles } from './release-tag.mjs';

const prepare = fileURLToPath(new URL('../prepare-release-tag.mjs', import.meta.url));
const verify = new URL('./release-tag.mjs', import.meta.url).href;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'engine-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'source');
  mkdirSync(cwd);
  const env = {
    ...process.env,
    npm_config_git_tag_version: 'false',
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
  git('init', '-b', 'main');
  git('init', '--bare', join(root, 'remote.git'));
  git('remote', 'add', 'origin', join(root, 'remote.git'));
  write('.gitignore', runtimeFiles.join('\n') + '\n');
  write('source.ts', 'reviewed source');
  for (const file of ['package.json', 'package-lock.json']) write(file, '{"version":"0.0.1"}');
  git('add', '.');
  git('commit', '-m', 'Source');
  git('push', '-u', 'origin', 'main');
  for (const file of ['package.json', 'package-lock.json']) write(file, '{"version":"0.0.2"}');
  for (const file of runtimeFiles) write(file, 'generated runtime');
  return {
    cwd,
    git,
    write,
    run,
    prepare: () => run(process.execPath, [prepare]),
    verify: () =>
      run(process.execPath, [
        '--input-type=module',
        '-e',
        `import { verifyReleaseTag } from ${JSON.stringify(verify)}; verifyReleaseTag('v0.0.2');`,
      ]),
  };
}

test('release keeps main source-only, publishes the child tag, and rejects unrelated release changes', (t) => {
  const f = fixture(t);
  f.prepare();
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('ls-files', '--', ...runtimeFiles), '');
  assert.equal(f.git('rev-parse', 'v0.0.2^'), f.git('rev-parse', 'main'));
  assert.equal(f.git('rev-parse', 'main'), f.git('rev-parse', 'origin/main'));
  assert.match(f.git('ls-remote', 'origin', 'refs/tags/v0.0.2'), /refs\/tags\/v0.0.2/);
  for (const file of runtimeFiles) assert.equal(f.git('show', `v0.0.2:${file}`), readFileSync(join(f.cwd, file), 'utf8'));
  f.git('checkout', '--detach', 'v0.0.2');
  f.verify();
  f.write('source.ts', 'unreviewed source');
  f.git('add', 'source.ts');
  f.git('commit', '--amend', '--no-edit');
  // Only this disposable local tag is replaced to exercise the publication guard.
  f.git('tag', '-d', 'v0.0.2');
  f.git('tag', '-a', 'v0.0.2', '-m', 'Invalid fixture');
  assert.throws(() => f.verify(), /Release must not change reviewed source/);
});

test('failed atomic push publishes neither ref and retains the local release for inspection', (t) => {
  const f = fixture(t);
  f.git('tag', 'v0.0.2');
  f.git('push', 'origin', 'refs/tags/v0.0.2');
  f.git('tag', '-d', 'v0.0.2');
  const before = f.git('ls-remote', 'origin', 'refs/heads/main', 'refs/tags/v0.0.2');
  assert.throws(() => f.prepare());
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main', 'refs/tags/v0.0.2'), before);
  assert.equal(f.git('rev-parse', 'v0.0.2^'), f.git('rev-parse', 'main'));
  assert.equal(f.git('status', '--porcelain'), '');
});
