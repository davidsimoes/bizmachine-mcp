import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HARD SAFETY: redirect HOME to a throwaway temp dir BEFORE importing cache.mjs so the cache
// directory (derived from os.homedir() at import time) lands in the temp dir, never the real
// ~/.cache/bizmachine. Real fs is used, but only inside this disposable directory.
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const TMP_HOME = mkdtempSync(join(tmpdir(), 'bizmachine-cache-test-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const CACHE_DIR = join(TMP_HOME, '.cache', 'bizmachine');

// Dynamic import AFTER HOME is overridden, so the module-level CACHE_DIR points into TMP_HOME.
const cache = await import('../lib/cache.mjs');

after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
});

test('cache directory is created under the temp HOME, not the real cache', async () => {
  await cache.set('init', 'q', { a: 1 });
  assert.ok(existsSync(CACHE_DIR), 'cache dir should exist inside the temp HOME');
});

test('set then get round-trips the stored data', async () => {
  await cache.set('round', 'alza.cz', { revenue: 123, name: 'Alza' });
  assert.deepEqual(await cache.get('round', 'alza.cz'), { revenue: 123, name: 'Alza' });
});

test('get returns null for a missing key', async () => {
  assert.equal(await cache.get('round', 'does-not-exist'), null);
});

test('different (prefix, query) pairs map to distinct files without collision', async () => {
  await cache.set('suggest', 'q1', { v: 1 });
  await cache.set('suggest', 'q2', { v: 2 });
  await cache.set('company', 'q1', { v: 3 }); // same query, different prefix
  assert.deepEqual(await cache.get('suggest', 'q1'), { v: 1 });
  assert.deepEqual(await cache.get('suggest', 'q2'), { v: 2 });
  assert.deepEqual(await cache.get('company', 'q1'), { v: 3 });

  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  for (const pair of [['suggest', 'q1'], ['suggest', 'q2'], ['company', 'q1']]) {
    // each pair must have produced at least one distinct json file
    assert.ok(files.length >= 3, `expected ≥3 distinct cache files, got ${files.length}`);
  }
});

test('TTL: an entry older than 30 days returns null; within 30 days it is served', async () => {
  const realNow = Date.now;
  let t = 1_700_000_000_000; // fixed virtual clock
  Date.now = () => t;
  try {
    await cache.set('ttl', 'k', { fresh: true });

    // +1 day → still within the 30-day TTL
    t += 24 * 60 * 60 * 1000;
    assert.deepEqual(await cache.get('ttl', 'k'), { fresh: true });

    // advance past 30 days total → expired
    t += 31 * 24 * 60 * 60 * 1000;
    assert.equal(await cache.get('ttl', 'k'), null);
  } finally {
    Date.now = realNow;
  }
});
