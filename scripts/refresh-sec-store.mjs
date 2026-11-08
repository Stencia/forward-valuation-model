// Keeps one local copy of SEC Company Facts per issuer and re-downloads an issuer only when its
// newest financial report is not yet in the stored copy. Company Facts keeps every filing's value
// with its filing date, and the adapter filters every namespace by that date, so the current copy
// rebuilds the facts known at an earlier cutoff (see METHODOLOGY.md for what it does not rebuild).
//
// Layout of the store directory:
//   <CIK>.json            Company Facts enriched with `sic` (the input compare-history reads)
//   by-symbol/<SYM>.json  symbolic links to the CIK files (the input evaluate-forward-valuation reads)
//   index.json            per CIK: symbols, newest financial report, whether the file contains it,
//                         fetch time and SHA-256 of the stored file
//   .lock                 held while a refresh runs
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEC = 'https://data.sec.gov';
const DAY = 86400000;
const pad = (cik) => String(cik).padStart(10, '0');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Periodic reports carrying XBRL financial statements. Other filings (8-K, Form 4, 144) do not
// change the statements this model reads and do not trigger a download.
const FINANCIAL_FORMS = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;
// A financial report that never reaches Company Facts (a cover-page-only amendment) stops being
// waited for after this many days, so the issuer is not downloaded on every run.
const SETTLE_DAYS = 30;

export class FatalSecError extends Error {}

export function parseManifest(rows) {
  if (!Array.isArray(rows)) throw new Error('Manifest must be a JSON array of { symbol, cik }');
  const out = new Map(); const owner = new Map();
  for (const r of rows) {
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(r?.symbol || '') || !/^\d{1,10}$/.test(String(r?.cik ?? ''))) throw new Error(`Invalid symbol or CIK: ${JSON.stringify(r)}`);
    const cik = pad(r.cik);
    if (owner.has(r.symbol) && owner.get(r.symbol) !== cik) throw new Error(`Symbol ${r.symbol} maps to CIKs ${owner.get(r.symbol)} and ${cik}`);
    owner.set(r.symbol, cik);
    if (!out.has(cik)) out.set(cik, { cik, symbols: [] });
    if (!out.get(cik).symbols.includes(r.symbol)) out.get(cik).symbols.push(r.symbol);
  }
  return [...out.values()];
}

// The newest periodic report with XBRL on the issuer's submissions record. The newest filings are
// always in `filings.recent`; older ones overflow into `filings.files`, which is not needed here.
export function latestFinancialReport(submissions) {
  const r = submissions?.filings?.recent || {};
  const rows = (r.accessionNumber || []).map((accession, i) => ({ accession, form: r.form?.[i],
    acceptedAt: r.acceptanceDateTime?.[i] || r.filingDate?.[i] || '', xbrl: r.isXBRL?.[i] }));
  return rows.filter((x) => FINANCIAL_FORMS.test(x.form || '') && Number(x.xbrl) === 1 && x.acceptedAt)
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt)).map(({ accession, form, acceptedAt }) => ({ accession, form, acceptedAt })).at(-1) ?? null;
}

export function factsContain(facts, accession) {
  for (const concepts of Object.values(facts?.facts || {})) for (const c of Object.values(concepts))
    for (const points of Object.values(c.units || {})) if (points.some((p) => p.accn === accession)) return true;
  return false;
}

async function getJson(url, { fetchImpl, userAgent, sleep, timeoutMs, attempts = 5 }) {
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (i >= attempts) throw new Error(`${url}: ${error.message || error}`);
      await sleep(1000 * 2 ** i); continue;
    }
    if (res.ok) {
      try { return await res.json(); } catch (error) {
        if (i >= attempts) throw new Error(`${url}: unreadable body (${error.message || error})`);
        await sleep(1000 * 2 ** i); continue;
      }
    }
    if (res.status === 404) return null;
    // SEC answers an over-limit or unidentified client with 403; continuing would only extend the block.
    if (res.status === 403) throw new FatalSecError(`${url}: HTTP 403 from SEC; stopping the refresh. Check the User-Agent and request rate.`);
    if (i >= attempts || ![429, 500, 502, 503, 504].includes(res.status)) {
      if (res.status === 429) throw new FatalSecError(`${url}: still rate limited after ${attempts} attempts; stopping the refresh.`);
      throw new Error(`${url}: HTTP ${res.status}`);
    }
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** i);
  }
}

function writeAtomic(path, bytes) { writeFileSync(`${path}.tmp`, bytes); renameSync(`${path}.tmp`, path); }
function linkAtomic(link, target) {
  try { if (readlinkSync(link) === target) return; } catch {}
  rmSync(`${link}.tmp`, { force: true });
  symlinkSync(target, `${link}.tmp`); renameSync(`${link}.tmp`, link);
}
function acquireLock(store) {
  const lock = join(store, '.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return lock; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const pid = Number(readFileSync(lock, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
  if (alive && pid !== process.pid) throw new Error(`Another refresh (pid ${pid}) holds ${lock}`);
  writeFileSync(lock, String(process.pid));
  return lock;
}

// SEC asks automated clients to stay under ten requests a second.
export async function refreshStore({ store, entries, userAgent, force = false, fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date().toISOString(),
  pauseMs = 150, timeoutMs = 60000, log = () => {} }) {
  if (!/^\S.*\s\S+@\S+\.\S+$/.test(userAgent || '')) throw new Error('SEC requires a User-Agent naming the client and a contact address');
  mkdirSync(join(store, 'by-symbol'), { recursive: true });
  const lock = acquireLock(store);
  const indexPath = join(store, 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {};
  const summary = { fetched: [], unchanged: [], pending: [], missing: [], failed: [], stopped: null };
  const save = () => writeAtomic(indexPath, JSON.stringify(index, null, 2) + '\n');
  const http = { fetchImpl, userAgent, sleep, timeoutMs };
  try {
    for (const { cik, symbols } of entries) {
      const file = join(store, `${cik}.json`);
      try {
        const submissions = await getJson(`${SEC}/submissions/CIK${cik}.json`, http);
        await sleep(pauseMs);
        if (!submissions) { summary.missing.push(cik); continue; }
        const latest = latestFinancialReport(submissions);
        const prior = index[cik];
        const stored = existsSync(file) ? readFileSync(file) : null;
        const intact = stored && prior?.sha256 === sha256(stored);
        // Up to date: the stored file is the one indexed and already contains the newest financial
        // report (or there is none, or it is settled as never reaching Company Facts).
        const settled = (entry) => entry?.latestFinancial?.accession === latest?.accession
          && (entry.inFacts || Date.parse(now()) - Date.parse(latest.acceptedAt) > SETTLE_DAYS * DAY);
        let current = !force && intact && (latest ? settled(prior) : !prior.latestFinancial);
        if (!current && !force && intact && latest && factsContain(JSON.parse(stored), latest.accession)) {
          index[cik] = { ...prior, latestFinancial: latest, inFacts: true };
          current = true;
        }
        if (current) {
          summary.unchanged.push(cik);
        } else {
          const facts = await getJson(`${SEC}/api/xbrl/companyfacts/CIK${cik}.json`, http);
          await sleep(pauseMs);
          if (!facts) { summary.missing.push(cik); continue; }
          const body = JSON.stringify({ ...facts, sic: submissions.sic ?? null });
          writeAtomic(file, body);
          const inFacts = latest ? factsContain(facts, latest.accession) : true;
          index[cik] = { symbols, name: submissions.name ?? facts.entityName ?? null, latestFinancial: latest, inFacts,
            fetchedAt: now(), sha256: sha256(body) };
          (latest && !settled(index[cik]) ? summary.pending : summary.fetched).push(cik);
          log(`${latest && !inFacts ? 'pending' : 'fetched'} ${cik} ${symbols.join(',')}`);
        }
        index[cik].symbols = symbols;
        for (const symbol of symbols) linkAtomic(join(store, 'by-symbol', `${symbol}.json`), `../${cik}.json`);
        save();
      } catch (error) {
        if (error instanceof FatalSecError) { summary.stopped = error.message; log(error.message); break; }
        summary.failed.push({ cik, error: String(error.message || error) });
        log(`failed ${cik}: ${error.message || error}`);
      }
    }
    if (!summary.stopped) {
      // The manifest is the membership: links and index symbols outside it are removed. Stored
      // facts files are kept, since earlier reports may have read them.
      const wanted = new Map(entries.flatMap(({ cik, symbols }) => symbols.map((s) => [s, cik])));
      for (const name of readdirSync(join(store, 'by-symbol'))) {
        const symbol = name.replace(/\.json(\.tmp)?$/, '');
        if (name.endsWith('.tmp') || !wanted.has(symbol)) rmSync(join(store, 'by-symbol', name), { force: true });
      }
      const inManifest = new Set(entries.map((e) => e.cik));
      for (const [cik, entry] of Object.entries(index)) if (!inManifest.has(cik)) entry.symbols = [];
      save();
    }
  } finally {
    rmSync(lock, { force: true });
  }
  return summary;
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--force') { args.force = true; continue; }
    if (!['--store', '--manifest', '--user-agent'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    args[key.slice(2)] = value; i++;
  }
  return args;
}

export async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  const userAgent = args['user-agent'] || env.SEC_USER_AGENT;
  if (!args.store || !args.manifest || !userAgent) {
    throw new Error('Usage: node scripts/refresh-sec-store.mjs --store DIR --manifest FILE [--user-agent "Name contact@example.com" | SEC_USER_AGENT] [--force]');
  }
  const entries = parseManifest(JSON.parse(readFileSync(args.manifest, 'utf8')));
  const summary = await refreshStore({ store: resolve(args.store), entries, userAgent, force: args.force,
    log: (line) => console.error(line) });
  console.log(JSON.stringify({ issuers: entries.length, fetched: summary.fetched.length, unchanged: summary.unchanged.length,
    pending: summary.pending, missing: summary.missing, failed: summary.failed, stopped: summary.stopped }));
  // Missing issuers mean a stale manifest; pending ones resolve on a later run.
  return summary.stopped || summary.failed.length || summary.missing.length ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (error) => { console.error(error.message); process.exitCode = 1; });
}
