#!/usr/bin/env node
/**
 * Batch enrichment script for Petr's spreadsheet.
 * Calls BizMachine suggest + aggregated-data for each domain.
 * Outputs JSON with revenue data.
 *
 * Usage: node enrich-batch.mjs < domains.json > results.json
 * Input: ["4camping.cz", "alza.cz", ...]
 * Output: [{ domain, found, revenue, revenueType, ico, name, employees }, ...]
 */

import * as api from './lib/api.mjs';
import * as cache from './lib/cache.mjs';

// --- Helpers (same as index.mjs) ---

const LEGAL_SUFFIXES = [
  'spol. s r.o.', 'spol. s r. o.', 's.r.o.', 's. r. o.',
  'a.s.', 'a. s.', 'v.o.s.', 'v. o. s.', 'k.s.', 'k. s.', 'se',
];

function extractDomain(urlOrDomain) {
  if (!urlOrDomain) return null;
  try {
    let s = urlOrDomain.trim();
    if (!s.startsWith('http')) s = 'https://' + s;
    return new URL(s).hostname.replace(/^www\./, '');
  } catch { return null; }
}

function domainNamePart(domain) {
  const dot = domain.indexOf('.');
  return dot > 0 ? domain.slice(0, dot) : domain;
}

function normalizeName(name) {
  if (!name) return '';
  let s = name;
  for (const suffix of LEGAL_SUFFIXES) {
    const re = new RegExp('[,\\s]*' + suffix.replace(/\./g, '\\.').replace(/\s+/g, '\\s*') + '\\s*$', 'i');
    s = s.replace(re, '');
  }
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function findBestMatch(suggestions, inputDomain) {
  if (!suggestions.length) return null;
  for (const s of suggestions) {
    const websiteUrl = s.contacts?.website?.url || s.website;
    const resultDomain = extractDomain(websiteUrl);
    if (resultDomain && resultDomain === inputDomain) return { match: s, matchType: 'domain' };
  }
  const inputName = normalizeName(domainNamePart(inputDomain));
  for (const s of suggestions) {
    const companyName = normalizeName(s.name);
    if (companyName.includes(inputName) || inputName.includes(companyName)) return { match: s, matchType: 'name' };
  }
  return { match: suggestions[0], matchType: 'first' };
}

function extractRevenue(data) {
  const metrics = data?.metrics || data?.data?.metrics;
  const revenue = metrics?.revenue;
  if (!revenue) return { amount: null, type: null };
  if (revenue.value?.amount != null) return { amount: revenue.value.amount, type: 'exact' };
  const lower = revenue.category?.lowerBound?.amount;
  const upper = revenue.category?.upperBound?.amount;
  if (lower != null && upper != null) return { amount: Math.round((lower + upper) / 2), type: 'estimated' };
  return { amount: null, type: null };
}

function extractEmployees(data) {
  const metrics = data?.metrics || data?.data?.metrics;
  const employees = metrics?.employees;
  if (!employees) return null;
  if (employees.value?.count != null) return employees.value.count;
  if (typeof employees.value === 'number') return employees.value;
  const lower = employees.category?.lowerBound;
  const upper = employees.category?.upperBound;
  if (lower != null && upper != null) return Math.round((lower + upper) / 2);
  return null;
}

// --- Main ---

async function lookupDomain(domain) {
  const inputDomain = extractDomain(domain);

  // Try suggest with full domain
  let cachedSuggest = await cache.get('suggest', domain);
  let suggestions = cachedSuggest || await api.suggest(domain);
  if (!cachedSuggest) await cache.set('suggest', domain, suggestions);

  let bestMatch = findBestMatch(suggestions, inputDomain);

  // If no domain match, try domain name part
  if (!bestMatch || bestMatch.matchType !== 'domain') {
    const namePart = domainNamePart(inputDomain);
    if (namePart !== domain) {
      let cachedAlt = await cache.get('suggest', namePart);
      let altSuggestions = cachedAlt || await api.suggest(namePart);
      if (!cachedAlt) await cache.set('suggest', namePart, altSuggestions);

      const altMatch = findBestMatch(altSuggestions, inputDomain);
      if (altMatch && (altMatch.matchType === 'domain' || !bestMatch)) {
        suggestions = altSuggestions;
        bestMatch = altMatch;
      }
    }
  }

  if (!bestMatch || !(bestMatch.match.nationalIn || bestMatch.match.nationalId)) {
    return { domain, found: false, revenue: null, revenueType: null, ico: null, name: null, employees: null };
  }

  const ico = bestMatch.match.nationalIn || bestMatch.match.nationalId;
  let cachedCompany = await cache.get('company', ico);
  let companyData = cachedCompany || await api.getCompany(ico);
  if (!cachedCompany) await cache.set('company', ico, companyData);

  const revenue = extractRevenue(companyData);
  const employees = extractEmployees(companyData);

  return {
    domain,
    found: true,
    matchType: bestMatch.matchType,
    revenue: revenue.amount,
    revenueType: revenue.type,
    ico,
    name: bestMatch.match.name,
    employees,
  };
}

async function main() {
  // Read domains from stdin
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const domains = JSON.parse(input);

  const results = [];
  for (let i = 0; i < domains.length; i++) {
    const domain = domains[i];
    try {
      const result = await lookupDomain(domain);
      results.push(result);
      const status = result.found ? `✓ ${result.revenue ? (result.revenue / 1000000).toFixed(1) + 'M' : 'no rev'}` : '✗';
      process.stderr.write(`[${i + 1}/${domains.length}] ${domain} ${status}\n`);
    } catch (err) {
      results.push({ domain, found: false, error: err.message, revenue: null, revenueType: null, ico: null, name: null, employees: null });
      process.stderr.write(`[${i + 1}/${domains.length}] ${domain} ERROR: ${err.message}\n`);
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

main();
