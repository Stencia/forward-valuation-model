// Offline and reproducible. Inputs/output are research artifacts outside Git, never a feed scheduler.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { forecastFundamentals, priceForwardForecast, validDate, daysBetween } from '../docs/core/forward-valuation-model.js';
import { companyFactsModelInput } from './forward-valuation-inputs.mjs';
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => xs.length ? sum(xs) / xs.length : null;
const ape = (estimate, actual) => actual > 0 && Number.isFinite(estimate) ? Math.abs(estimate / actual - 1) : null;

export function backtestCompany(raw, asOf) {
  // Every fold re-selects the raw facts using its cutoff. Revised current quarters never enter training.
  const truth = companyFactsModelInput(raw, asOf);
  const cutoffs = [...new Set(Object.values(raw.facts?.['us-gaap'] || {}).flatMap((c) =>
    Object.values(c.units || {}).flat().filter((p) => /^10-[QK]$/.test(p.form) && p.filed <= asOf && p.filed >= '2018-01-01').map((p) => p.filed)))].sort();
  const folds = [];
  const audit = { cutoffs: cutoffs.length, withheld: {}, duplicateHorizons: 0, incompleteOutcomes: 0 };
  const seen = new Set();
  for (const cutoff of cutoffs) {
    const input = companyFactsModelInput(raw, cutoff);
    const forecast = forecastFundamentals(input);
    if (forecast.status !== 'estimated') {
      audit.withheld[forecast.reason] = (audit.withheld[forecast.reason] || 0) + 1;
      continue;
    }
    if (seen.has(forecast.period.start)) { audit.duplicateHorizons++; continue; }
    const actual = truth.quarters.filter((q) => q.start >= forecast.period.start).slice(0, 4);
    if (actual.length !== 4 || actual[0].start !== forecast.period.start
      || Math.abs(daysBetween(actual.at(-1).end, forecast.period.end)) > 7
      || actual.some((q, i) => q.knownAt > asOf || !(q.revenue > 0)
        || (i && daysBetween(actual[i - 1].end, q.start) !== 1))) { audit.incompleteOutcomes++; continue; }
    seen.add(forecast.period.start);
    const revenue = sum(actual.map((q) => q.revenue));
    const actualNet = actual.every((q) => Number.isFinite(q.netIncome)) ? sum(actual.map((q) => q.netIncome)) : null;
    const predictedNet = forecast.earningsReason ? null : sum(forecast.scenarios.base.quarters.map((q) => q.netIncome));
    const baselineNet = forecast.earningsReason ? null : sum(input.quarters.slice(-4).map((q) => q.netIncome));
    const scale = forecast.baselines.revenue;
    const scaledError = (estimate, observed) => Number.isFinite(estimate) && Number.isFinite(observed)
      && scale > 0 ? Math.abs(estimate - observed) / scale : null;
    folds.push({ cutoff, earningsReason: forecast.earningsReason, period: forecast.period, revenue: { predicted: forecast.scenarios.base.revenue,
      actual: revenue, baseline: forecast.baselines.revenue, error: ape(forecast.scenarios.base.revenue, revenue),
      baselineError: ape(forecast.baselines.revenue, revenue) }, earnings: { predicted: predictedNet,
      actual: actualNet, baseline: baselineNet, error: ape(predictedNet, actualNet), baselineError: ape(baselineNet, actualNet),
      errorAsShareOfTrailingRevenue: scaledError(predictedNet, actualNet),
      baselineErrorAsShareOfTrailingRevenue: scaledError(baselineNet, actualNet) } });
  }
  const summary = Object.fromEntries(['revenue', 'earnings'].map((metric) => {
    const rows = folds.filter((f) => f[metric].error != null && f[metric].baselineError != null);
    return [metric, { observations: rows.length, mape: mean(rows.map((f) => f[metric].error)),
      baselineMape: mean(rows.map((f) => f[metric].baselineError)),
      winRate: mean(rows.map((f) => Number(f[metric].error < f[metric].baselineError))) }];
  }));
  const scoredEarnings = folds.filter(f => f.earnings.errorAsShareOfTrailingRevenue != null
    && f.earnings.baselineErrorAsShareOfTrailingRevenue != null);
  summary.earnings.includingLosses = {
    observations: scoredEarnings.length,
    nonpositiveOutcomes: scoredEarnings.filter(f => f.earnings.actual <= 0).length,
    meanAbsoluteErrorAsShareOfTrailingRevenue: mean(scoredEarnings.map(f => f.earnings.errorAsShareOfTrailingRevenue)),
    baselineMeanAbsoluteErrorAsShareOfTrailingRevenue: mean(scoredEarnings.map(f => f.earnings.baselineErrorAsShareOfTrailingRevenue)),
  };
  audit.earningsWithheld = {};
  for (const fold of folds) if (fold.earningsReason)
    audit.earningsWithheld[fold.earningsReason] = (audit.earningsWithheld[fold.earningsReason] || 0) + 1;
  audit.missingEarningsOutcomes = folds.filter(f => !Number.isFinite(f.earnings.actual)).length;
  return { summary, audit, folds, limitations: ['Overlapping forecast windows, not independent observations.',
    'Actuals use latest available restatements; input selection uses each historical SEC publication cutoff.',
    'Current company sample has survivorship bias; this is not a universe-wide performance claim.',
    'Earnings backtest measures net income, not adjusted consensus EPS.',
    'MAPE excludes nonpositive outcomes; the trailing-revenue-scaled earnings error includes losses and zero outcomes.'] };
}

export function comparePublished(forecast, priced, reference) {
  if (!reference) return null;
  if (!validDate(reference.observedAt) || !validDate(reference.priceDate) || !/^https:\/\//.test(reference.url || '')
    || reference.observedAt > forecast.asOf || reference.priceDate > forecast.asOf
    || daysBetween(reference.priceDate, forecast.asOf) > 7
    || reference.currency !== forecast.currency || reference.observedAt < reference.priceDate
    || !Number.isFinite(reference.price) || !Number.isFinite(reference.forwardPE)
    || !(reference.price > 0) || !(reference.forwardPE > 0)) return { status: 'unavailable', reason: 'invalid-reference' };
  const impliedEPS = reference.price / reference.forwardPE;
  const eps = forecast.scenarios?.base.eps;
  return { status: eps > 0 ? 'context-only' : 'withheld', reference,
    impliedReferenceEPS: impliedEPS, modelEPS: eps ?? null,
    modelPEAtReferencePrice: eps > 0 ? reference.price / eps : null,
    modelPEAtTwelveDataPrice: priced.scenarios?.base.forwardPE ?? null,
    epsDifference: eps > 0 ? eps / impliedEPS - 1 : null,
    reason: 'Provider forecast horizon and adjusted/GAAP basis are not verified. Difference is not forecast accuracy.' };
}

export function evaluateCompany(raw, { asOf, quote, reference, guidance, backtest = false }) {
  const input = companyFactsModelInput(raw, asOf);
  const forecast = forecastFundamentals({ ...input, guidance });
  const priced = priceForwardForecast(forecast, quote);
  return { provenance: { ...input.provenance, inputSha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex') }, forecast, priced, comparison: comparePublished(forecast, priced, reference),
    ...(backtest ? { backtest: backtestCompany(raw, asOf) } : {}) };
}

export function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--backtest') args.backtest = true;
    else if (['--input-dir', '--symbols', '--as-of', '--quotes', '--references', '--guidance', '--out'].includes(key)) args[key.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args['input-dir'] || !args.symbols || !validDate(args['as-of']) || !args.out) {
    throw new Error('Usage: node scripts/evaluate-forward-valuation.mjs --input-dir DIR --symbols AAPL,MSFT --as-of YYYY-MM-DD --out FILE [--quotes FILE] [--references FILE] [--guidance FILE] [--backtest]');
  }
  const symbols = args.symbols.split(',');
  if (symbols.some((s) => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(s))) throw new Error('Invalid symbols');
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const quotes = args.quotes ? read(args.quotes) : {};
  const references = args.references ? read(args.references) : {};
  const guidance = args.guidance ? read(args.guidance) : {};
  const results = Object.fromEntries(symbols.map((symbol) => [symbol, evaluateCompany(read(resolve(args['input-dir'], `${symbol}.json`)),
    { asOf: args['as-of'], quote: quotes[symbol], reference: references[symbol], guidance: guidance[symbol], backtest: args.backtest })]));
  writeFileSync(args.out, JSON.stringify({ asOf: args['as-of'], results }, null, 2) + '\n');
  for (const [symbol, r] of Object.entries(results)) console.log(JSON.stringify({ symbol,
    reason: r.forecast.reason || r.forecast.earningsReason, revenue: r.forecast.scenarios?.base.revenue,
    eps: r.forecast.scenarios?.base.eps, ratios: r.priced.scenarios?.base, comparison: r.comparison,
    backtest: r.backtest?.summary }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
