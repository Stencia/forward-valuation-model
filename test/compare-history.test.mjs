import test from 'node:test';
import assert from 'node:assert/strict';
import { splitIssuers, pairedSummary } from '../scripts/compare-history.mjs';

test('issuer splits are deterministic, disjoint and exclude every share class of prior development firms', () => {
  const rows = Array.from({length:10},(_,i)=>({symbol:'T'+i,cik:i+1}));
  rows.push({symbol:'ALT',cik:1}, {symbol:'OTHER',cik:2});
  const a=splitIssuers(rows,{count:3,exclude:['T0']});
  const b=splitIssuers([...rows].reverse(),{count:3,exclude:['T0']});
  assert.deepEqual(a,b);
  const selected=[...a.development,...a.holdout];
  assert.equal(new Set(selected.map(r=>r.cik)).size,6);
  assert.ok(selected.every(r=>Number(r.cik)!==1));
  assert.throws(()=>splitIssuers(rows,{count:10}));
});

test('paired comparisons retain losses and reject differing outcomes or horizons', () => {
  const f = (predicted,actual=-10) => ({cutoff:'2020-01-01',period:{start:'2020-01-01',end:'2020-12-31'},
    revenue:{predicted:110,actual:100,baseline:100},earnings:{predicted,actual,baseline:20}});
  const report=pairedSummary([{symbol:'TEST',before:{folds:[f(30)]},after:{folds:[f(10)]}}]);
  assert.equal(report.earnings.nonpositiveOutcomes,1);
  assert.deepEqual(report.earnings.pooled,{before:.4,after:.2,baseline:.3});
  assert.equal(pairedSummary([{symbol:'TEST',before:{folds:[f(30)]},after:{folds:[f(10,-20)]}}]).earnings.pairedFolds,0);
  const later=f(10);later.period.end='2021-01-01';
  assert.equal(pairedSummary([{symbol:'TEST',before:{folds:[f(30)]},after:{folds:[later]}}]).earnings.pairedFolds,0);
});
