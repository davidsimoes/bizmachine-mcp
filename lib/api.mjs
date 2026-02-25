/**
 * BizzMachine API client.
 * Endpoints: /companies/suggest, /companies/{ico}/aggregated-data
 * Supports both CZ and SK country endpoints.
 */

const BASE_CZ = 'https://api.bizmachine.com/cz/v4';
const BASE_SK = 'https://api.bizmachine.com/sk/v4';
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

function getBase(country = 'cz') {
  return country === 'sk' ? BASE_SK : BASE_CZ;
}

/**
 * Search companies by name or domain.
 * @param {string} query - Search term
 * @param {string} country - 'cz' or 'sk' (default: 'cz')
 * Returns array of { nationalIn, name, contacts, ... }
 */
export async function suggest(query, country = 'cz') {
  await rateLimit();
  const encoded = encodeURIComponent(query);
  const url = `${getBase(country)}/companies/suggest?query=${encoded}`;
  const res = await fetch(url, {
    headers: { 'x-api-key': getApiKey() },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BizzMachine suggest ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  if (json && json.error) {
    throw new Error(`BizzMachine suggest error: ${json.error}`);
  }
  const data = json.data || json;
  if (!Array.isArray(data)) return [];
  return data;
}

/**
 * Get full company data by ICO (national ID).
 * @param {string} ico - National ID
 * @param {string} country - 'cz' or 'sk' (default: 'cz')
 * Returns aggregated company data including revenue, employees, NACE, etc.
 */
export async function getCompany(ico, country = 'cz') {
  await rateLimit();
  const url = `${getBase(country)}/companies/${encodeURIComponent(ico)}/aggregated-data`;
  const res = await fetch(url, {
    headers: { 'x-api-key': getApiKey() },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BizzMachine company ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  if (json && json.error) {
    throw new Error(`BizzMachine company error: ${json.error}`);
  }
  return json.data || json;
}
