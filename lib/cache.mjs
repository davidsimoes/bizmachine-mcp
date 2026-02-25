/**
 * File-based cache for BizzMachine API responses.
 * Stores in ~/.cache/bizmachine/ with 30-day TTL.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const CACHE_DIR = join(homedir(), '.cache', 'bizmachine');
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let initialized = false;

async function ensureDir() {
  if (initialized) return;
  await mkdir(CACHE_DIR, { recursive: true });
  initialized = true;
}

function cacheKey(prefix, query) {
  const hash = createHash('sha256').update(query).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${prefix}_${hash}.json`);
}

/**
 * Get cached value. Returns null if missing or expired.
 */
export async function get(prefix, query) {
  await ensureDir();
  const path = cacheKey(prefix, query);
  try {
    const raw = await readFile(path, 'utf8');
    const entry = JSON.parse(raw);
    if (Date.now() - entry.timestamp > TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

/**
 * Store value in cache.
 */
export async function set(prefix, query, data) {
  await ensureDir();
  const path = cacheKey(prefix, query);
  const entry = { timestamp: Date.now(), query, data };
  await writeFile(path, JSON.stringify(entry, null, 2), 'utf8');
}
