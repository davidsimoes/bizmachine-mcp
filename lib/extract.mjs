/**
 * Pure data-shaping helpers for BizMachine company data.
 *
 * No I/O — these functions take raw API payloads (or query strings) and return
 * normalized, AI-friendly structures. Kept separate from index.mjs (MCP wiring)
 * and lib/api.mjs (network) so they can be unit-tested without an API key.
 */

// NACE section letter → numeric code mapping
export const NACE_SECTIONS = {
  A: '01', B: '05', C: '10', D: '35', E: '36', F: '41', G: '45',
  H: '49', I: '55', J: '58', K: '64', L: '68', M: '69', N: '77',
  O: '84', P: '85', Q: '86', R: '90', S: '94',
};

// Legal suffixes to strip for name matching
export const LEGAL_SUFFIXES = [
  'spol. s r.o.', 'spol. s r. o.', 's.r.o.', 's. r. o.',
  'a.s.', 'a. s.', 'v.o.s.', 'v. o. s.', 'k.s.', 'k. s.', 'se',
];

/**
 * Detect if input is a domain (contains dot, no spaces).
 */
export function isDomain(input) {
  return input.includes('.') && !input.includes(' ');
}

/**
 * Extract domain from a URL or domain string.
 * "https://www.alza.cz/foo" → "alza.cz"
 */
export function extractDomain(urlOrDomain) {
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
export function domainNamePart(domain) {
  const dot = domain.indexOf('.');
  return dot > 0 ? domain.slice(0, dot) : domain;
}

/**
 * Normalize a name for matching: strip legal suffixes, remove diacritics, lowercase.
 */
export function normalizeName(name) {
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
export function extractRevenue(companyData) {
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
export function extractEmployees(companyData) {
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
export function normalizeNace(code) {
  if (!code) return null;
  const s = String(code).trim().toUpperCase();
  if (s.length === 1 && NACE_SECTIONS[s]) return NACE_SECTIONS[s];
  return s;
}

/**
 * Find the best matching suggestion for a domain query.
 * Priority: domain match > name match > first result.
 */
export function findBestMatch(suggestions, inputDomain) {
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
export function agg(companyData) {
  return companyData?.data || companyData || {};
}

/**
 * Normalize a single metric into a flat shape.
 * Metrics come as { value, category, name, type, validFrom, validTo } where
 * `value` may be { amount, currency }, { count }, a number, or a boolean.
 */
export function fmtMetric(m) {
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
export function metricScalar(m) {
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
export function extractContacts(companyData) {
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
export function extractRisks(companyData) {
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
export function extractFinancials(companyData) {
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
export function extractMetrics(companyData) {
  const m = agg(companyData).metrics || {};
  const out = {};
  for (const key of Object.keys(m)) {
    if (key === '_meta') continue;
    out[key] = fmtMetric(m[key]);
  }
  return out;
}

/** NACE classification: primary + secondary activities. */
export function extractNace(companyData) {
  const n = agg(companyData).nace || {};
  return {
    primary: n.primary ? { code: n.primary.code, name: n.primary.name } : null,
    other: (n.other || []).map(x => ({ code: x.code, name: x.name })),
  };
}

/** Address, normalized to a flat shape. */
export function extractAddress(companyData) {
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
export function extractProfile(companyData) {
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
export function extractScores(companyData) {
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
export function extractSignalCounts(companyData) {
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
export function buildProfile(ico, country, companyData) {
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
