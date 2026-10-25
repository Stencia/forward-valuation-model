import { forecastFundamentals, priceForwardForecast } from '../docs/core/forward-valuation-model.js';

// Entirely synthetic inputs, not a listed company or a market quote.
const date = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
function input() {
  const quarters = Array.from({ length: 8 }, (_, i) => {
    const y = 2023 + Math.floor(i / 4); const m = i % 4 * 3;
    const revenue = [100, 120, 130, 150][i % 4] * (i < 4 ? 1 : 1.1);
    return { start: date(y, m, 1), end: date(y, m + 3, 0), knownAt: date(y, m + 3, 25), currency: 'USD',
      revenue, operatingIncome: revenue * .25, pretaxIncome: revenue * .24,
      tax: revenue * .048, netIncome: revenue * .192, dilutedShares: 10 };
  });
  return { quarters, asOf: '2025-02-01', currency: 'USD' };
}

const forecast = forecastFundamentals(input());
const valuation = priceForwardForecast(forecast, { price: 100, marketCap: 1000, date: '2025-01-31', currency: 'USD', shareBasis: 'common', source: 'Synthetic example' });
console.log(JSON.stringify({ version: forecast.version, period: forecast.period, base: valuation.scenarios.base }, null, 2));
