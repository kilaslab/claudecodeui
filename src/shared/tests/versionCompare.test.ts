import assert from 'node:assert/strict';

import { test } from 'vitest';

import { compareVersions } from '@/shared/hooks/useVersionCheck';

// This distribution versions its releases `X.Y.Z-kilas.N`: release N of its
// changes on top of upstream X.Y.Z. The update banner must see a newer one.

test('a later fork release of the same upstream version is newer', () => {
  assert.ok(compareVersions('1.37.5-kilas.2', '1.37.5-kilas.1') > 0);
  assert.ok(compareVersions('1.37.5-kilas.1', '1.37.5-kilas.2') < 0);
  assert.equal(compareVersions('1.37.5-kilas.1', '1.37.5-kilas.1'), 0);
});

test('a fork release on a newer upstream version is newer, whatever its build', () => {
  assert.ok(compareVersions('1.38.0-kilas.0', '1.37.5-kilas.9') > 0);
  assert.ok(compareVersions('1.37.10-kilas.0', '1.37.9-kilas.3') > 0);
});

test('a fork release sorts after the upstream version it builds on', () => {
  assert.ok(compareVersions('1.37.5-kilas.0', '1.37.5') >= 0);
  assert.ok(compareVersions('1.37.5-kilas.1', '1.37.5') > 0);
});

test('plain versions still compare by their numbers', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
});
