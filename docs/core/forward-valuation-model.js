// Research model only. Scenario bounds are sensitivity assumptions, not confidence intervals.
export const FORWARD_MODEL_VERSION = 'forward-fundamentals-1';
const DAY = 86400000;
export const validDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;
const addDays = (d, n) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Inputs are eight consecutive, point-in-time quarters on one currency/share basis.
// The caller resolves filings and corporate actions before invoking this price-free function.
export function forecastFundamentals({ quarters, asOf, currency, eligibility = {}, guidance = null }) {
  const base = { version: FORWARD_MODEL_VERSION, asOf, currency, status: 'unavailable', researchOnly: true };
  const fail = (reason) => ({ ...base, reason });
  if (!validDate(asOf)) return fail('invalid-as-of');
  if (!/^[A-Z]{3}$/.test(currency || '')) return fail('missing-currency');
  if (eligibility.unsupportedBusiness || eligibility.shareBasisUnresolved) return fail('unsupported-basis');
  if (!Array.isArray(quarters) || quarters.length < 8) return fail('insufficient-history');
  const qs = quarters.slice(-8);
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (![q.start, q.end, q.knownAt].every(validDate) || q.knownAt > asOf || q.end >= q.knownAt
      || daysBetween(q.start, q.end) < 70 || daysBetween(q.start, q.end) > 110
      || (i && q.start !== addDays(qs[i - 1].end, 1))) return fail('invalid-periods');
    if (q.currency !== currency || !finite(q.revenue) || q.revenue <= 0) return fail('invalid-revenue');
  }
  const last = qs.at(-1);
  if (daysBetween(last.end, asOf) > 185) return fail('stale-history');
  const recent = qs.slice(-4);
  const yoy = recent.map((q, i) => q.revenue / qs[i].revenue - 1);
  if (yoy.some((g) => g < -0.5 || g > 1)) return fail('revenue-regime-change');
  const growth = median(yoy);
  const spread = Math.max(0.05, median(yoy.map((g) => Math.abs(g - growth))) * 1.4826);
  const calendarQuarters = qs.every((q) => q.start.endsWith('-01') && addDays(q.end, 1).endsWith('-01'));
  const advanceEnd = (end) => calendarQuarters
    ? new Date(Date.UTC(Number(end.slice(0, 4)) + 1, Number(end.slice(5, 7)), 0)).toISOString().slice(0, 10)
    : addDays(end, 364);
  const period = { start: addDays(last.end, 1), end: advanceEnd(last.end),
    basis: 'next-four-unreported-fiscal-quarters', datesEstimated: !calendarQuarters };
  let guidanceReason = null;
  const guided = guidance && guidance.start === period.start && guidance.end === period.end
    && guidance.currency === currency && validDate(guidance.publishedAt) && guidance.publishedAt <= asOf
    && guidance.publishedAt >= last.knownAt && /^https:\/\//.test(guidance.sourceUrl || '')
    && guidance.basis === 'revenue' && finite(guidance.low) && guidance.low > 0
    && finite(guidance.high) && guidance.high >= guidance.low;
  if (guidance && !guided) guidanceReason = 'guidance-period-basis-or-date-mismatch';
  const required = ['operatingIncome', 'pretaxIncome', 'tax', 'netIncome', 'dilutedShares'];
  let earningsReason = qs.some((q) => required.some((k) => !finite(q[k]))) ? 'missing-earnings-inputs' : null;
  if (!earningsReason && qs.some((q) => q.dilutedShares <= 0 || q.pretaxIncome <= 0 || q.netIncome <= 0)) earningsReason = 'nonpositive-earnings';
  const shareChanges = !earningsReason ? recent.map((q, i) => q.dilutedShares / qs[i].dilutedShares - 1) : [];
  if (!earningsReason && shareChanges.some((x) => Math.abs(x) > 0.25)) earningsReason = 'share-basis-discontinuity';
  const taxRates = !earningsReason ? recent.map((q) => q.tax / q.pretaxIncome) : [];
  if (!earningsReason && taxRates.some((t) => t < 0 || t > 0.6)) earningsReason = 'unusual-tax-rate';
  // Material non-operating earnings are not silently projected as recurring operating profit.
  if (!earningsReason && recent.some((q) => Math.abs(q.pretaxIncome - q.operatingIncome) / q.revenue > 0.15)) earningsReason = 'material-nonoperating-income';
  if (!earningsReason && recent.some((q) => Math.abs(q.pretaxIncome - q.tax - q.netIncome) / q.revenue > 0.03)) earningsReason = 'common-earnings-reconciliation';
  const revenueTTM = sum(recent.map((q) => q.revenue));
  const operatingMargin = !earningsReason ? sum(recent.map((q) => q.operatingIncome)) / revenueTTM : null;
  const nonoperatingMargin = !earningsReason ? median(recent.map((q) => (q.pretaxIncome - q.operatingIncome) / q.revenue)) : null;
  const taxRate = !earningsReason ? median(taxRates) : null;
  const shareGrowth = !earningsReason ? median(shareChanges) : null;
  const commonDrag = !earningsReason ? median(recent.map((q) => (q.pretaxIncome - q.tax - q.netIncome) / q.revenue)) : null;
  const scenarios = {};
  for (const [name, sign] of [['low', -1], ['base', 0], ['high', 1]]) {
    const g = clamp(growth + sign * spread, -0.5, 1);
    let rows = recent.map((q, i) => ({ start: i ? addDays(advanceEnd(recent[i - 1].end), 1) : period.start,
      end: advanceEnd(q.end), revenue: q.revenue * (1 + g) }));
    if (guided) {
      const target = sign < 0 ? guidance.low : sign > 0 ? guidance.high : (guidance.low + guidance.high) / 2;
      const scale = target / sum(rows.map((q) => q.revenue));
      rows = rows.map((q) => ({ ...q, revenue: q.revenue * scale }));
    }
    rows = rows.map((q, i) => {
      if (earningsReason) return q;
      const margin = (operatingMargin + recent[i].operatingIncome / recent[i].revenue) / 2 + sign * 0.02;
      const op = q.revenue * margin;
      const pretax = op + q.revenue * nonoperatingMargin;
      const tax = pretax * clamp(taxRate - sign * 0.02, 0, 0.6);
      const net = pretax - tax - commonDrag * q.revenue;
      const shares = last.dilutedShares * (1 + shareGrowth - sign * 0.01) ** ((i + 1) / 4);
      return { ...q, operatingIncome: op, pretaxIncome: pretax, tax, netIncome: net, dilutedShares: shares, eps: net / shares };
    });
    const eps = earningsReason ? null : sum(rows.map((q) => q.eps));
    scenarios[name] = { revenue: sum(rows.map((q) => q.revenue)), eps: eps > 0 ? eps : null, quarters: rows };
  }
  return { ...base, status: 'estimated', period, scenarios, earningsReason, guidanceReason,
    assumptions: { revenueGrowth: growth, revenueGrowthSpread: spread, operatingMargin, nonoperatingMargin,
      taxRate, dilutedShareGrowth: shareGrowth, commonDrag, guidance: guided ? guidance : null },
    baselines: { revenue: revenueTTM, eps: !earningsReason ? sum(recent.map((q) => q.netIncome / q.dilutedShares)) : null },
    inputs: qs, warnings: ['Sensitivity scenarios are not calibrated confidence intervals.',
      'Calendar quarter boundaries advance by year; week-based dates assume 52 weeks. This is not rolling NTM.',
      'GAAP-input mechanical forecast; no analyst adjustments or discretionary business-driver forecasts.'] };
}

export function priceForwardForecast(forecast, quote) {
  if (forecast.status !== 'estimated') return { status: 'unavailable', reason: forecast.reason };
  if (!quote || quote.currency !== forecast.currency || !validDate(quote.date)
    || daysBetween(quote.date, forecast.asOf) < 0 || daysBetween(quote.date, forecast.asOf) > 7
    || !finite(quote.price) || quote.price <= 0 || !finite(quote.marketCap) || quote.marketCap <= 0
    || quote.shareBasis !== 'common' || !quote.source) return { status: 'unavailable', reason: 'invalid-quote-basis-or-date' };
  return { status: 'estimated', quote, scenarios: Object.fromEntries(Object.entries(forecast.scenarios).map(([name, s]) => [name,
    { forwardPS: quote.marketCap / s.revenue, forwardPE: s.eps > 0 ? quote.price / s.eps : null }])) };
}
