#!/usr/bin/env node
// Applies this fork's package identity to package.json and package-lock.json.
//
// Upstream releases change both files (version, dependencies), and every
// such change collides with the fork's name and version lines. The upstream
// sync workflow therefore takes upstream's copies, so their dependencies win,
// and runs this to put the fork's identity back. Also usable by hand when
// cutting a release:
//
//   node scripts/fork/apply-package-identity.mjs 1.38.0-kilas.0
//
// Without a version argument the current version is kept.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const IDENTITY = {
  name: '@kilaslab/agent-console',
  description:
    'Agent Console: a web UI for Claude Code and other coding agents, a modified version of CloudCLI UI (https://github.com/siteboon/claudecodeui)',
  bin: { 'agent-console': 'dist-server/server/modules/cli/cli.js' },
  homepage: 'https://github.com/kilaslab/claudecodeui#readme',
  repository: { type: 'git', url: 'git+https://github.com/kilaslab/claudecodeui.git' },
  bugs: { url: 'https://github.com/kilaslab/claudecodeui/issues' },
  publishConfig: { access: 'public' },
};

/** Rebuilds `object` with `key` set to `value`, inserted after `afterKey` when it is new. */
function withKey(object, key, value, afterKey) {
  if (key in object) {
    return { ...object, [key]: value };
  }
  const entries = Object.entries(object);
  const index = entries.findIndex(([entryKey]) => entryKey === afterKey);
  entries.splice(index === -1 ? entries.length : index + 1, 0, [key, value]);
  return Object.fromEntries(entries);
}

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, fileName), 'utf8'));
}

function writeJson(fileName, value) {
  fs.writeFileSync(path.join(ROOT, fileName), `${JSON.stringify(value, null, 2)}\n`);
}

const requestedVersion = process.argv[2];
if (requestedVersion !== undefined && !/^\d+\.\d+\.\d+-kilas\.\d+$/.test(requestedVersion)) {
  console.error(`Expected a version like 1.38.0-kilas.0, got "${requestedVersion}".`);
  process.exit(1);
}

let manifest = readJson('package.json');
const version = requestedVersion ?? manifest.version;
manifest = { ...manifest, name: IDENTITY.name, version, description: IDENTITY.description, bin: IDENTITY.bin };
manifest.files = [...new Set([...(manifest.files ?? []), 'NOTICE'])];
manifest = { ...manifest, homepage: IDENTITY.homepage, repository: IDENTITY.repository, bugs: IDENTITY.bugs };
manifest = withKey(manifest, 'publishConfig', IDENTITY.publishConfig, 'bugs');
writeJson('package.json', manifest);

const lock = readJson('package-lock.json');
lock.name = IDENTITY.name;
lock.version = version;
lock.packages[''] = { ...lock.packages[''], name: IDENTITY.name, version, bin: IDENTITY.bin };
writeJson('package-lock.json', lock);

console.log(`${IDENTITY.name}@${version}`);
