/**
 * BizMachine API client.
 *
 * The BizMachine data API is versioned per-resource: most company endpoints
 * live under /{country}/v4, a few only under /{country}/v3. We use:
 *   - v4: /companies/suggest, /companies/{ico}/aggregated-data
 *   - v3: /companies/{ico}/indicators, /companies/{ico}/owned-companies
 *
 * aggregated-data is a rich composite (address, basicInfo, metrics, nace,
 * contacts, indicators, risks) — the section helpers in index.mjs extract
 * sub-sections from it rather than calling the standalone endpoints, several
 * of which require a higher API plan tier.
 *
 * Supports both CZ and SK country databases.
 */

const BASE_CZ = 'https://api.bizmachine.com/cz/v4';
const BASE_SK = 'https://api.bizmachine.com/sk/v4';
const BASE_CZ_V3 = 'https://api.bizmachine.com/cz/v3';
const BASE_SK_V3 = 'https://api.bizmachine.com/sk/v3';
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

function getBaseV3(country = 'cz') {
  return country === 'sk' ? BASE_SK_V3 : BASE_CZ_V3;
}

/**
 * Shared authenticated GET → unwrapped data.
 * Throws on non-2xx (with a 403 hint that the endpoint needs a higher plan
 * tier) and on application-level { error } payloads.
 */
async function apiGet(url, label) {
  await rateLimit();
  const res = await fetch(url, { headers: { 'x-api-key': getApiKey() } });

  if (!res.ok) {
    const text = await res.text();
    const hint = res.status === 403
      ? ' (forbidden — this endpoint likely requires a higher BizMachine API plan)'
      : '';
    throw new Error(`BizMachine ${label} ${res.status}${hint}: ${text.slice(0, 300)}`);
  }

  // 204 No Content = not found (BizMachine's "no such company" response)
  if (res.status === 204) return null;

  const json = await res.json();
  if (json && json.error) {
    throw new Error(`BizMachine ${label} error: ${JSON.stringify(json.error).slice(0, 200)}`);
  }
  return json.data || json;
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
    throw new Error(`BizMachine suggest ${res.status}: ${text.slice(0, 300)}`);
  }

  // 204 No Content = no matches
  if (res.status === 204) return [];

  const json = await res.json();
  if (json && json.error) {
    throw new Error(`BizMachine suggest error: ${json.error}`);
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
    throw new Error(`BizMachine company ${res.status}: ${text.slice(0, 300)}`);
  }

  // 204 No Content = company not found
  if (res.status === 204) return null;

  const json = await res.json();
  if (json && json.error) {
    throw new Error(`BizMachine company error: ${json.error}`);
  }
  return json.data || json;
}

/**
 * Get engagement indicators (v3): activity, growth, reachability and covid19
 * scores (0-100), each with a multi-year timeline and weighted drivers.
 * Richer than the indicators block embedded in aggregated-data.
 * @param {string} ico - National ID
 * @param {string} country - 'cz' or 'sk' (default: 'cz')
 */
export async function getIndicators(ico, country = 'cz') {
  const url = `${getBaseV3(country)}/companies/${encodeURIComponent(ico)}/indicators`;
  return apiGet(url, 'indicators');
}

/**
 * Get companies owned by this company (v3) — the downward ownership graph
 * (subsidiaries / held stakes), with name, ICO and address for each.
 * @param {string} ico - National ID
 * @param {string} country - 'cz' or 'sk' (default: 'cz')
 */
export async function getOwnedCompanies(ico, country = 'cz') {
  const url = `${getBaseV3(country)}/companies/${encodeURIComponent(ico)}/owned-companies`;
  return apiGet(url, 'owned-companies');
}
