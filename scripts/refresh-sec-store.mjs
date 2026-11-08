// Keeps one local copy of SEC Company Facts per issuer and re-downloads an issuer only when it has
// filed since the last fetch. Company Facts carries every filed value with its filing date, and the
// adapter filters by that date, so the latest copy reproduces any earlier cutoff; dated copies of
// the whole store are not needed. Evaluation reports record each input's SHA-256.
//
// Layout of the store directory:
//   <CIK>.json            Company Facts enriched with `sic` (the input compare-history reads)
//   by-symbol/<SYM>.json  symbolic links to the CIK files (the input evaluate-forward-valuation reads)
//   index.json            per CIK: symbol, latest filing seen, fetch time, SHA-256 of the stored file
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEC = 'https://data.sec.gov';
const pad = (cik) => String(cik).padStart(10, '0');

export function parseManifest(rows) {
  if (!Array.isArray(rows)) throw new Error('Manifest must be a JSON array of { symbol, cik }');
  const out = new Map();
  for (const r of rows) {
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(r?.symbol || '') || !/^\d{1,10}$/.test(String(r?.cik ?? ''))) throw new Error(`Invalid symbol or CIK: ${JSON.stringify(r)}`);
    const cik = pad(r.cik);
    if (!out.has(cik)) out.set(cik, { cik, symbols: [] });
    out.get(cik).symbols.push(r.symbol);
  }
  return [...out.values()];
}

// The newest filing on the issuer's submissions record: acceptance time where SEC gives one.
export function latestFiling(submissions) {
  const recent = submissions?.filings?.recent || {};
  const stamps = (recent.acceptanceDateTime?.length ? recent.acceptanceDateTime : recent.filingDate) || [];
  return stamps.filter(Boolean).sort().at(-1) ?? null;
}

async function getJson(fetchImpl, url, userAgent, sleep, attempts = 5) {
  for (let i = 0; ; i++) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (i + 1 >= attempts || ![429, 500, 502, 503, 504].includes(res.status)) throw new Error(`${url}: HTTP ${res.status}`);
    await sleep(1000 * 2 ** i);
  }
}

// SEC asks automated clients to stay under ten requests a second.
export async function refreshStore({ store, entries, userAgent, force = false, fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date().toISOString(), pauseMs = 150, log = () => {} }) {
  if (!/\S+@\S+/.test(userAgent || '')) throw new Error('SEC requires a User-Agent with a contact address');
  mkdirSync(join(store, 'by-symbol'), { recursive: true });
  const indexPath = join(store, 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {};
  const summary = { fetched: [], unchanged: [], missing: [], failed: [] };
  const save = () => { writeFileSync(`${indexPath}.tmp`, JSON.stringify(index, null, 2) + '\n'); renameSync(`${indexPath}.tmp`, indexPath); };
  for (const { cik, symbols } of entries) {
    const file = join(store, `${cik}.json`);
    try {
      const submissions = await getJson(fetchImpl, `${SEC}/submissions/CIK${cik}.json`, userAgent, sleep);
      await sleep(pauseMs);
      if (!submissions) { summary.missing.push(cik); continue; }
      const latest = latestFiling(submissions);
      const prior = index[cik];
      if (!force && prior && latest && prior.latestFiling === latest && existsSync(file)) {
        summary.unchanged.push(cik);
      } else {
        const facts = await getJson(fetchImpl, `${SEC}/api/xbrl/companyfacts/CIK${cik}.json`, userAgent, sleep);
        await sleep(pauseMs);
        if (!facts) { summary.missing.push(cik); continue; }
        const body = JSON.stringify({ ...facts, sic: submissions.sic ?? null });
        writeFileSync(`${file}.tmp`, body); renameSync(`${file}.tmp`, file);
        index[cik] = { symbols, name: submissions.name ?? facts.entityName ?? null, latestFiling: latest, fetchedAt: now(),
          sha256: createHash('sha256').update(body).digest('hex') };
        summary.fetched.push(cik);
        save();
        log(`fetched ${cik} ${symbols.join(',')}`);
      }
      index[cik].symbols = symbols;
      for (const symbol of symbols) {
        const link = join(store, 'by-symbol', `${symbol}.json`);
        rmSync(link, { force: true });
        symlinkSync(`../${cik}.json`, link);
      }
    } catch (error) {
      summary.failed.push({ cik, error: String(error.message || error) });
      log(`failed ${cik}: ${error.message || error}`);
    }
  }
  save();
  return summary;
}

export async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--force') args.force = true;
    else if (['--store', '--manifest', '--user-agent'].includes(key)) args[key.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${key}`);
  }
  const userAgent = args['user-agent'] || process.env.SEC_USER_AGENT;
  if (!args.store || !args.manifest || !userAgent) {
    throw new Error('Usage: node scripts/refresh-sec-store.mjs --store DIR --manifest FILE [--user-agent "Name contact@example.com" | SEC_USER_AGENT] [--force]');
  }
  const entries = parseManifest(JSON.parse(readFileSync(args.manifest, 'utf8')));
  const summary = await refreshStore({ store: resolve(args.store), entries, userAgent, force: args.force,
    log: (line) => console.error(line) });
  console.log(JSON.stringify({ issuers: entries.length, fetched: summary.fetched.length, unchanged: summary.unchanged.length,
    missing: summary.missing, failed: summary.failed }));
  if (summary.failed.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
