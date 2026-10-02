import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const script = fileURLToPath(new URL('../scripts/ignore-build.mjs', import.meta.url));
function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function repository(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mypixel-ignore-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, 'init', '--initial-branch=main');
  git(directory, 'config', 'user.name', 'Build Test');
  git(directory, 'config', 'user.email', 'build-test@example.invalid');
  git(directory, 'config', 'commit.gpgsign', 'false');
  const commit = async files => {
    for (const [name, value] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await writeFile(path.join(directory, name), value);
    }
    git(directory, 'add', '--all'); git(directory, 'commit', '-m', 'Synthetic build test');
    return git(directory, 'rev-parse', 'HEAD');
  };
  const first = await commit({ 'index.html': '<h1>first</h1>', 'user.txt': 'data 1' });
  return { directory, commit, first };
}
function decide(directory, previousSha) {
  const env = { ...process.env };
  delete env.VERCEL_GIT_PREVIOUS_SHA;
  if (previousSha !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = previousSha;
  const result = spawnSync(process.execPath, [script], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  return result;
}

test('builds cumulative code changes even when the most recent commit only changes user.txt', async t => {
  const repo = await repository(t);
  await repo.commit({ 'index.html': '<h1>undeployed code</h1>' });
  await repo.commit({ 'user.txt': 'data 2' });
  const result = decide(repo.directory, repo.first);
  assert.equal(result.status, 1); assert.match(result.stdout, /code changed/);
});

test('skips only confirmed data-only changes since the previous successful deployment', async t => {
  const repo = await repository(t);
  await repo.commit({ 'user.txt': 'data 2' });
  await repo.commit({ 'user.txt': 'data 3' });
  const result = decide(repo.directory, repo.first);
  assert.equal(result.status, 0); assert.match(result.stdout, /Data-only deployment skipped/);
  assert.match(result.stdout, /environment-variable changes/);
  assert.match(result.stdout, /Use project's Ignore Build Step.*unchecked/);
});

test('first deployment, missing or invalid previous SHA, absent history and same-commit redeploy all build', async t => {
  const repo = await repository(t);
  for (const previousSha of [undefined, '', 'HEAD^', '--help', 'a'.repeat(39), '0'.repeat(40), repo.first]) {
    const result = decide(repo.directory, previousSha);
    assert.equal(result.status, 1, `Expected build for ${previousSha ?? 'missing SHA'}`);
    assert.doesNotMatch(result.stdout, /Data-only deployment skipped/);
  }
  const empty = path.join(repo.directory, 'empty'); await mkdir(empty);
  git(empty, 'init', '--initial-branch=main');
  assert.equal(decide(empty, repo.first).status, 1);
});

test('shallow clones without the prior deployment commit build instead of skipping', async t => {
  const repo = await repository(t); await repo.commit({ 'user.txt': 'data 2' });
  const shallow = path.join(repo.directory, 'shallow-checkout');
  git(repo.directory, 'clone', '--depth=1', '--no-local', pathToFileURL(repo.directory).href, shallow);
  assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'true');
  const result = decide(shallow, repo.first);
  assert.equal(result.status, 1); assert.match(result.stdout, /history could not be verified/);
});

test('divergent history and renaming a code file into user.txt both build', async t => {
  const repo = await repository(t);
  const previous = await repo.commit({ 'index.html': '<h1>deployed branch</h1>' });
  git(repo.directory, 'checkout', '-b', 'other', repo.first);
  await repo.commit({ 'user.txt': 'different branch data' });
  assert.equal(decide(repo.directory, previous).status, 1);
  const base = git(repo.directory, 'rev-parse', 'HEAD');
  git(repo.directory, 'rm', 'user.txt');
  git(repo.directory, 'mv', 'index.html', 'user.txt');
  git(repo.directory, 'commit', '-m', 'Rename code into account file');
  assert.equal(decide(repo.directory, base).status, 1);
});
