import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readNpmPackageInstallation } from '@/shared/utils.js';

// The update commands must name the package that is installed. A fork
// publishes under its own name, and a global install under an alias has to
// keep that alias, or npm installs a second copy beside the running one.

async function withPackage(
  relativeRoot: string,
  packageName: string,
  run: (applicationRoot: string) => void | Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'npm-package-installation-'));
  try {
    const applicationRoot = path.join(directory, relativeRoot);
    await mkdir(applicationRoot, { recursive: true });
    await writeFile(path.join(applicationRoot, 'package.json'), JSON.stringify({ name: packageName }), 'utf8');
    await run(applicationRoot);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a package installed under its own scoped name updates by that name', async () => {
  await withPackage('lib/node_modules/@kilaslab/agent-console', '@kilaslab/agent-console', (applicationRoot) => {
    assert.deepEqual(readNpmPackageInstallation(applicationRoot), {
      packageName: '@kilaslab/agent-console',
      installName: '@kilaslab/agent-console',
      globalInstallCommand: 'npm install -g @kilaslab/agent-console@latest',
    });
  });
});

test('a package installed under an alias keeps the alias when it updates', async () => {
  await withPackage('lib/node_modules/@cloudcli-ai/cloudcli', '@kilaslab/agent-console', (applicationRoot) => {
    assert.deepEqual(readNpmPackageInstallation(applicationRoot), {
      packageName: '@kilaslab/agent-console',
      installName: '@cloudcli-ai/cloudcli',
      globalInstallCommand: 'npm install -g @cloudcli-ai/cloudcli@npm:@kilaslab/agent-console@latest',
    });
  });
});

test('an unscoped alias is read from its node_modules folder', async () => {
  await withPackage('lib/node_modules/agent-console', '@kilaslab/agent-console', (applicationRoot) => {
    assert.equal(
      readNpmPackageInstallation(applicationRoot).globalInstallCommand,
      'npm install -g agent-console@npm:@kilaslab/agent-console@latest',
    );
  });
});

test('a source checkout outside node_modules uses the package name', async () => {
  await withPackage('projects/claudecodeui', '@kilaslab/agent-console', (applicationRoot) => {
    assert.equal(readNpmPackageInstallation(applicationRoot).installName, '@kilaslab/agent-console');
  });
});
