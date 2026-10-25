// Offline comparison of a frozen release with this checkout on a deterministic issuer split.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { backtestCompany } from './evaluate-forward-valuation.mjs';
import { validDate } from '../docs/core/forward-valuation-model.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const mean = xs => xs.length ? xs.reduce((a,b) => a+b, 0) / xs.length : null;

export function splitIssuers(rows, { count = 30, exclude = [], seed = 'forward-v2-validation:' } = {}) {
  if (!Number.isInteger(count) || count <= 0) throw new Error('count must be a positive integer');
  const excluded = new Set(exclude);
  const excludedCiks = new Set(rows.filter(r => excluded.has(r.symbol)).map(r => String(r.cik).padStart(10, '0')));
  const issuers = new Map();
  for (const r of [...rows].sort((a,b) => String(a.symbol).localeCompare(String(b.symbol)))) {
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(r.symbol || '') || !/^\d{1,10}$/.test(String(r.cik))) throw new Error('Invalid symbol or CIK');
    const cik = String(r.cik).padStart(10, '0');
    if (!excludedCiks.has(cik)) issuers.set(cik, { symbol: r.symbol, cik });
  }
  const ordered = [...issuers.values()].sort((a,b) => hash(seed+a.cik).localeCompare(hash(seed+b.cik)));
  if (ordered.length < count * 2) throw new Error('Not enough unique issuers for disjoint samples');
  return { development: ordered.slice(0,count), holdout: ordered.slice(count,count*2) };
}

export function pairedSummary(results) {
  return Object.fromEntries(['revenue', 'earnings'].map(metric => {
    const perCompany = results.map(r => {
      const next = new Map(r.after.folds.map(f => [f.cutoff, f]));
      const pairs = r.before.folds.flatMap(a => {
        const b = next.get(a.cutoff);
        if (!b || a.period.start !== b.period.start || a.period.end !== b.period.end) return [];
        const left = a[metric], right = b[metric];
        if (![left.predicted, right.predicted, left.actual, right.actual, left.baseline, right.baseline].every(Number.isFinite)
          || left.actual !== right.actual || left.baseline !== right.baseline) return [];
        // Scales earnings errors by historical revenue so zero/loss outcomes stay in the sample.
        const scale = metric === 'earnings' ? a.revenue.baseline : left.actual;
        if (!(scale > 0)) return [];
        return [{ before: Math.abs(left.predicted-left.actual)/scale,
          after: Math.abs(right.predicted-right.actual)/scale,
          baseline: Math.abs(left.baseline-left.actual)/scale, nonpositive: left.actual <= 0 }];
      });
      return { symbol: r.symbol, pairs };
    }).filter(r => r.pairs.length);
    const pairs = perCompany.flatMap(r => r.pairs);
    return [metric, { companies: perCompany.length, pairedFolds: pairs.length,
      nonpositiveOutcomes: pairs.filter(r=>r.nonpositive).length,
      scale: metric === 'earnings' ? 'trailing-year revenue' : 'realized revenue',
      pooled: Object.fromEntries(['before','after','baseline'].map(k=>[k,mean(pairs.map(p=>p[k]))])),
      equalCompanyWeight: Object.fromEntries(['before','after','baseline'].map(k=>[k,mean(perCompany.map(r=>mean(r.pairs.map(p=>p[k]))))])),
      companiesImproved: perCompany.filter(r=>mean(r.pairs.map(p=>p.after)) < mean(r.pairs.map(p=>p.before))).length,
    }];
  }));
}

export async function main(argv) {
  const allowed = new Set(['manifest','input-dir','baseline-root','split','as-of','out','exclude','count']);
  const args = {};
  for (let i=0;i<argv.length;i+=2) {
    const key=argv[i].replace(/^--/,'');
    if (!argv[i].startsWith('--') || !allowed.has(key) || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error('Invalid arguments');
    args[key]=argv[i+1];
  }
  if (!args.manifest || !args['input-dir'] || !args['baseline-root'] || !args.out
    || !['development','holdout'].includes(args.split) || !validDate(args['as-of']))
    throw new Error('Required: --manifest FILE --input-dir DIR --baseline-root DIR --split development|holdout --as-of DATE --out FILE');
  const manifestBytes = readFileSync(args.manifest);
  const splits = splitIssuers(JSON.parse(manifestBytes), { count: Number(args.count || 30), exclude: (args.exclude || '').split(',') });
  const baseline = await import(pathToFileURL(resolve(args['baseline-root'],'scripts/evaluate-forward-valuation.mjs')).href);
  const results = [];
  for (const r of splits[args.split]) {
    const bytes=readFileSync(resolve(args['input-dir'],`${r.cik}.json`));
    const raw=JSON.parse(bytes);
    if (String(raw.cik).padStart(10,'0') !== r.cik) throw new Error(`CIK mismatch for ${r.symbol}`);
    const before=baseline.backtestCompany(raw,args['as-of']);
    const after=backtestCompany(raw,args['as-of']);
    results.push({...r,inputSha256:hash(bytes),before,after});
    console.log(`${r.symbol}: ${before.folds.length} / ${after.folds.length} realized folds`);
  }
  const report={asOf:args['as-of'],split:args.split,manifestSha256:hash(manifestBytes),splits,summary:pairedSummary(results),results};
  writeFileSync(args.out,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.summary,null,2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
