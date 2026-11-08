import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
      const f = [...issuer.filings].reverse();
      return json({ name: `Issuer ${cik}`, sic: '3571', filings: { recent: { accessionNumber: f.map((x) => x.accession),
        form: f.map((x) => x.form), acceptanceDateTime: f.map((x) => x.acceptedAt), filingDate: f.map((x) => x.acceptedAt.slice(0, 10)),
        isXBRL: f.map((x) => (x.form === '4' ? 0 : 1)) } } });
    }
    if (issuer.noFacts) return { ok: false, status: 404, headers: new Map() };
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
  for (const key of ['latestFinancial', 'inFacts', 'size', 'mtimeMs', 'missingReports']) delete index['0000000001'][key];
  index['0000000001'].latestFiling = '2026-08-01T16:00:00.000Z';
  writeFileSync(indexPath, JSON.stringify(index));
  sec.calls.length = 0; await run(store, sec, ENTRIES());
  assert.equal(sec.factsCalls(), 0);
  const migrated = JSON.parse(readFileSync(indexPath, 'utf8'))['0000000001'];
  assert.equal(migrated.inFacts, true); assert.equal(migrated.latestFiling, undefined);
  assert.deepEqual(migrated.missingReports, []);
  // A file touched without changing its bytes is not downloaded again.
  utimesSync(join(store, '0000000001.json'), new Date(), new Date('2027-01-01'));
  sec.calls.length = 0; await run(store, sec, ENTRIES());
  assert.equal(sec.factsCalls(), 0);
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
  // Without --prune a partial manifest leaves other links alone, but a moved ticker moves.
  await run(store, sec, moved);
  assert.ok(existsSync(join(store, 'by-symbol', 'BBB.json')));
  assert.deepEqual(JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'))['0000000002'].symbols, ['BBB']);
  await run(store, sec, moved, { prune: true });
  assert.deepEqual(readdirSync(join(store, 'by-symbol')).sort(), ['AAA.json', 'BBC.json']);
  assert.equal(readlinkSync(join(store, 'by-symbol', 'BBC.json')), '../0000000001.json');
  const index = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'));
  assert.deepEqual(index['0000000001'].symbols, ['AAA', 'BBC']);
  assert.deepEqual(index['0000000002'].symbols, []);
  assert.ok(existsSync(join(store, '0000000002.json')));
  assert.throws(() => parseManifest([{ symbol: 'AAA', cik: 1 }, { symbol: 'AAA', cik: 2 }]), /maps to CIKs/);
}));

test('a report pending at download is fetched again on the next run, however late that run is', () => withStore(async (store) => {
  const sec = fakeSec();
  await run(store, sec, ENTRIES());
  sec.file('0000000001', 'a-10q-2', '10-Q', '2026-11-05T21:00:00.000Z');
  assert.deepEqual((await run(store, sec, ENTRIES(), { now: () => '2026-11-05T22:00:00.000Z' })).pending, ['0000000001']);
  sec.issuers['0000000001'].facts.push('a-10q-2');
  sec.calls.length = 0;
  assert.deepEqual((await run(store, sec, ENTRIES(), { now: () => '2026-12-10T00:00:00.000Z' })).fetched, ['0000000001']);
  assert.equal(sec.factsCalls(), 1);
}));

test('issuers without financial reports or without XBRL data are not downloaded every run', () => withStore(async (store) => {
  const sec = fakeSec();
  sec.issuers['0000000003'] = { filings: [{ accession: 'c-8k', form: '8-K', acceptedAt: '2026-10-01T00:00:00.000Z' }], facts: [] };
  sec.issuers['0000000004'] = { filings: [{ accession: 'd-10q', form: '10-Q', acceptedAt: '2026-10-01T00:00:00.000Z' }], facts: [], noFacts: true };
  const entries = parseManifest([{ symbol: 'CCC', cik: 3 }, { symbol: 'DDD', cik: 4 }]);
  const first = await run(store, sec, entries);
  assert.deepEqual(first.fetched, ['0000000003']); assert.deepEqual(first.noFacts, ['0000000004']);
  sec.calls.length = 0;
  const second = await run(store, sec, entries);
  assert.deepEqual(second.unchanged, ['0000000003']); assert.deepEqual(second.noFacts, ['0000000004']);
  assert.equal(sec.factsCalls(), 0);
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
  const result = await run(store, blocked, parseManifest([{ symbol: 'AAA', cik: 1 }, { symbol: 'BBB', cik: 2 }]), { prune: true });
  assert.match(result.stopped, /403/);
  assert.equal(blocked.calls.filter((u) => u.includes('0000000002')).length, 0);
  assert.ok(!existsSync(join(store, '.lock')));
  // A stopped run does not prune: BBC was never reached, so its link stays.
  assert.ok(existsSync(join(store, 'by-symbol', 'BBC.json')));
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
  // A transition-period report (fiscal year change) is a financial report.
  assert.equal(latestFinancialReport({ filings: { recent: { ...recent, form: ['10-Q', '8-K', '10-KT'], isXBRL: [1, 1, 1] } } }).accession, 'z');
  assert.equal(latestFinancialReport({}), null);
});
test('exhausted rate limiting stops the run; unreadable bodies and timeouts retry', () => withStore(async (store) => {
  const limited = fakeSec();
  limited.fetch = async () => ({ ok: false, status: 429, headers: new Map([['retry-after', '9999']]) });
  const slept = [];
  const stopped = await run(store, limited, ENTRIES(), { sleep: async (ms) => { slept.push(ms); } });
  assert.match(stopped.stopped, /rate limited/);
  assert.ok(Math.max(...slept) <= 120000);
  const sec = fakeSec();
  sec.responses.push(() => ({ ok: true, status: 200, headers: new Map(), json: async () => { throw new SyntaxError('truncated'); } }));
  assert.equal((await run(store, sec, ENTRIES())).fetched.length, 2);
  const hanging = { fetch: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) };
  const timedOut = await run(store, hanging, parseManifest([{ symbol: 'AAA', cik: 1 }]), { timeoutMs: 5 });
  assert.equal(timedOut.failed.length, 1);
}));

test('an unreadable lock is stale, and a second refresh in the same process is refused', () => withStore(async (store) => {
  const sec = fakeSec();
  writeFileSync(join(store, '.lock'), '');
  assert.equal((await run(store, sec, ENTRIES())).fetched.length, 2);
  let release; const gate = new Promise((r) => { release = r; });
  const slow = { fetch: async (url, opts) => { await gate; return sec.fetch(url, opts); } };
  const first = run(store, slow, ENTRIES());
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(run(store, sec, ENTRIES()), /already holds/);
  release(); await first;
}));
test('reports SEC has left out of Company Facts are listed as incomplete, apart from one still awaited', () => withStore(async (store) => {
  const sec = fakeSec();
  // An older 10-Q never absorbed, the newest one present: incomplete.
  sec.file('0000000001', 'a-10q-gap', '10-Q', '2026-09-01T16:00:00.000Z');
  sec.file('0000000001', 'a-10q-3', '10-Q', '2026-10-30T16:00:00.000Z');
  sec.issuers['0000000001'].facts.push('a-10q-3');
  // The newest report only just accepted: pending, not incomplete.
  sec.file('0000000002', 'b-10q', '10-Q', '2026-11-06T16:00:00.000Z');
  const result = await run(store, sec, ENTRIES());
  assert.deepEqual(result.incomplete.map((x) => [x.cik, x.missing.map((m) => m.accession)]), [['0000000001', ['a-10q-gap']]]);
  assert.deepEqual(result.pending, ['0000000002']);
  // A newest report still missing from a download more than 30 days after acceptance is a gap.
  const late = await run(store, sec, ENTRIES(), { now: () => '2026-12-10T00:00:00.000Z' });
  assert.deepEqual(late.incomplete.map((x) => x.cik), ['0000000001', '0000000002']);
  assert.deepEqual(late.pending, []);
}));

test('Company Facts that appears after a 404 is fetched within the waiting period; a 404 for a stored issuer fails', () => withStore(async (store) => {
  const sec = fakeSec();
  sec.issuers['0000000004'] = { filings: [{ accession: 'd-10q', form: '10-Q', acceptedAt: '2026-11-02T00:00:00.000Z' }], facts: ['d-10q'], noFacts: true };
  const entries = parseManifest([{ symbol: 'DDD', cik: 4 }]);
  assert.deepEqual((await run(store, sec, entries, { now: () => '2026-11-02T12:00:00.000Z' })).noFacts, ['0000000004']);
  sec.issuers['0000000004'].noFacts = false;
  assert.deepEqual((await run(store, sec, entries, { now: () => '2026-11-03T12:00:00.000Z' })).fetched, ['0000000004']);
  sec.issuers['0000000004'].noFacts = true;
  const before = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'))['0000000004'];
  sec.file('0000000004', 'd-10q-2', '10-Q', '2026-11-05T00:00:00.000Z');
  const failed = await run(store, sec, entries, { now: () => '2026-11-06T00:00:00.000Z' });
  assert.equal(failed.failed.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'))['0000000004'].sha256, before.sha256);
}));

test('a lock left by an earlier run with this pid is stale, and a failed issuer keeps the request pacing', () => withStore(async (store) => {
  const sec = fakeSec();
  writeFileSync(join(store, '.lock'), String(process.pid));
  assert.equal((await run(store, sec, ENTRIES())).failed.length, 0);
  const slept = [];
  const broken = { fetch: async () => ({ ok: false, status: 400, headers: new Map() }) };
  await run(store, broken, ENTRIES(), { sleep: async (ms) => { slept.push(ms); } });
  assert.equal(slept.filter((ms) => ms === 150).length, 2);
}));
test('entries indexed before gaps were tracked are checked once, and an unchanged file is not re-hashed', () => withStore(async (store) => {
  const sec = fakeSec();
  sec.file('0000000001', 'a-10q-gap', '10-Q', '2026-09-01T16:00:00.000Z');
  sec.file('0000000001', 'a-10q-3', '10-Q', '2026-10-30T16:00:00.000Z');
  sec.issuers['0000000001'].facts.push('a-10q-3');
  await run(store, sec, ENTRIES());
  const indexPath = join(store, 'index.json'); const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  delete index['0000000001'].missingReports;
  // Same size and modification time: the recorded hash is trusted without reading the file.
  index['0000000002'].sha256 = '0'.repeat(64);
  writeFileSync(indexPath, JSON.stringify(index));
  sec.calls.length = 0;
  const result = await run(store, sec, ENTRIES());
  assert.deepEqual(result.incomplete.map((x) => [x.cik, x.missing.map((m) => m.accession)]), [['0000000001', ['a-10q-gap']]]);
  assert.equal(sec.factsCalls(), 0);
}));
test('gaps are rechecked weekly, age out after 400 days, and exclude amendments', () => withStore(async (store) => {
  const sec = fakeSec();
  sec.file('0000000001', 'a-10q-gap', '10-Q', '2026-09-01T16:00:00.000Z');
  sec.file('0000000001', 'a-10ka', '10-K/A', '2026-09-15T16:00:00.000Z');
  sec.file('0000000001', 'a-10q-3', '10-Q', '2026-10-30T16:00:00.000Z');
  sec.issuers['0000000001'].facts.push('a-10q-3');
  const day = (d) => ({ now: () => d });
  assert.deepEqual((await run(store, sec, ENTRIES(), day('2026-11-07T00:00:00.000Z'))).incomplete.map((x) => x.missing.map((m) => m.accession)), [['a-10q-gap']]);
  // Within a week: no download. After a week: downloaded again, and the report SEC added is picked up.
  sec.issuers['0000000001'].facts.push('a-10q-gap');
  sec.calls.length = 0; await run(store, sec, ENTRIES(), day('2026-11-10T00:00:00.000Z'));
  assert.equal(sec.factsCalls(), 0);
  const later = await run(store, sec, ENTRIES(), day('2026-11-20T00:00:00.000Z'));
  assert.deepEqual(later.fetched, ['0000000001']); assert.deepEqual(later.incomplete, []);
  // A gap older than 400 days is no longer listed, without a download.
  sec.issuers['0000000001'].facts = sec.issuers['0000000001'].facts.filter((a) => a !== 'a-10q-gap');
  await run(store, sec, ENTRIES(), { force: true, ...day('2026-11-21T00:00:00.000Z') });
  sec.calls.length = 0;
  const aged = await run(store, sec, ENTRIES(), day('2027-10-10T00:00:00.000Z'));
  assert.deepEqual(aged.incomplete, []);
}));

test('a registrant with no financial report and no Company Facts is not retried or failed every run', () => withStore(async (store) => {
  const sec = fakeSec();
  sec.issuers['0000000005'] = { filings: [{ accession: 'e-8k', form: '8-K', acceptedAt: '2026-10-01T00:00:00.000Z' }], facts: [], noFacts: true };
  const entries = parseManifest([{ symbol: 'EEE', cik: 5 }]);
  assert.deepEqual((await run(store, sec, entries)).noFacts, ['0000000005']);
  sec.calls.length = 0;
  const second = await run(store, sec, entries);
  assert.deepEqual(second.failed, []); assert.deepEqual(second.noFacts, ['0000000005']);
  assert.equal(sec.factsCalls(), 0);
}));

