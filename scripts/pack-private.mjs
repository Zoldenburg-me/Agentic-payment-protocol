#!/usr/bin/env node
// Packs agentpay-hub and @zold/accept as tarballs for private sharing (no registry).
// In the repo @zold/accept depends on agentpay-hub via file:../.., which breaks once packed,
// so the packed copy pins the hub's version instead. Consumers install both tarballs and add
// "overrides": { "agentpay-hub": "file:<hub tarball>" } so npm never looks for it on a registry.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, process.argv[2] ?? 'dist-pack');
const acceptDir = resolve(root, 'packages/accept');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

const hubVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
mkdirSync(out, { recursive: true });
run('npm', ['run', 'build']);
const hub = run('npm', ['pack', '--ignore-scripts', '--pack-destination', out]).split('\n').pop();

const pkg = JSON.parse(readFileSync(join(acceptDir, 'package.json'), 'utf8'));
if (pkg.dependencies['agentpay-hub'] !== 'file:../..') throw new Error('expected @zold/accept to depend on agentpay-hub via file:../..');
// Pack a staged copy, never the repo's manifest, so concurrent runs cannot ship file:../..
const stage = mkdtempSync(join(tmpdir(), 'zold-accept-pack-'));
try {
  for (const entry of pkg.files) cpSync(join(acceptDir, entry), join(stage, entry), { recursive: true });
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, 'agentpay-hub': hubVersion } }, null, 2) + '\n');
  const accept = run('npm', ['pack', '--ignore-scripts', '--pack-destination', out], stage).split('\n').pop();
  console.log(`${out}/${hub}\n${out}/${accept}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
