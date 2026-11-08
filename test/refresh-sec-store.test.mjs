import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestFinancialReport, main, parseArgs, parseManifest, refreshStore } from '../scripts/refresh-sec-store.mjs';

// A fake SEC: per CIK, its filings (submissions) and the accessions Company Facts has absorbed.
function fakeSec() {
  const filing = (accession, form, acceptedAt) => ({ accession, form, acceptedAt });
  const sec = { calls: [], responses: [], issuers: {
    '0000000001': { filings: [filing('a-10q-1', '10-Q', '2026-08-01T16:00:00.000Z')], facts: ['a-10q-1'] },
    '0000000002': { filings: [filing('b-10k-1', '10-K', '2026-02-01T16:00:00.000Z')], facts: ['b-10k-1'] },
  } };
  const json = (body) => ({ ok: true, status: 200, headers: new Map(), json: async () => body });
  sec.fetch = async (url, { headers, signal }) => {
    assert.match(headers['User-Agent'], /@/); assert.ok(signal);
    sec.calls.push(url);
    const queued = sec.responses.shift();
    if (queued) return queued();
    const cik = url.match(/CIK(\d{10})/)[1]; const issuer = sec.issuers[cik];
    if (!issuer) return { ok: false, status: 404, headers: new Map() };
    if (url.includes('/submissions/')) {
      const f = issuer.filings;
      return json({ name: `Issuer ${cik}`, sic: '3571', filings: { recent: { accessionNumber: f.map((x) => x.accession),
        form: f.map((x) => x.form), acceptanceDateTime: f.map((x) => x.acceptedAt), filingDate: f.map((x) => x.acceptedAt.slice(0, 10)),
        isXBRL: f.map((x) => (x.form === '4' ? 0 : 1)) } } });
    }
    return json({ cik: Number(cik), entityName: `Issuer ${cik}`, facts: { 'us-gaap': { Revenues: { units: { USD:
      issuer.facts.map((accn, i) => ({ accn, val: i, filed: '2026-01-01', start: '2025-01-01', end: '2025-12-31', form: '10-K' })) } } } } });
  };
  sec.file = (cik, accession, form, acceptedAt) => sec.issuers[cik].filings.push(filing(accession, form, acceptedAt));
  sec.factsCalls = () => sec.calls.filter((u) => u.includes('companyfacts')).length;
  return sec;
}
const withStore = async (fn) => { const store = mkdtempSync(join(tmpdir(), 'sec-store-')); try { await fn(store); } finally { rmSync(store, { recursive: true, force: true }); } };
const run = (store, sec, entries, extra = {}) => refreshStore({ store, entries, userAgent: 'Research contact@example.com',
  fetchImpl: sec.fetch, sleep: async () => {}, now: () => '2026-11-07T00:00:00.000Z', ...extra });
const ENTRIES = () => parseManifest([{ symbol: 'AAA', cik: 1 }, { symbol: 'BBB', cik: '2' }, { symbol: 'BBC', cik: 2 }]);

test('only a new financial report triggers a download, and only until Company Facts contains it', () => withStore(async (store) => {
  const sec = fakeSec();
  const first = await run(store, sec, ENTRIES());
  assert.deepEqual(first.fetched, ['0000000001', '0000000002']);
  assert.equal(JSON.parse(readFileSync(join(store, '0000000001.json'), 'utf8')).sic, '3571');
  assert.equal(readlinkSync(join(store, 'by-symbol', 'BBC.json')), '../0000000002.json');
  const index = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'));
  assert.deepEqual(index['0000000002'].symbols, ['BBB', 'BBC']);
  assert.equal(index['0000000001'].latestFinancial.accession, 'a-10q-1');

  // An 8-K and a Form 4 change nothing the model reads.
  sec.file('0000000001', 'a-8k', '8-K', '2026-09-01T16:00:00.000Z'); sec.file('0000000001', 'a-f4', '4', '2026-09-02T16:00:00.000Z');
  sec.calls.length = 0;
  assert.deepEqual((await run(store, sec, ENTRIES())).unchanged, ['0000000001', '0000000002']);
  assert.equal(sec.factsCalls(), 0);

  // A 10-Q accepted before Company Facts absorbs it stays pending and is fetched again next run.
  sec.file('0000000001', 'a-10q-2', '10-Q', '2026-11-05T16:00:00.000Z');
  assert.deepEqual((await run(store, sec, ENTRIES())).pending, ['0000000001']);
  sec.calls.length = 0;
  assert.deepEqual((await run(store, sec, ENTRIES())).pending, ['0000000001']);
  assert.equal(sec.factsCalls(), 1);
  sec.issuers['0000000001'].facts.push('a-10q-2');
  assert.deepEqual((await run(store, sec, ENTRIES())).fetched, ['0000000001']);
  sec.calls.length = 0;
  await run(store, sec, ENTRIES());
  assert.equal(sec.factsCalls(), 0);

  // A report that never reaches Company Facts settles after 30 days instead of downloading forever.
  sec.file('0000000002', 'b-10ka', '10-K/A', '2026-09-01T16:00:00.000Z');
  assert.deepEqual((await run(store, sec, ENTRIES())).fetched, ['0000000002']);
  sec.calls.length = 0; await run(store, sec, ENTRIES());
  assert.equal(sec.factsCalls(), 0);

  assert.equal((await run(store, sec, ENTRIES(), { force: true })).fetched.length, 2);
}));

test('a stored file that already holds the newest report is not downloaded again, and a changed file is', () => withStore(async (store) => {
  const sec = fakeSec();
  await run(store, sec, ENTRIES());
  // An index entry from before reports were tracked: the stored file is checked instead.
  const indexPath = join(store, 'index.json'); const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  delete index['0000000001'].latestFinancial; delete index['0000000001'].inFacts;
  writeFileSync(indexPath, JSON.stringify(index));
  sec.calls.length = 0; await run(store, sec, ENTRIES());
  assert.equal(sec.factsCalls(), 0);
  assert.equal(JSON.parse(readFileSync(indexPath, 'utf8'))['0000000001'].inFacts, true);
  writeFileSync(join(store, '0000000002.json'), '{}');
  sec.calls.length = 0; await run(store, sec, ENTRIES());
  assert.equal(sec.factsCalls(), 1);
  rmSync(join(store, '0000000001.json'));
  sec.calls.length = 0; await run(store, sec, ENTRIES());
  assert.equal(sec.factsCalls(), 1);
}));

test('links follow the manifest: removed and reassigned tickers are cleaned up', () => withStore(async (store) => {
  const sec = fakeSec();
  await run(store, sec, ENTRIES());
  const moved = parseManifest([{ symbol: 'AAA', cik: 1 }, { symbol: 'BBC', cik: 1 }]);
  await run(store, sec, moved);
  assert.deepEqual(readdirSync(join(store, 'by-symbol')).sort(), ['AAA.json', 'BBC.json']);
  assert.equal(readlinkSync(join(store, 'by-symbol', 'BBC.json')), '../0000000001.json');
  const index = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'));
  assert.deepEqual(index['0000000001'].symbols, ['AAA', 'BBC']);
  assert.deepEqual(index['0000000002'].symbols, []);
  assert.ok(existsSync(join(store, '0000000002.json')));
  assert.throws(() => parseManifest([{ symbol: 'AAA', cik: 1 }, { symbol: 'AAA', cik: 2 }]), /maps to CIKs/);
}));

test('SEC 403 stops the run with progress saved; transient errors retry and honor Retry-After', () => withStore(async (store) => {
  const sec = fakeSec(); const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  sec.responses.push(async () => { throw new Error('ECONNRESET'); },
    () => ({ ok: false, status: 429, headers: new Map([['retry-after', '7']]) }));
  assert.deepEqual((await run(store, sec, ENTRIES(), { sleep })).fetched, ['0000000001', '0000000002']);
  assert.ok(slept.includes(7000));

  // Issuer 1 has a new report, absorbed; issuer 2 is then refused. Issuer 1's progress is saved.
  const blocked = fakeSec(); blocked.file('0000000001', 'a-10q-2', '10-Q', '2026-11-01T16:00:00.000Z');
  blocked.issuers['0000000001'].facts.push('a-10q-2');
  let n = 0; const inner = blocked.fetch;
  blocked.fetch = async (url, opts) => (url.includes('0000000002') && ++n === 1 ? { ok: false, status: 403, headers: new Map() } : inner(url, opts));
  const result = await run(store, blocked, ENTRIES());
  assert.match(result.stopped, /403/);
  assert.equal(blocked.calls.filter((u) => u.includes('0000000002')).length, 0);
  assert.ok(!existsSync(join(store, '.lock')));
  assert.equal(JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'))['0000000001'].latestFinancial.accession, 'a-10q-2');
}));

test('a concurrent refresh is refused, a stale lock is taken over, and a contact address is required', () => withStore(async (store) => {
  const sec = fakeSec();
  writeFileSync(join(store, '.lock'), String(process.ppid));
  await assert.rejects(run(store, sec, ENTRIES()), /holds/);
  writeFileSync(join(store, '.lock'), '999999999');
  assert.equal((await run(store, sec, ENTRIES())).fetched.length, 2);
  await assert.rejects(run(store, sec, ENTRIES(), { userAgent: 'contact@example.com' }));
}));

test('arguments need values, and missing issuers fail the run', async () => {
  assert.throws(() => parseArgs(['--store', '--manifest', 'm.json']), /needs a value/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown/);
  assert.deepEqual(parseArgs(['--store', 's', '--manifest', 'm', '--force']), { store: 's', manifest: 'm', force: true });
  await withStore(async (store) => {
    const manifest = join(store, 'm.json');
    writeFileSync(manifest, JSON.stringify([{ symbol: 'GONE', cik: 3 }]));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, headers: new Map() });
    try { assert.equal(await main(['--store', join(store, 's'), '--manifest', manifest], { SEC_USER_AGENT: 'Research contact@example.com' }), 1); }
    finally { globalThis.fetch = realFetch; }
  });
});

test('the newest financial report ignores filings without XBRL statements', () => {
  const recent = { accessionNumber: ['x', 'y', 'z'], form: ['10-Q', '8-K', '10-K/A'],
    acceptanceDateTime: ['2026-05-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'], isXBRL: [1, 1, 0] };
  assert.equal(latestFinancialReport({ filings: { recent } }).accession, 'x');
  assert.equal(latestFinancialReport({}), null);
});
