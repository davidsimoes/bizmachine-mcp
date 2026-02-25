#!/usr/bin/env node
/**
 * BizzMachine MCP Server
 *
 * Exposes Czech/Slovak company data from BizzMachine API as MCP tools.
 * Tools: suggest, company, lookup, bulk_lookup
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

// --- MCP Server ---

const server = new Server(
  { name: 'bizmachine', version: '1.0.0' },
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
  if (cached) return cached;

  const data = await api.getCompany(ico, country);
  await cache.set('company', cacheKey, data);
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
        break;
      case 'lookup':
        result = await handleLookup(args.query, args.country || 'auto');
        break;
      case 'bulk_lookup':
        result = await handleBulkLookup(args.queries);
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
