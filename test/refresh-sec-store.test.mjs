import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestFiling, parseManifest, refreshStore } from '../scripts/refresh-sec-store.mjs';

function fakeSec() {
  const state = { filings: { '0000000001': ['2026-11-01T16:00:00.000Z'], '0000000002': ['2026-10-01T16:00:00.000Z'] }, calls: [], flaky: 0 };
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  state.fetch = async (url, { headers }) => {
    assert.match(headers['User-Agent'], /@/);
    state.calls.push(url);
    if (state.flaky > 0) { state.flaky--; return { ok: false, status: 429 }; }
    const cik = url.match(/CIK(\d{10})/)[1];
    if (!state.filings[cik]) return { ok: false, status: 404 };
    if (url.includes('/submissions/')) return json({ name: `Issuer ${cik}`, sic: '3571', filings: { recent: { acceptanceDateTime: state.filings[cik] } } });
    return json({ cik: Number(cik), entityName: `Issuer ${cik}`, facts: { 'us-gaap': {} } });
  };
  return state;
}
const run = (store, sec, entries, extra = {}) => refreshStore({ store, entries, userAgent: 'Research contact@example.com',
  fetchImpl: sec.fetch, sleep: async () => {}, now: () => '2026-11-07T00:00:00.000Z', ...extra });

test('the store re-downloads Company Facts only for issuers that filed since the last fetch', async () => {
  const store = mkdtempSync(join(tmpdir(), 'sec-store-'));
  try {
    const sec = fakeSec();
    const entries = parseManifest([{ symbol: 'AAA', cik: 1 }, { symbol: 'BBB', cik: '2' }, { symbol: 'BBC', cik: 2 }, { symbol: 'GONE', cik: 3 }]);
    const first = await run(store, sec, entries);
    assert.deepEqual(first.fetched, ['0000000001', '0000000002']);
    assert.deepEqual(first.missing, ['0000000003']);
    const stored = JSON.parse(readFileSync(join(store, '0000000001.json'), 'utf8'));
    assert.equal(stored.sic, '3571');
    assert.equal(readlinkSync(join(store, 'by-symbol', 'BBC.json')), '../0000000002.json');
    const index = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'));
    assert.deepEqual(index['0000000002'].symbols, ['BBB', 'BBC']);
    assert.match(index['0000000001'].sha256, /^[0-9a-f]{64}$/);

    sec.calls.length = 0;
    sec.filings['0000000002'].push('2026-11-06T21:00:00.000Z');
    const second = await run(store, sec, entries);
    assert.deepEqual(second.fetched, ['0000000002']);
    assert.deepEqual(second.unchanged, ['0000000001']);
    assert.equal(sec.calls.filter((u) => u.includes('companyfacts')).length, 1);
    assert.equal(JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'))['0000000002'].latestFiling, '2026-11-06T21:00:00.000Z');

    const forced = await run(store, sec, entries, { force: true });
    assert.equal(forced.fetched.length, 2);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('rate limiting is retried, other failures are reported per issuer, and a contact address is required', async () => {
  const store = mkdtempSync(join(tmpdir(), 'sec-store-'));
  try {
    const sec = fakeSec(); sec.flaky = 2;
    const entries = parseManifest([{ symbol: 'AAA', cik: 1 }]);
    assert.deepEqual((await run(store, sec, entries)).fetched, ['0000000001']);
    const broken = { fetch: async () => ({ ok: false, status: 403 }) };
    const result = await run(store, broken, parseManifest([{ symbol: 'BBB', cik: 2 }]));
    assert.equal(result.failed.length, 1); assert.match(result.failed[0].error, /403/);
    await assert.rejects(run(store, sec, entries, { userAgent: 'no contact' }));
    assert.throws(() => parseManifest([{ symbol: 'bad', cik: 1 }]));
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('the latest filing prefers acceptance time and falls back to filing date', () => {
  assert.equal(latestFiling({ filings: { recent: { acceptanceDateTime: ['2026-01-02T00:00:00.000Z', '2026-03-04T00:00:00.000Z'], filingDate: ['2026-01-02'] } } }), '2026-03-04T00:00:00.000Z');
  assert.equal(latestFiling({ filings: { recent: { filingDate: ['2026-01-02', '2025-12-01'] } } }), '2026-01-02');
  assert.equal(latestFiling({}), null);
});
