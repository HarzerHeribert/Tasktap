#!/usr/bin/env node
// Writes the updater's feed for a release, latest.json (Tauri's static form): the version, its notes, the date, and
// for each platform the address of its package on the release and the package's signature. Every signature is first
// checked against the updater's public key, the one the app is built with, so that a feed whose packages the app
// would refuse is never written: a key pair that does not match fails here, not on a person's computer.
//
//   TASKTAP_UPDATE_KEY=<the .pub file's content> node scripts/release-feed.cjs --version 2.0.0 --dir <release files>
//       [--notes <file>] [--base <address the files are published under>] [--out <file>]
//
// The release files are found by name: <Name>_<version>_aarch64.app.tar.gz (the Mac, Apple silicon) and
// <Name>_<version>_x64-setup.exe (Windows, x64), each with its .sig beside it. Both are required.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const fail = (why) => {
  console.error(`release-feed: ${why}`);
  process.exit(1);
};
if (!args.version || !args.dir) fail('usage: release-feed.cjs --version <x.y.z> --dir <folder> [--notes <file>] [--base <url>] [--out <file>]');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(args.version)) fail(`${args.version} is not a version (x.y.z)`);
const base = args.base || `https://github.com/HarzerHeribert/Tasktap/releases/download/v${args.version}`;
const key = (process.env.TASKTAP_UPDATE_KEY || '').trim();
if (!key) fail('TASKTAP_UPDATE_KEY (the updater public key) is not set');

/** A minisign key or signature as Tauri writes it: base64 of minisign's own text; its lines. */
const lines = (b64, what) => {
  const text = Buffer.from(b64.trim(), 'base64').toString('utf8');
  const all = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (!all[0]?.startsWith('untrusted comment:')) fail(`${what} is not in minisign's form`);
  return all;
};
const [, pkLine] = lines(key, 'the public key');
const pk = Buffer.from(pkLine, 'base64');
if (pk.length !== 42 || pk.subarray(0, 2).toString() !== 'Ed') fail('the public key is not an Ed25519 minisign key');
const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk.subarray(10)]), format: 'der', type: 'spki' });

/** Checks `file` against its signature (the .sig file's content) as minisign does; throws why not. */
function check(file, signature) {
  const [, sigLine, trusted, globalLine] = lines(signature, `${path.basename(file)}.sig`);
  const sig = Buffer.from(sigLine, 'base64');
  if (sig.length !== 74) throw new Error('the signature has the wrong length');
  const alg = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) throw new Error('it was signed with another key than the updater public key');
  const bytes = fs.readFileSync(file);
  const message = alg === 'ED' ? crypto.createHash('blake2b512').update(bytes).digest() : alg === 'Ed' ? bytes : null;
  if (!message) throw new Error(`unknown signature kind ${alg}`);
  if (!crypto.verify(null, message, publicKey, sig.subarray(10))) throw new Error('the signature does not match the file');
  const comment = Buffer.from(trusted.replace(/^trusted comment: /, ''), 'utf8');
  if (!crypto.verify(null, Buffer.concat([sig.subarray(10), comment]), publicKey, Buffer.from(globalLine, 'base64'))) {
    throw new Error("the signature's trusted comment does not match");
  }
}

const kinds = [
  ['darwin-aarch64', new RegExp(`_${args.version.replace(/\./g, '\\.')}_aarch64\\.app\\.tar\\.gz$`)],
  ['windows-x86_64', new RegExp(`_${args.version.replace(/\./g, '\\.')}_x64-setup\\.exe$`)],
];
const names = fs.readdirSync(args.dir);
const platforms = {};
for (const [platform, pattern] of kinds) {
  const name = names.find((n) => pattern.test(n));
  if (!name) fail(`no package for ${platform} (${pattern}) in ${args.dir}: ${names.join(', ')}`);
  const sigFile = path.join(args.dir, `${name}.sig`);
  if (!fs.existsSync(sigFile)) fail(`${name} has no signature beside it`);
  const signature = fs.readFileSync(sigFile, 'utf8').trim();
  try {
    check(path.join(args.dir, name), signature);
  } catch (e) {
    fail(`${name}: ${e.message}`);
  }
  platforms[platform] = { signature, url: `${base}/${encodeURIComponent(name)}` };
  console.error(`release-feed: ${platform}: ${name}, signature checked`);
}
const notes = args.notes && fs.existsSync(args.notes) ? fs.readFileSync(args.notes, 'utf8').trim() : '';
const feed = { version: args.version, notes, pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), platforms };
const out = JSON.stringify(feed, null, 2) + '\n';
if (args.out) fs.writeFileSync(args.out, out);
else process.stdout.write(out);
