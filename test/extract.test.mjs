import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDomain, extractDomain, domainNamePart, normalizeName, normalizeNace,
  extractRevenue, extractEmployees, findBestMatch,
  agg, fmtMetric, metricScalar, extractContacts, extractRisks,
  extractFinancials, extractNace, buildProfile,
} from '../lib/extract.mjs';

// --- domain helpers ---

test('isDomain distinguishes domains from names', () => {
  assert.equal(isDomain('alza.cz'), true);
  assert.equal(isDomain('mixit.cz'), true);
  assert.equal(isDomain('Alza CZ a.s.'), false); // has space
  assert.equal(isDomain('Košík'), false);         // no dot
});

test('extractDomain strips scheme, path and www', () => {
  assert.equal(extractDomain('https://www.alza.cz/foo/bar'), 'alza.cz');
  assert.equal(extractDomain('alza.cz'), 'alza.cz');
  assert.equal(extractDomain('http://rohlik.cz'), 'rohlik.cz');
  assert.equal(extractDomain(''), null);
  assert.equal(extractDomain(null), null);
});

test('domainNamePart returns the label before the first dot', () => {
  assert.equal(domainNamePart('alza.cz'), 'alza');
  assert.equal(domainNamePart('shop.example.com'), 'shop');
  assert.equal(domainNamePart('noextension'), 'noextension');
});

// --- name normalization ---

test('normalizeName strips Czech legal suffixes', () => {
  assert.equal(normalizeName('Alza.cz a.s.'), 'alza.cz');
  assert.equal(normalizeName('MIXIT s.r.o.'), 'mixit');
  assert.equal(normalizeName('Foo, spol. s r.o.'), 'foo');
});

test('normalizeName removes diacritics and lowercases', () => {
  assert.equal(normalizeName('Košík'), 'kosik');
  assert.equal(normalizeName('Dědoles'), 'dedoles');
});

test('normalizeName handles empty/null input', () => {
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
});

// --- NACE ---

test('normalizeNace maps section letters to numeric codes', () => {
  assert.equal(normalizeNace('G'), '45');
  assert.equal(normalizeNace('c'), '10'); // case-insensitive
  assert.equal(normalizeNace('4791'), '4791'); // already numeric
  assert.equal(normalizeNace(null), null);
});

// --- revenue extraction (documented dual exact/range format) ---

test('extractRevenue reads an exact value', () => {
  const data = { metrics: { revenue: { value: { amount: 1000000, currency: 'CZK' } } } };
  assert.deepEqual(extractRevenue(data), { amount: 1000000, type: 'exact', currency: 'CZK' });
});

test('extractRevenue computes the midpoint of a range', () => {
  const data = {
    metrics: {
      revenue: {
        category: {
          lowerBound: { amount: 1000000, currency: 'CZK' },
          upperBound: { amount: 3000000, currency: 'CZK' },
        },
      },
    },
  };
  assert.deepEqual(extractRevenue(data), { amount: 2000000, type: 'estimated', currency: 'CZK' });
});

test('extractRevenue defaults currency to CZK', () => {
  const data = { metrics: { revenue: { value: { amount: 500 } } } };
  assert.equal(extractRevenue(data).currency, 'CZK');
});

test('extractRevenue returns nulls when absent', () => {
  assert.deepEqual(extractRevenue({}), { amount: null, type: null, currency: null });
  assert.deepEqual(extractRevenue(null), { amount: null, type: null, currency: null });
});

test('extractRevenue reads metrics nested under .data', () => {
  const data = { data: { metrics: { revenue: { value: { amount: 42 } } } } };
  assert.equal(extractRevenue(data).amount, 42);
});

// --- employees extraction ---

test('extractEmployees reads exact count, plain number, and range', () => {
  assert.deepEqual(
    extractEmployees({ metrics: { employees: { value: { count: 50 } } } }),
    { count: 50, type: 'exact' },
  );
  assert.deepEqual(
    extractEmployees({ metrics: { employees: { value: 12 } } }),
    { count: 12, type: 'exact' },
  );
  assert.deepEqual(
    extractEmployees({ metrics: { employees: { category: { lowerBound: 10, upperBound: 20 } } } }),
    { count: 15, type: 'estimated' },
  );
  assert.deepEqual(extractEmployees({}), { count: null, type: null });
});

// --- best-match selection (the nationalIn lesson lives downstream of this) ---

test('findBestMatch prefers an exact domain match', () => {
  const suggestions = [
    { name: 'Other Co', website: 'other.cz', nationalIn: '111' },
    { name: 'Alza', contacts: { website: { url: 'https://www.alza.cz' } }, nationalIn: '27082440' },
  ];
  const r = findBestMatch(suggestions, 'alza.cz');
  assert.equal(r.matchType, 'domain');
  assert.equal(r.match.nationalIn, '27082440');
});

test('findBestMatch falls back to a name match', () => {
  const suggestions = [{ name: 'Mixit s.r.o.', website: 'somethingelse.cz', nationalIn: '999' }];
  const r = findBestMatch(suggestions, 'mixit.cz');
  assert.equal(r.matchType, 'name');
  assert.equal(r.match.nationalIn, '999');
});

test('findBestMatch falls back to the first result, and returns null when empty', () => {
  const suggestions = [{ name: 'Zzz', website: 'zzz.cz', nationalIn: '1' }];
  assert.equal(findBestMatch(suggestions, 'unrelated.cz').matchType, 'first');
  assert.equal(findBestMatch([], 'alza.cz'), null);
});

// --- agg() unwrapping (the response-wrapping lesson) ---

test('agg unwraps a .data root but passes a flat object through', () => {
  assert.deepEqual(agg({ data: { x: 1 } }), { x: 1 });
  assert.deepEqual(agg({ x: 1 }), { x: 1 });
  assert.deepEqual(agg(null), {});
});

// --- metric formatting ---

test('fmtMetric flattens amount/count/value shapes', () => {
  assert.deepEqual(fmtMetric({ name: 'rev', value: { amount: 100, currency: 'EUR' } }),
    { name: 'rev', amount: 100, currency: 'EUR' });
  assert.deepEqual(fmtMetric({ name: 'emp', value: { count: 7 } }),
    { name: 'emp', count: 7 });
  assert.deepEqual(fmtMetric({ name: 'flag', value: true }),
    { name: 'flag', value: true });
  assert.equal(fmtMetric(null), null);
});

test('metricScalar pulls a single number out of any metric shape', () => {
  assert.equal(metricScalar({ value: { amount: 100 } }), 100);
  assert.equal(metricScalar({ value: { count: 5 } }), 5);
  assert.equal(metricScalar({ value: 9 }), 9);
  assert.equal(metricScalar({ category: { lowerBound: 10, upperBound: 30 } }), 20);
  // currency bounds are objects, not numbers → not averaged
  assert.equal(metricScalar({ category: { lowerBound: { amount: 1 }, upperBound: { amount: 2 } } }), null);
  assert.equal(metricScalar(null), null);
});

// --- section extractors ---

test('extractContacts flattens the contact block', () => {
  const data = { contacts: {
    phoneNumber: { value: '+420123' },
    email: { value: 'a@b.cz' },
    linkedIn: { value: 'https://linkedin.com/company/x' },
  } };
  const c = extractContacts(data);
  assert.equal(c.phone, '+420123');
  assert.equal(c.email, 'a@b.cz');
  assert.equal(c.linkedIn, 'https://linkedin.com/company/x');
  assert.equal(c.twitter, null);
});

test('extractRisks summarizes signals and health', () => {
  const data = {
    risks: { current: [{ name: 'Insolvency', code: 'INS', severity: 3, sources: [{ name: 'ISIR' }] }] },
    basicInfo: { health: { name: 'At risk' } },
  };
  const r = extractRisks(data);
  assert.equal(r.hasRisk, true);
  assert.equal(r.riskCount, 1);
  assert.equal(r.health, 'At risk');
  assert.deepEqual(r.signals[0].sources, ['ISIR']);
});

test('extractRisks reports no risk for a clean company', () => {
  const r = extractRisks({});
  assert.equal(r.hasRisk, false);
  assert.equal(r.riskCount, 0);
  assert.deepEqual(r.signals, []);
});

test('extractFinancials and extractNace tolerate empty input', () => {
  assert.equal(extractFinancials({}).revenue, null);
  assert.deepEqual(extractNace({}), { primary: null, other: [] });
});

// --- buildProfile smoke test ---

test('buildProfile assembles a connector-style profile', () => {
  const data = {
    basicInfo: { name: 'Alza.cz a.s.', nationalIn: '27082440', legalForm: { name: 'a.s.' } },
    metrics: { revenue: { value: { amount: 50000000000, currency: 'CZK' } } },
    nace: { primary: { code: '4791', name: 'Retail via mail order/internet' } },
  };
  const p = buildProfile('27082440', 'cz', data);
  assert.equal(p.ico, '27082440');
  assert.equal(p.country, 'cz');
  assert.equal(p.name, 'Alza.cz a.s.');
  assert.equal(p.identity.legalForm, 'a.s.');
  assert.equal(p.size.revenue.amount, 50000000000);
  assert.equal(p.classification.primary.code, '4791');
});
