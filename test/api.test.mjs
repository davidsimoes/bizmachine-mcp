import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { suggest, getCompany, getIndicators, getOwnedCompanies } from '../lib/api.mjs';

// HARD SAFETY: every test stubs globalThis.fetch so a real call to api.bizmachine.com is
// structurally impossible. We also use a DUMMY api key only — never the real env var.

const ORIG_KEY = process.env.BIZMACHINE_API_KEY;

beforeEach(() => {
  process.env.BIZMACHINE_API_KEY = 'test-key';
  // Default guard: any unstubbed fetch throws loudly instead of hitting the network.
  mock.method(globalThis, 'fetch', async () => {
    throw new Error('UNMOCKED FETCH — real network call blocked');
  });
});

afterEach(() => {
  mock.restoreAll();
  if (ORIG_KEY === undefined) delete process.env.BIZMACHINE_API_KEY;
  else process.env.BIZMACHINE_API_KEY = ORIG_KEY;
});

/** Minimal fake Response — only the bits the client touches. */
function fakeResponse({ ok = true, status = 200, json = {}, text = '' } = {}) {
  return { ok, status, json: async () => json, text: async () => text };
}

/** Replace fetch with a recording stub returning `resp`; returns the mock for assertions. */
function stubFetch(resp) {
  return mock.method(globalThis, 'fetch', async () => resp);
}

// --- getApiKey via the x-api-key header ---

test('requests carry the BIZMACHINE_API_KEY as the x-api-key header', async () => {
  const f = stubFetch(fakeResponse({ json: { data: [] } }));
  await suggest('x', 'cz');
  const [, opts] = f.mock.calls[0].arguments;
  assert.equal(opts.headers['x-api-key'], 'test-key');
});

test('a missing BIZMACHINE_API_KEY throws before any fetch', async () => {
  delete process.env.BIZMACHINE_API_KEY;
  await assert.rejects(() => suggest('x', 'cz'), /BIZMACHINE_API_KEY environment variable is required/);
});

// --- suggest ---

test('suggest builds the cz v4 URL with an encoded query and unwraps json.data', async () => {
  const f = stubFetch(fakeResponse({ json: { data: [{ name: 'Alza', nationalIn: '27082440' }] } }));
  const r = await suggest('Alza CZ', 'cz');
  assert.deepEqual(r, [{ name: 'Alza', nationalIn: '27082440' }]);
  const [url] = f.mock.calls[0].arguments;
  assert.equal(url, 'https://api.bizmachine.com/cz/v4/companies/suggest?query=Alza%20CZ');
});

test('suggest targets the sk database when country=sk', async () => {
  const f = stubFetch(fakeResponse({ json: { data: [] } }));
  await suggest('Foo', 'sk');
  const [url] = f.mock.calls[0].arguments;
  assert.match(url, /^https:\/\/api\.bizmachine\.com\/sk\/v4\/companies\/suggest\?query=Foo$/);
});

test('suggest returns [] on a 204 No Content', async () => {
  stubFetch(fakeResponse({ status: 204, json: null }));
  assert.deepEqual(await suggest('nobody', 'cz'), []);
});

test('suggest returns [] when the payload is not an array', async () => {
  stubFetch(fakeResponse({ json: { notData: true } }));
  assert.deepEqual(await suggest('x', 'cz'), []);
});

test('suggest throws on a non-ok response, including the status and body', async () => {
  stubFetch(fakeResponse({ ok: false, status: 500, text: 'server boom' }));
  await assert.rejects(() => suggest('x', 'cz'), /BizMachine suggest 500: server boom/);
});

test('suggest throws on an application-level json.error', async () => {
  stubFetch(fakeResponse({ json: { error: 'rate limited' } }));
  await assert.rejects(() => suggest('x', 'cz'), /BizMachine suggest error: rate limited/);
});

// --- getCompany ---

test('getCompany builds the cz v4 aggregated-data URL and unwraps json.data', async () => {
  const f = stubFetch(fakeResponse({ json: { data: { basicInfo: { name: 'Alza' } } } }));
  const r = await getCompany('27082440', 'cz');
  assert.deepEqual(r, { basicInfo: { name: 'Alza' } });
  const [url, opts] = f.mock.calls[0].arguments;
  assert.equal(url, 'https://api.bizmachine.com/cz/v4/companies/27082440/aggregated-data');
  assert.equal(opts.headers['x-api-key'], 'test-key');
});

test('getCompany returns a flat payload when there is no .data wrapper', async () => {
  stubFetch(fakeResponse({ json: { basicInfo: { name: 'Flat' } } }));
  assert.deepEqual(await getCompany('123', 'cz'), { basicInfo: { name: 'Flat' } });
});

test('getCompany returns null on a 204 (company not found)', async () => {
  stubFetch(fakeResponse({ status: 204, json: null }));
  assert.equal(await getCompany('000', 'cz'), null);
});

test('getCompany throws on a non-ok response', async () => {
  stubFetch(fakeResponse({ ok: false, status: 404, text: 'nope' }));
  await assert.rejects(() => getCompany('123', 'cz'), /BizMachine company 404: nope/);
});

test('getCompany throws on a json.error payload', async () => {
  stubFetch(fakeResponse({ json: { error: 'bad ico' } }));
  await assert.rejects(() => getCompany('123', 'cz'), /BizMachine company error/);
});

// --- getIndicators (apiGet, v3 base) ---

test('getIndicators hits the v3 indicators endpoint and unwraps the data', async () => {
  const f = stubFetch(fakeResponse({ json: { data: { activity: 80 } } }));
  const r = await getIndicators('27082440', 'cz');
  assert.deepEqual(r, { activity: 80 });
  const [url, opts] = f.mock.calls[0].arguments;
  assert.equal(url, 'https://api.bizmachine.com/cz/v3/companies/27082440/indicators');
  assert.equal(opts.headers['x-api-key'], 'test-key');
});

test('getIndicators returns null on a 204', async () => {
  stubFetch(fakeResponse({ status: 204, json: null }));
  assert.equal(await getIndicators('123', 'cz'), null);
});

test('getIndicators adds the higher-plan hint on a 403', async () => {
  stubFetch(fakeResponse({ ok: false, status: 403, text: 'forbidden' }));
  await assert.rejects(() => getIndicators('123', 'cz'), /403.*higher BizMachine API plan/);
});

test('getIndicators omits the plan hint on a non-403 error', async () => {
  stubFetch(fakeResponse({ ok: false, status: 500, text: 'boom' }));
  await assert.rejects(() => getIndicators('123', 'cz'), (err) => {
    assert.match(err.message, /BizMachine indicators 500/);
    assert.doesNotMatch(err.message, /higher BizMachine API plan/);
    return true;
  });
});

test('getIndicators throws on a json.error payload', async () => {
  stubFetch(fakeResponse({ json: { error: { code: 'X' } } }));
  await assert.rejects(() => getIndicators('123', 'cz'), /BizMachine indicators error/);
});

// --- getOwnedCompanies (apiGet, v3 base) ---

test('getOwnedCompanies hits the v3 owned-companies endpoint (sk database)', async () => {
  const f = stubFetch(fakeResponse({ json: { data: [{ name: 'Sub s.r.o.' }] } }));
  const r = await getOwnedCompanies('12345678', 'sk');
  assert.deepEqual(r, [{ name: 'Sub s.r.o.' }]);
  const [url] = f.mock.calls[0].arguments;
  assert.equal(url, 'https://api.bizmachine.com/sk/v3/companies/12345678/owned-companies');
});
