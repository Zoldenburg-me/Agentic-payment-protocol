#!/usr/bin/env node
// Packs agentpay-hub and @zold/accept as tarballs for private sharing (no registry).
// In the repo @zold/accept depends on agentpay-hub via file:../.., which breaks once packed,
// so the packed copy pins the hub's version instead. Consumers install both tarballs and add
// "overrides": { "agentpay-hub": "file:<hub tarball>" } so npm never looks for it on a registry.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, process.argv[2] ?? 'dist-pack');
const acceptJson = resolve(root, 'packages/accept/package.json');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

const hubVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
mkdirSync(out, { recursive: true });
run('npm', ['run', 'build']);
const hub = run('npm', ['pack', '--ignore-scripts', '--pack-destination', out]).split('\n').pop();

const original = readFileSync(acceptJson, 'utf8');
const pkg = JSON.parse(original);
if (pkg.dependencies['agentpay-hub'] !== 'file:../..') throw new Error('expected @zold/accept to depend on agentpay-hub via file:../..');
try {
  writeFileSync(acceptJson, JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, 'agentpay-hub': hubVersion } }, null, 2) + '\n');
  const accept = run('npm', ['pack', '--ignore-scripts', '--pack-destination', out], resolve(root, 'packages/accept')).split('\n').pop();
  console.log(`${out}/${hub}\n${out}/${accept}`);
} finally {
  writeFileSync(acceptJson, original); // never leave the pinned copy in the repo
}
