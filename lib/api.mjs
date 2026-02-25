/**
 * BizzMachine API client.
 * Endpoints: /companies/suggest, /companies/{ico}/aggregated-data
 */

const BASE = 'https://api.bizmachine.com/cz/v4';
const RATE_DELAY_MS = 150;

let lastCallTime = 0;

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < RATE_DELAY_MS) {
    await new Promise(r => setTimeout(r, RATE_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
}

function getApiKey() {
  const key = process.env.BIZMACHINE_API_KEY;
  if (!key) throw new Error('BIZMACHINE_API_KEY environment variable is required');
  return key;
}

/**
 * Search companies by name or domain.
 * Returns array of { nationalId, name, contacts, ... }
 */
export async function suggest(query) {
  await rateLimit();
  const encoded = encodeURIComponent(query);
  const url = `${BASE}/companies/suggest?query=${encoded}`;
  const res = await fetch(url, {
    headers: { 'x-api-key': getApiKey() },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BizzMachine suggest ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  // Check for silent errors (neverError pattern)
  if (data && data.error) {
    throw new Error(`BizzMachine suggest error: ${data.error}`);
  }
  if (!Array.isArray(data)) return [];
  return data;
}

/**
 * Get full company data by ICO (national ID).
 * Returns aggregated company data including revenue, employees, NACE, etc.
 * Note: response may be wrapped in { data: ... }
 */
export async function getCompany(ico) {
  await rateLimit();
  const url = `${BASE}/companies/${encodeURIComponent(ico)}/aggregated-data`;
  const res = await fetch(url, {
    headers: { 'x-api-key': getApiKey() },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BizzMachine company ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  // Check for silent errors
  if (json && json.error) {
    throw new Error(`BizzMachine company error: ${json.error}`);
  }
  // Unwrap response.data wrapper if present
  return json.data || json;
}
