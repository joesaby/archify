import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const verifier = fileURLToPath(new URL('../scripts/verify-npm-package-source.mjs', import.meta.url));

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-npm-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init');
  git(root, 'config', 'user.name', 'Package test');
  git(root, 'config', 'user.email', 'package-test@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(root, 'archify'));
  fs.writeFileSync(path.join(root, 'archify/input.txt'), 'committed input\n');
  fs.writeFileSync(path.join(root, 'packaging-tool.txt'), 'tracked build input\n');
  git(root, 'add', '.');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  return { root, revision: git(root, 'rev-parse', 'HEAD') };
}

function verify(root, revision) {
  return spawnSync(process.execPath, [verifier, root, ...(revision ? [revision] : [])], { encoding: 'utf8' });
}

test('npm package source records a clean commit and allows excluded untracked artifacts', (t) => {
  const { root, revision } = fixture(t);
  fs.writeFileSync(path.join(root, 'archify/untracked.txt'), 'not a package input\n');
  fs.mkdirSync(path.join(root, 'verified-output'));
  fs.writeFileSync(path.join(root, 'verified-output/pack.json'), '{}\n');
  for (const expected of [undefined, revision]) {
    const result = verify(root, expected);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${revision}\n`);
  }
});

for (const change of ['unstaged', 'staged', 'index-only', 'added', 'deleted', 'packaging-tool']) {
  test(`npm package source rejects ${change} tracked changes`, (t) => {
    const { root, revision } = fixture(t);
    const input = path.join(root, 'archify/input.txt');
    if (change === 'deleted') {
      fs.unlinkSync(input);
    } else if (change === 'added') {
      fs.writeFileSync(path.join(root, 'archify/added.txt'), 'new staged input\n');
      git(root, 'add', '.');
    } else if (change === 'packaging-tool') {
      fs.appendFileSync(path.join(root, 'packaging-tool.txt'), 'uncommitted tool change\n');
    } else {
      fs.writeFileSync(input, 'uncommitted input\n');
      if (change !== 'unstaged') git(root, 'add', '.');
      if (change === 'index-only') fs.writeFileSync(input, 'committed input\n');
    }
    const result = verify(root, revision);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a clean tracked checkout/);
    assert.equal(result.stdout, '', 'dirty inputs must not receive a verified revision');
  });
}

test('npm package source rejects a different clean HEAD after capturing the original revision', (t) => {
  const { root, revision } = fixture(t);
  git(root, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'new head');
  const result = verify(root, revision);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source revision changed/);
  assert.equal(result.stdout, '');
});

test('npm package source fails closed when Git cannot resolve a commit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-npm-unborn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init');
  const result = verify(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unable to resolve package source revision/);
  assert.equal(result.stdout, '');
});
