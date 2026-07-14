#!/usr/bin/env node
/**
 * BizMachine MCP Server
 *
 * Exposes Czech/Slovak company data from BizMachine API as MCP tools.
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
import {
  isDomain, extractDomain, domainNamePart, findBestMatch, namesMatch, normalizeName,
  extractRevenue, extractEmployees, normalizeNace, buildProfile,
  extractContacts, extractFinancials, extractRisks, extractMetrics, extractNace,
} from './lib/extract.mjs';

// --- MCP Server ---

const server = new Server(
  { name: 'bizmachine', version: '1.1.1' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'suggest',
    description:
      'Search BizMachine for Czech/Slovak companies by name or domain. Returns matching companies with nationalId (ICO), name, and website.',
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
      'Get full company data from BizMachine by ICO (national ID). Returns revenue, employee count, NACE code, address, and more.',
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
      'Smart lookup: accepts a company name or domain, searches BizMachine (CZ first, then SK fallback), picks the best match, and returns structured data including revenue and employee count.',
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
      'Company contact details: phone, email, website, LinkedIn, Facebook and Twitter. Accepts an ICO or a name/domain.',
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
      'Risk signals for a company: insolvency, liquidation, executions, tax arrears and similar, plus the overall health status. Accepts an ICO or a name/domain.',
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
    // Name query. Only accept the top suggestion if its name actually relates to
    // the query — the old code took suggestions[0] unconditionally and labelled
    // it a 'name' match, so "fakta" happily resolved to an unrelated factoring
    // company. A wrong company is worse than no company.
    suggestions = await handleSuggest(query, country);
    const inputName = normalizeName(query);
    for (const s of suggestions) {
      if (namesMatch(normalizeName(s.name), inputName)) {
        bestMatch = { match: s, matchType: 'name' };
        break;
      }
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
