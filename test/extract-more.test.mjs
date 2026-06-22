import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtMetric, metricScalar, extractContacts, extractRisks,
  extractFinancials, extractMetrics, extractNace, extractAddress,
  extractProfile, extractScores, extractSignalCounts, buildProfile,
} from '../lib/extract.mjs';

// --- fmtMetric: category + period branches (existing test only covers value shapes) ---

test('fmtMetric exposes the category block and validity period', () => {
  const out = fmtMetric({
    name: 'size',
    category: { code: 'B', name: 'Small', lowerBound: 10, upperBound: 50 },
    validFrom: '2023-01-01',
    validTo: '2023-12-31',
  });
  assert.equal(out.name, 'size');
  assert.deepEqual(out.category, { code: 'B', name: 'Small', lowerBound: 10, upperBound: 50 });
  assert.deepEqual(out.period, { from: '2023-01-01', to: '2023-12-31' });
  // no value/amount/count when value is absent
  assert.equal('amount' in out, false);
  assert.equal('count' in out, false);
  assert.equal('value' in out, false);
});

test('fmtMetric nulls missing category fields', () => {
  const out = fmtMetric({ name: 'x', category: {} });
  assert.deepEqual(out.category, { code: null, name: null, lowerBound: null, upperBound: null });
});

// --- metricScalar: a couple of extra shapes ---

test('metricScalar prefers amount over count and ignores currency-object bounds', () => {
  assert.equal(metricScalar({ value: { amount: 7, count: 99 } }), 7);
  assert.equal(metricScalar({ category: { lowerBound: 100, upperBound: 200 } }), 150);
  assert.equal(metricScalar({}), null);
});

// --- extractContacts: full set of channels ---

test('extractContacts surfaces every contact channel', () => {
  const data = { contacts: {
    phoneNumber: { value: '+420111' },
    email: { value: 'info@x.cz' },
    website: { value: 'https://x.cz' },
    linkedIn: { value: 'https://linkedin.com/company/x' },
    facebook: { value: 'https://facebook.com/x' },
    twitter: { value: 'https://twitter.com/x' },
  } };
  assert.deepEqual(extractContacts(data), {
    phone: '+420111',
    email: 'info@x.cz',
    website: 'https://x.cz',
    linkedIn: 'https://linkedin.com/company/x',
    facebook: 'https://facebook.com/x',
    twitter: 'https://twitter.com/x',
  });
});

test('extractContacts returns all-null for an empty company', () => {
  assert.deepEqual(extractContacts({}), {
    phone: null, email: null, website: null, linkedIn: null, facebook: null, twitter: null,
  });
});

// --- extractRisks: multiple signals, dates, riskCount from metrics ---

test('extractRisks maps multiple signals and uses metrics.riskCount when present', () => {
  const data = {
    risks: { current: [
      { name: 'Insolvency', code: 'INS', severity: 3, validFrom: '2024-01-01', validTo: null,
        sources: [{ name: 'ISIR' }, { name: 'Justice' }, { foo: 'x' }] },
      { name: 'Execution', code: 'EXE', severity: 1 },
    ] },
    metrics: { riskCount: { value: 5 } },
    basicInfo: { health: { name: 'Distressed' } },
  };
  const r = extractRisks(data);
  assert.equal(r.hasRisk, true);
  assert.equal(r.riskCount, 5); // from metrics, not signals.length (2)
  assert.equal(r.health, 'Distressed');
  assert.equal(r.signals.length, 2);
  assert.equal(r.signals[0].validFrom, '2024-01-01');
  assert.deepEqual(r.signals[0].sources, ['ISIR', 'Justice']); // unnamed source filtered out
  assert.equal(r.signals[1].severity, 1);
});

// --- extractFinancials: populated metrics ---

test('extractFinancials formats each headline metric', () => {
  const data = { metrics: {
    revenue: { name: 'revenue', value: { amount: 1000, currency: 'CZK' } },
    ebit: { name: 'ebit', value: { amount: 200, currency: 'CZK' } },
    isExporter: { name: 'isExporter', value: true },
  } };
  const f = extractFinancials(data);
  assert.deepEqual(f.revenue, { name: 'revenue', amount: 1000, currency: 'CZK' });
  assert.deepEqual(f.ebit, { name: 'ebit', amount: 200, currency: 'CZK' });
  assert.deepEqual(f.isExporter, { name: 'isExporter', value: true });
  assert.equal(f.ebitda, null); // absent metric → null
});

// --- extractMetrics: maps all metrics, skips _meta ---

test('extractMetrics normalizes every metric and drops _meta', () => {
  const data = { metrics: {
    revenue: { value: { amount: 100 } },
    employees: { value: { count: 5 } },
    _meta: { generatedAt: 'now' },
  } };
  const m = extractMetrics(data);
  assert.deepEqual(Object.keys(m).sort(), ['employees', 'revenue']);
  assert.equal(m.revenue.amount, 100);
  assert.equal(m.employees.count, 5);
  assert.equal('_meta' in m, false);
});

test('extractMetrics returns {} when there are no metrics', () => {
  assert.deepEqual(extractMetrics({}), {});
});

// --- extractNace: populated primary + other ---

test('extractNace returns primary and secondary activities', () => {
  const data = { nace: {
    primary: { code: '4791', name: 'Retail via internet' },
    other: [{ code: '4711', name: 'Retail in stores' }, { code: '5210', name: 'Warehousing' }],
  } };
  assert.deepEqual(extractNace(data), {
    primary: { code: '4791', name: 'Retail via internet' },
    other: [{ code: '4711', name: 'Retail in stores' }, { code: '5210', name: 'Warehousing' }],
  });
});

// --- extractAddress: null, full, and partial street ---

test('extractAddress returns null when no address present', () => {
  assert.equal(extractAddress({}), null);
});

test('extractAddress flattens a full address', () => {
  const data = { address: {
    text: 'Foo 1, 11000 Praha', streetName: 'Foo', streetNumber: '1',
    city: 'Praha', postalCode: '11000', coordinates: { lat: 50.1, lng: 14.4 },
  } };
  assert.deepEqual(extractAddress(data), {
    text: 'Foo 1, 11000 Praha', street: 'Foo 1', city: 'Praha',
    postalCode: '11000', coordinates: { lat: 50.1, lng: 14.4 },
  });
});

test('extractAddress handles a street name without a number', () => {
  const data = { address: { streetName: 'Náměstí Míru' } };
  assert.equal(extractAddress(data).street, 'Náměstí Míru');
  // no streetName at all → null street
  assert.equal(extractAddress({ address: { city: 'Brno' } }).street, null);
});

// --- extractProfile: legal identity / registration ---

test('extractProfile extracts identity, registration and databox', () => {
  const data = { basicInfo: {
    name: 'Alza.cz a.s.', nationalIn: '27082440', vatIn: 'CZ27082440', isVerifiedVatPayer: true,
    identifiers: { 'cz-databox': { value: 'box123' } },
    establishedAt: '1994-05-26', disestablishedAt: null,
    health: { name: 'Healthy' }, legalForm: { name: 'a.s.' },
    institutionalSector: { name: 'Private non-financial' },
    registration: { court: { name: 'Městský soud v Praze' }, fileNumber: 'B 8573', recordUrl: 'https://or.justice.cz/x' },
    logo: { url: 'https://logo' }, selfDescription: 'Largest e-shop',
  } };
  const p = extractProfile(data);
  assert.equal(p.name, 'Alza.cz a.s.');
  assert.equal(p.ico, '27082440');
  assert.equal(p.vatIn, 'CZ27082440');
  assert.equal(p.isVerifiedVatPayer, true);
  assert.equal(p.dataBox, 'box123');
  assert.equal(p.establishedAt, '1994-05-26');
  assert.equal(p.health, 'Healthy');
  assert.equal(p.legalForm, 'a.s.');
  assert.equal(p.institutionalSector, 'Private non-financial');
  assert.deepEqual(p.registration, {
    court: 'Městský soud v Praze', fileNumber: 'B 8573', recordUrl: 'https://or.justice.cz/x',
  });
  assert.equal(p.logo, 'https://logo');
  assert.equal(p.selfDescription, 'Largest e-shop');
});

test('extractProfile nulls everything for an empty company', () => {
  const p = extractProfile({});
  assert.equal(p.name, null);
  assert.equal(p.ico, null);
  assert.equal(p.dataBox, null);
  assert.equal(p.registration, null);
});

// --- extractScores: value vs timeline fallback ---

test('extractScores reads a direct value and falls back to the timeline head', () => {
  const data = { indicators: {
    activity: { value: 75 },
    growth: { timeline: [{ value: 60 }, { value: 40 }] },
    // reachability missing entirely
  } };
  assert.deepEqual(extractScores(data), { activity: 75, growth: 60, reachability: null });
});

test('extractScores returns all-null with no indicators', () => {
  assert.deepEqual(extractScores({}), { activity: null, growth: null, reachability: null });
});

// --- extractSignalCounts ---

test('extractSignalCounts pulls scalar counts from the metrics block', () => {
  const data = { metrics: {
    openJobCountCurrentTotal: { value: 8 },
    vehiclesOwnedTotal: { value: { count: 3 } },
    eshopCount: { value: 2 },
    locationCount: { category: { lowerBound: 1, upperBound: 5 } }, // → midpoint 3
  } };
  const s = extractSignalCounts(data);
  assert.equal(s.openJobs, 8);
  assert.equal(s.vehiclesOwned, 3);
  assert.equal(s.eshopCount, 2);
  assert.equal(s.locationCount, 3);
  assert.equal(s.connectedCompaniesCount, null); // absent → null
});

// --- buildProfile: fuller assembly across every sub-section ---

test('buildProfile wires identity, address, classification, size, contacts, risk and signals', () => {
  const data = {
    basicInfo: { name: 'Alza.cz a.s.', nationalIn: '27082440', legalForm: { name: 'a.s.' } },
    address: { streetName: 'Foo', streetNumber: '7', city: 'Praha', postalCode: '17000' },
    nace: { primary: { code: '4791', name: 'Internet retail' }, other: [] },
    metrics: {
      revenue: { name: 'revenue', value: { amount: 50000000000, currency: 'CZK' } },
      employees: { name: 'employees', value: { count: 3000 } },
      openJobCountCurrentTotal: { value: 12 },
      riskCount: { value: 0 },
    },
    indicators: { activity: { value: 90 } },
    contacts: { website: { value: 'https://alza.cz' } },
    risks: { current: [] },
  };
  const p = buildProfile('27082440', 'cz', data);
  assert.equal(p.ico, '27082440');
  assert.equal(p.country, 'cz');
  assert.equal(p.name, 'Alza.cz a.s.');
  assert.equal(p.identity.legalForm, 'a.s.');
  assert.equal(p.address.street, 'Foo 7');
  assert.equal(p.address.city, 'Praha');
  assert.equal(p.classification.primary.code, '4791');
  assert.equal(p.size.revenue.amount, 50000000000);
  assert.equal(p.size.employees.count, 3000);
  assert.equal(p.scores.activity, 90);
  assert.equal(p.contacts.website, 'https://alza.cz');
  assert.equal(p.risk.hasRisk, false);
  assert.equal(p.signals.openJobs, 12);
});
