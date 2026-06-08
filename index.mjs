#!/usr/bin/env node
/**
 * BizzMachine MCP Server
 *
 * Exposes Czech/Slovak company data from BizzMachine API as MCP tools.
 * Tools: suggest, company, lookup, bulk_lookup,
 *        profile, contacts, financials, risks, metrics, indicators,
 *        nace, owned_companies
 *
 * Requires BIZMACHINE_API_KEY environment variable.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as api from './lib/api.mjs';
import * as cache from './lib/cache.mjs';

// --- Helpers ---

// NACE section letter → numeric code mapping
const NACE_SECTIONS = {
  A: '01', B: '05', C: '10', D: '35', E: '36', F: '41', G: '45',
  H: '49', I: '55', J: '58', K: '64', L: '68', M: '69', N: '77',
  O: '84', P: '85', Q: '86', R: '90', S: '94',
};

// Legal suffixes to strip for name matching
const LEGAL_SUFFIXES = [
  'spol. s r.o.', 'spol. s r. o.', 's.r.o.', 's. r. o.',
  'a.s.', 'a. s.', 'v.o.s.', 'v. o. s.', 'k.s.', 'k. s.', 'se',
];

/**
 * Detect if input is a domain (contains dot, no spaces).
 */
function isDomain(input) {
  return input.includes('.') && !input.includes(' ');
}

/**
 * Extract domain from a URL or domain string.
 * "https://www.alza.cz/foo" → "alza.cz"
 */
function extractDomain(urlOrDomain) {
  if (!urlOrDomain) return null;
  try {
    let s = urlOrDomain.trim();
    if (!s.startsWith('http')) s = 'https://' + s;
    const hostname = new URL(s).hostname;
    // Strip www.
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Get the "name" part of a domain: "alza.cz" → "alza"
 */
function domainNamePart(domain) {
  const dot = domain.indexOf('.');
  return dot > 0 ? domain.slice(0, dot) : domain;
}

/**
 * Normalize a name for matching: strip legal suffixes, remove diacritics, lowercase.
 */
function normalizeName(name) {
  if (!name) return '';
  let s = name;
  for (const suffix of LEGAL_SUFFIXES) {
    // Case-insensitive suffix removal with optional trailing comma/space
    const re = new RegExp('[,\\s]*' + suffix.replace(/\./g, '\\.').replace(/\s+/g, '\\s*') + '\\s*$', 'i');
    s = s.replace(re, '');
  }
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * Extract revenue from company data.
 * Handles both exact value and range (midpoint) formats.
 * Returns { amount: number|null, type: 'exact'|'estimated'|null, currency: string|null }
 */
function extractRevenue(companyData) {
  const metrics = companyData?.metrics || companyData?.data?.metrics;
  const revenue = metrics?.revenue;
  if (!revenue) return { amount: null, type: null, currency: null };

  // Exact value
  if (revenue.value?.amount != null) {
    return {
      amount: revenue.value.amount,
      type: 'exact',
      currency: revenue.value.currency || 'CZK',
    };
  }

  // Range → midpoint
  const lower = revenue.category?.lowerBound?.amount;
  const upper = revenue.category?.upperBound?.amount;
  if (lower != null && upper != null) {
    return {
      amount: Math.round((lower + upper) / 2),
      type: 'estimated',
      currency: revenue.category.lowerBound.currency || 'CZK',
    };
  }

  return { amount: null, type: null, currency: null };
}

/**
 * Extract employee count from company data.
 * Same dual format as revenue.
 */
function extractEmployees(companyData) {
  const metrics = companyData?.metrics || companyData?.data?.metrics;
  const employees = metrics?.employees;
  if (!employees) return { count: null, type: null };

  if (employees.value?.count != null) {
    return { count: employees.value.count, type: 'exact' };
  }

  // employees.value may just be a number
  if (typeof employees.value === 'number') {
    return { count: employees.value, type: 'exact' };
  }

  const lower = employees.category?.lowerBound;
  const upper = employees.category?.upperBound;
  if (lower != null && upper != null) {
    return { count: Math.round((lower + upper) / 2), type: 'estimated' };
  }

  return { count: null, type: null };
}

/**
 * Normalize NACE code — convert section letter to numeric if needed.
 */
function normalizeNace(code) {
  if (!code) return null;
  const s = String(code).trim().toUpperCase();
  if (s.length === 1 && NACE_SECTIONS[s]) return NACE_SECTIONS[s];
  return s;
}

/**
 * Find the best matching suggestion for a domain query.
 * Priority: domain match > name match > first result.
 */
function findBestMatch(suggestions, inputDomain) {
  if (!suggestions.length) return null;

  // 1. Domain match
  for (const s of suggestions) {
    const websiteUrl = s.contacts?.website?.url || s.website;
    const resultDomain = extractDomain(websiteUrl);
    if (resultDomain && resultDomain === inputDomain) {
      return { match: s, matchType: 'domain' };
    }
  }

  // 2. Name match (domain name part matches normalized company name)
  const inputName = normalizeName(domainNamePart(inputDomain));
  for (const s of suggestions) {
    const companyName = normalizeName(s.name);
    if (companyName.includes(inputName) || inputName.includes(companyName)) {
      return { match: s, matchType: 'name' };
    }
  }

  // 3. Fallback to first result
  return { match: suggestions[0], matchType: 'first' };
}

// --- Section extractors / formatters ---
//
// aggregated-data is a rich composite. Each company "area" (contacts, risks,
// financials, classification, identity) is a sub-section of it. These helpers
// turn the raw API shape into compact, AI-friendly output.

/** Unwrap the data root regardless of whether it's nested under `.data`. */
function agg(companyData) {
  return companyData?.data || companyData || {};
}

/**
 * Normalize a single metric into a flat shape.
 * Metrics come as { value, category, name, type, validFrom, validTo } where
 * `value` may be { amount, currency }, { count }, a number, or a boolean.
 */
function fmtMetric(m) {
  if (!m) return null;
  const out = { name: m.name || null };
  if (m.value != null && typeof m.value === 'object') {
    if (m.value.amount != null) { out.amount = m.value.amount; out.currency = m.value.currency || 'CZK'; }
    else if (m.value.count != null) { out.count = m.value.count; }
  } else if (m.value != null) {
    out.value = m.value;
  }
  if (m.category) {
    out.category = {
      code: m.category.code ?? null,
      name: m.category.name ?? null,
      lowerBound: m.category.lowerBound ?? null,
      upperBound: m.category.upperBound ?? null,
    };
  }
  if (m.validFrom || m.validTo) out.period = { from: m.validFrom || null, to: m.validTo || null };
  return out;
}

/** Pull the numeric/scalar value out of a metric for compact summaries. */
function metricScalar(m) {
  if (!m) return null;
  if (m.value != null && typeof m.value === 'object') return m.value.amount ?? m.value.count ?? null;
  if (m.value != null) return m.value;
  const lo = m.category?.lowerBound, hi = m.category?.upperBound;
  // Only average numeric bounds — currency bounds are objects ({amount,currency}).
  if (typeof lo === 'number' && typeof hi === 'number') {
    return Math.round((lo + hi) / 2);
  }
  return null;
}

/** Company-level contacts: phone, email, web, LinkedIn, Facebook, Twitter. */
function extractContacts(companyData) {
  const c = agg(companyData).contacts || {};
  const v = (x) => (x && x.value) || null;
  return {
    phone: v(c.phoneNumber),
    email: v(c.email),
    website: v(c.website),
    linkedIn: v(c.linkedIn),
    facebook: v(c.facebook),
    twitter: v(c.twitter),
  };
}

/** Risk signals: insolvency, liquidation, executions, tax arrears, etc. */
function extractRisks(companyData) {
  const d = agg(companyData);
  const current = d.risks?.current || [];
  const signals = current.map(r => ({
    name: r.name || null,
    code: r.code || null,
    severity: r.severity ?? null,
    validFrom: r.validFrom || null,
    validTo: r.validTo || null,
    sources: (r.sources || []).map(s => s.name).filter(Boolean),
  }));
  return {
    hasRisk: signals.length > 0,
    riskCount: metricScalar(d.metrics?.riskCount) ?? signals.length,
    health: d.basicInfo?.health?.name || null,
    signals,
  };
}

/** Financial summary (from the metrics block). Detailed line-item statements
 * require a higher API plan; this exposes the headline figures BizMachine
 * publishes for every company. */
function extractFinancials(companyData) {
  const m = agg(companyData).metrics || {};
  return {
    revenue: fmtMetric(m.revenue),
    revenueGrowth: fmtMetric(m.revenueGrowth),
    netProfitMargin: fmtMetric(m.netProfitMargin),
    ebit: fmtMetric(m.ebit),
    ebitda: fmtMetric(m.ebitda),
    ebitMargin: fmtMetric(m.ebitMargin),
    assetsTotal: fmtMetric(m.assetsTotal),
    registeredCapital: fmtMetric(m.registeredCapital),
    personnelCost: fmtMetric(m.personnelCost),
    isExporter: fmtMetric(m.isExporter),
    isImporter: fmtMetric(m.isImporter),
    latestFinancialsAvailable: fmtMetric(m.latestFinancialsAvailable),
  };
}

/** All available metrics, normalized. */
function extractMetrics(companyData) {
  const m = agg(companyData).metrics || {};
  const out = {};
  for (const key of Object.keys(m)) {
    if (key === '_meta') continue;
    out[key] = fmtMetric(m[key]);
  }
  return out;
}

/** NACE classification: primary + secondary activities. */
function extractNace(companyData) {
  const n = agg(companyData).nace || {};
  return {
    primary: n.primary ? { code: n.primary.code, name: n.primary.name } : null,
    other: (n.other || []).map(x => ({ code: x.code, name: x.name })),
  };
}

/** Address, normalized to a flat shape. */
function extractAddress(companyData) {
  const a = agg(companyData).address;
  if (!a) return null;
  return {
    text: a.text || null,
    street: a.streetName ? `${a.streetName} ${a.streetNumber || ''}`.trim() : null,
    city: a.city || null,
    postalCode: a.postalCode || null,
    coordinates: a.coordinates || null,
  };
}

/** Legal identity / registration details from basicInfo. */
function extractProfile(companyData) {
  const b = agg(companyData).basicInfo || {};
  const ids = b.identifiers || {};
  return {
    name: b.name || null,
    ico: b.nationalIn || null,
    vatIn: b.vatIn || null,
    isVerifiedVatPayer: b.isVerifiedVatPayer ?? null,
    dataBox: ids['cz-databox']?.value || null,
    establishedAt: b.establishedAt || null,
    disestablishedAt: b.disestablishedAt || null,
    health: b.health?.name || null,
    legalForm: b.legalForm?.name || null,
    institutionalSector: b.institutionalSector?.name || null,
    registration: b.registration ? {
      court: b.registration.court?.name || null,
      fileNumber: b.registration.fileNumber || null,
      recordUrl: b.registration.recordUrl || null,
    } : null,
    logo: b.logo?.url || null,
    selfDescription: b.selfDescription || null,
  };
}

/** Engagement scores from the indicators block embedded in aggregated-data. */
function extractScores(companyData) {
  const ind = agg(companyData).indicators || {};
  const score = (x) => (x && typeof x.value === 'number' ? x.value
    : (x?.timeline?.[0]?.value ?? null));
  return {
    activity: score(ind.activity),
    growth: score(ind.growth),
    reachability: score(ind.reachability),
  };
}

/** Count-level signals BizMachine publishes per company. Detailed listings
 * (individual vehicles, job posts, tenders) require a higher API plan. */
function extractSignalCounts(companyData) {
  const m = agg(companyData).metrics || {};
  return {
    openJobs: metricScalar(m.openJobCountCurrentTotal),
    vehiclesOperated: metricScalar(m.vehiclesOperatedTotal),
    vehiclesOwned: metricScalar(m.vehiclesOwnedTotal),
    vehiclesRegistered12Months: metricScalar(m.vehiclesRegistered12Months),
    eshopCount: metricScalar(m.eshopCount),
    locationCount: metricScalar(m.locationCount),
    connectedCompaniesCount: metricScalar(m.connectedCompaniesCount),
    businessCardsCount: metricScalar(m.businessCardsCount),
    riskCount: metricScalar(m.riskCount),
  };
}

/**
 * Build a rich, connector-style company profile from aggregated-data —
 * identity, address, classification, size, financials, scores, contacts,
 * risk and signal counts in one structured object.
 */
function buildProfile(ico, country, companyData) {
  const d = agg(companyData);
  return {
    ico,
    country,
    name: d.basicInfo?.name || null,
    identity: extractProfile(companyData),
    address: extractAddress(companyData),
    classification: extractNace(companyData),
    size: {
      revenue: fmtMetric(d.metrics?.revenue),
      revenueGrowth: fmtMetric(d.metrics?.revenueGrowth),
      employees: fmtMetric(d.metrics?.employees),
      registeredCapital: fmtMetric(d.metrics?.registeredCapital),
    },
    financials: extractFinancials(companyData),
    scores: extractScores(companyData),
    contacts: extractContacts(companyData),
    risk: extractRisks(companyData),
    signals: extractSignalCounts(companyData),
  };
}

// --- MCP Server ---

const server = new Server(
  { name: 'bizmachine', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'suggest',
    description:
      'Search BizzMachine for Czech/Slovak companies by name or domain. Returns matching companies with nationalId (ICO), name, and website.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Company name or domain to search for (e.g. "alza" or "Alza.cz a.s.")',
        },
        country: {
          type: 'string',
          enum: ['cz', 'sk'],
          description: 'Country database to search (default: "cz"). Use "sk" for Slovak companies.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'company',
    description:
      'Get full company data from BizzMachine by ICO (national ID). Returns revenue, employee count, NACE code, address, and more.',
    inputSchema: {
      type: 'object',
      properties: {
        ico: {
          type: 'string',
          description: 'Czech or Slovak business identification number (ICO), e.g. "27082440"',
        },
        country: {
          type: 'string',
          enum: ['cz', 'sk'],
          description: 'Country database (default: "cz"). Use "sk" for Slovak companies.',
        },
      },
      required: ['ico'],
    },
  },
  {
    name: 'lookup',
    description:
      'Smart lookup: accepts a company name or domain, searches BizzMachine (CZ first, then SK fallback), picks the best match, and returns structured data including revenue and employee count.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Company name or domain to look up (e.g. "mixit.cz" or "Košík")',
        },
        country: {
          type: 'string',
          enum: ['cz', 'sk', 'auto'],
          description: 'Country database. "auto" (default) tries CZ first, falls back to SK if not found.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'bulk_lookup',
    description:
      'Batch lookup for multiple companies. Takes an array of domains/names, runs smart lookup for each (CZ+SK auto-fallback). Returns array of results with revenue data. Uses 30-day cache.',
    inputSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of company names or domains to look up',
        },
      },
      required: ['queries'],
    },
  },
  {
    name: 'profile',
    description:
      'Rich company profile (connector-style) for a Czech/Slovak company: legal identity, registration, address, NACE classification, size, financial summary, engagement scores, contacts, risk signals, and activity counts — all in one call. Accepts an ICO or a name/domain.',
    inputSchema: {
      type: 'object',
      properties: {
        ico: { type: 'string', description: 'Business ID (ICO). Provide this OR query.' },
        query: { type: 'string', description: 'Company name or domain (auto-resolved to ICO). Provide this OR ico.' },
        country: { type: 'string', enum: ['cz', 'sk'], description: 'Country database. Default: "cz" with ico, auto-detect (CZ→SK) with query.' },
      },
    },
  },
  {
    name: 'contacts',
    description:
      'Company contact details: phone, email, website, LinkedIn, Facebook and Twitter. A key differentiator vs the hosted AI Konektor. Accepts an ICO or a name/domain.',
    inputSchema: {
      type: 'object',
      properties: {
        ico: { type: 'string', description: 'Business ID (ICO). Provide this OR query.' },
        query: { type: 'string', description: 'Company name or domain (auto-resolved to ICO). Provide this OR ico.' },
        country: { type: 'string', enum: ['cz', 'sk'], description: 'Country database. Default: "cz" with ico, auto-detect (CZ→SK) with query.' },
      },
    },
  },
  {
    name: 'financials',
    description:
      'Financial summary for a company: revenue, revenue growth, EBIT, EBITDA, margins, total assets, registered capital, personnel cost, and exporter/importer flags. Accepts an ICO or a name/domain.',
    inputSchema: {
      type: 'object',
      properties: {
        ico: { type: 'string', description: 'Business ID (ICO). Provide this OR query.' },
        query: { type: 'string', description: 'Company name or domain (auto-resolved to ICO). Provide this OR ico.' },
        country: { type: 'string', enum: ['cz', 'sk'], description: 'Country database. Default: "cz" with ico, auto-detect (CZ→SK) with query.' },
      },
    },
  },
  {
    name: 'risks',
    description:
      'Risk signals for a company: insolvency, liquidation, executions, tax arrears and similar, plus the overall health status. A differentiator vs the hosted AI Konektor. Accepts an ICO or a name/domain.',
    inputSchema: {
      type: 'object',
      properties: {
        ico: { type: 'string', description: 'Business ID (ICO). Provide this OR query.' },
        query: { type: 'string', description: 'Company name or domain (auto-resolved to ICO). Provide this OR ico.' },
        country: { type: 'string', enum: ['cz', 'sk'], description: 'Country database. Default: "cz" with ico, auto-detect (CZ→SK) with query.' },
      },
    },
  },
  {
    name: 'metrics',
    description:
      'All available BizMachine metrics for a company (revenue, employees, assets, margins, fleet counts, job counts, ownership shares, e-shop/location counts, and more), normalized. Accepts an ICO or a name/domain.',
    inputSchema: {
      type: 'object',
      properties: {
        ico: { type: 'string', description: 'Business ID (ICO). Provide this OR query.' },
        query: { type: 'string', description: 'Company name or domain (auto-resolved to ICO). Provide this OR ico.' },
        country: { type: 'string', enum: ['cz', 'sk'], description: 'Country database. Default: "cz" with ico, auto-detect (CZ→SK) with query.' },
      },
    },
  },
  {
    name: 'indicators',
    description:
      'Engagement indicators (0-100 scores) for a company: activity, growth and reachability, each with the top weighted drivers behind the score. Useful for prioritizing prospects. Accepts an ICO or a name/domain.',
    inputSchema: {
      type: 'object',
      properties: {
        ico: { type: 'string', description: 'Business ID (ICO). Provide this OR query.' },
        query: { type: 'string', description: 'Company name or domain (auto-resolved to ICO). Provide this OR ico.' },
        country: { type: 'string', enum: ['cz', 'sk'], description: 'Country database. Default: "cz" with ico, auto-detect (CZ→SK) with query.' },
      },
    },
  },
  {
    name: 'nace',
    description:
      'NACE industry classification for a company: primary activity plus secondary activities. Accepts an ICO or a name/domain.',
    inputSchema: {
      type: 'object',
      properties: {
        ico: { type: 'string', description: 'Business ID (ICO). Provide this OR query.' },
        query: { type: 'string', description: 'Company name or domain (auto-resolved to ICO). Provide this OR ico.' },
        country: { type: 'string', enum: ['cz', 'sk'], description: 'Country database. Default: "cz" with ico, auto-detect (CZ→SK) with query.' },
      },
    },
  },
  {
    name: 'owned_companies',
    description:
      'Companies owned by this company (downward ownership graph — subsidiaries and held stakes), each with name, ICO and address. Accepts an ICO or a name/domain.',
    inputSchema: {
      type: 'object',
      properties: {
        ico: { type: 'string', description: 'Business ID (ICO). Provide this OR query.' },
        query: { type: 'string', description: 'Company name or domain (auto-resolved to ICO). Provide this OR ico.' },
        country: { type: 'string', enum: ['cz', 'sk'], description: 'Country database. Default: "cz" with ico, auto-detect (CZ→SK) with query.' },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// --- Tool handlers ---

async function handleSuggest(query, country = 'cz') {
  const cacheKey = `${country}:${query}`;
  const cached = await cache.get('suggest', cacheKey);
  if (cached) return cached;

  const results = await api.suggest(query, country);
  await cache.set('suggest', cacheKey, results);
  return results;
}

async function handleCompany(ico, country = 'cz') {
  const cacheKey = `${country}:${ico}`;
  const cached = await cache.get('company', cacheKey);
  // Cached negatives (not-found) are stored as a sentinel so they aren't
  // re-fetched on every call — a plain null would be indistinguishable from
  // a cache miss.
  if (cached) return cached.__notFound ? null : cached;

  const data = await api.getCompany(ico, country);
  await cache.set('company', cacheKey, data === null ? { __notFound: true } : data);
  return data;
}

/**
 * Smart lookup with domain-first matching strategy.
 * Supports CZ/SK/auto country selection.
 *
 * For domains:
 *   1. Try suggest with full domain (e.g. "alza.cz")
 *   2. Try suggest with domain name part (e.g. "alza")
 *   3. Match by domain first, then name, then first result
 *
 * For 'auto' mode: tries CZ first, falls back to SK if not found or no revenue.
 */
async function handleLookupForCountry(query, country) {
  const queryIsDomain = isDomain(query);
  let suggestions = [];
  let bestMatch = null;

  if (queryIsDomain) {
    const inputDomain = extractDomain(query);

    suggestions = await handleSuggest(query, country);
    bestMatch = findBestMatch(suggestions, inputDomain);

    if (!bestMatch || bestMatch.matchType !== 'domain') {
      const namePart = domainNamePart(inputDomain);
      if (namePart !== query) {
        const altSuggestions = await handleSuggest(namePart, country);
        const altMatch = findBestMatch(altSuggestions, inputDomain);
        if (altMatch && (altMatch.matchType === 'domain' || !bestMatch)) {
          suggestions = altSuggestions;
          bestMatch = altMatch;
        }
      }
    }
  } else {
    suggestions = await handleSuggest(query, country);
    if (suggestions.length) {
      bestMatch = { match: suggestions[0], matchType: 'name' };
    }
  }

  if (!bestMatch) {
    return { query, country, found: false, suggestions: [], company: null };
  }

  const best = bestMatch.match;
  const ico = best.nationalIn || best.nationalId;
  if (!ico) {
    return {
      query, country, found: true, matchType: bestMatch.matchType,
      suggestions: suggestions.slice(0, 5), company: null, error: 'No ICO in best match',
    };
  }

  const companyData = await handleCompany(ico, country);
  const revenue = extractRevenue(companyData);
  const employees = extractEmployees(companyData);
  const nace = normalizeNace(
    companyData?.activities?.nace?.primary?.code ||
    companyData?.nace?.primary?.code
  );

  return {
    query, country, found: true, matchType: bestMatch.matchType,
    match: { ico, name: best.name, website: best.contacts?.website?.url || best.website || null },
    revenue, employees, nace, raw: companyData,
  };
}

async function handleLookup(query, country = 'auto') {
  if (country === 'cz' || country === 'sk') {
    return handleLookupForCountry(query, country);
  }

  // Auto mode: try CZ first
  const czResult = await handleLookupForCountry(query, 'cz');

  // If CZ found with revenue, return it
  if (czResult.found && czResult.revenue?.amount > 0) {
    return czResult;
  }

  // Try SK
  const skResult = await handleLookupForCountry(query, 'sk');

  // If SK found with revenue, prefer it
  if (skResult.found && skResult.revenue?.amount > 0) {
    return skResult;
  }

  // Return whichever found something (prefer CZ)
  if (czResult.found) return czResult;
  if (skResult.found) return skResult;

  return { query, country: 'auto', found: false, suggestions: [], company: null };
}

async function handleBulkLookup(queries) {
  const results = [];
  for (const query of queries) {
    try {
      const result = await handleLookup(query);
      results.push(result);
    } catch (err) {
      results.push({ query, found: false, error: err.message });
    }
  }

  const found = results.filter(r => r.found).length;
  const withRevenue = results.filter(r => r.revenue?.amount != null).length;

  return {
    summary: { total: queries.length, found, withRevenue },
    results,
  };
}

// --- Section tool resolver + handlers ---

/**
 * Resolve {ico, query, country} → { ico, country }.
 * By ICO: uses `country` directly (defaults to 'cz').
 * By query: an explicit 'cz'/'sk' is honored; otherwise CZ-first with SK
 * fallback ('auto').
 */
async function resolveIco({ ico, query, country }) {
  if (ico) return { ico, country: country || 'cz' };
  if (query) {
    const r = await handleLookup(query, country || 'auto');
    if (!r.found || !r.match?.ico) {
      throw new Error(`No company found for "${query}"`);
    }
    return { ico: r.match.ico, country: r.country || country || 'cz' };
  }
  throw new Error('Provide either "ico" or "query".');
}

/**
 * Resolve to { ico, country, data } where data is aggregated-data.
 * Reuses the cached lookup `raw` payload when resolving by query to avoid a
 * second API round-trip. An explicit `country` is honored on both paths.
 */
async function resolveAggregated({ ico, query, country }) {
  if (ico) {
    const c = country || 'cz';
    const data = await handleCompany(ico, c);
    if (!data) throw new Error(`No company found for ICO "${ico}" (country: ${c}).`);
    return { ico, country: c, data };
  }
  if (query) {
    const r = await handleLookup(query, country || 'auto');
    if (!r.found || !r.match?.ico) {
      throw new Error(`No company found for "${query}"`);
    }
    return { ico: r.match.ico, country: r.country || country || 'cz', data: r.raw };
  }
  throw new Error('Provide either "ico" or "query".');
}

async function handleProfile(args) {
  const { ico, country, data } = await resolveAggregated(args);
  return buildProfile(ico, country, data);
}

async function handleSection(args, extractor) {
  const { ico, country, data } = await resolveAggregated(args);
  return { ico, country, ...extractor(data) };
}

/** Engagement indicators with top drivers, via the richer v3 endpoint. */
async function handleIndicators(args) {
  const { ico, country } = await resolveIco(args);
  const cacheKey = `${country}:${ico}`;
  let raw = await cache.get('indicators', cacheKey);
  if (!raw) {
    raw = await api.getIndicators(ico, country);
    if (!raw) throw new Error(`No indicators found for ICO "${ico}" (country: ${country}).`);
    await cache.set('indicators', cacheKey, raw);
  }
  const ind = raw?.indicators || raw?.data?.indicators || {};
  const fmt = (x) => {
    if (!x) return null;
    const latest = x.timeline?.[0];
    return {
      score: typeof x.value === 'number' ? x.value : (latest?.value ?? null),
      topDrivers: (latest?.drivers || x.drivers || [])
        .slice(0, 8)
        .map(d => ({ name: d.name, weight: d.weight })),
    };
  };
  return {
    ico, country,
    activity: fmt(ind.activity),
    growth: fmt(ind.growth),
    reachability: fmt(ind.reachability),
  };
}

/** Owned companies (subsidiaries) via the v3 endpoint. */
async function handleOwnedCompanies(args) {
  const { ico, country } = await resolveIco(args);
  const cacheKey = `${country}:${ico}`;
  let raw = await cache.get('owned', cacheKey);
  if (!raw) {
    raw = await api.getOwnedCompanies(ico, country);
    if (!raw) throw new Error(`No company found for ICO "${ico}" (country: ${country}).`);
    await cache.set('owned', cacheKey, raw);
  }
  const list = raw?.ownedCompanies || raw?.data?.ownedCompanies || [];
  const seen = new Set();
  const ownedCompanies = [];
  for (const c of list) {
    const key = c.nationalIn || c.uniqueId || c.name;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    ownedCompanies.push({
      ico: c.nationalIn || null,
      name: c.name || null,
      address: c.address?.text || null,
    });
  }
  return { ico, country, count: ownedCompanies.length, ownedCompanies };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case 'suggest':
        result = await handleSuggest(args.query, args.country || 'cz');
        break;
      case 'company':
        result = await handleCompany(args.ico, args.country || 'cz');
        if (result == null) {
          throw new Error(`No company found for ICO "${args.ico}" (country: ${args.country || 'cz'}).`);
        }
        break;
      case 'lookup':
        result = await handleLookup(args.query, args.country || 'auto');
        break;
      case 'bulk_lookup':
        result = await handleBulkLookup(args.queries);
        break;
      case 'profile':
        result = await handleProfile(args);
        break;
      case 'contacts':
        result = await handleSection(args, (d) => ({ contacts: extractContacts(d) }));
        break;
      case 'financials':
        result = await handleSection(args, (d) => ({ financials: extractFinancials(d) }));
        break;
      case 'risks':
        result = await handleSection(args, (d) => ({ risk: extractRisks(d) }));
        break;
      case 'metrics':
        result = await handleSection(args, (d) => ({ metrics: extractMetrics(d) }));
        break;
      case 'nace':
        result = await handleSection(args, (d) => ({ nace: extractNace(d) }));
        break;
      case 'indicators':
        result = await handleIndicators(args);
        break;
      case 'owned_companies':
        result = await handleOwnedCompanies(args);
        break;
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
