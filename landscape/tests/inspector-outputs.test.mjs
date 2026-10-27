import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputDate, outputHeldFor } from '../web/ui/inspector-outputs.js';

test('calendar dates are readable and stay in UTC', () => {
  assert.deepEqual(outputDate('2023-10-10', 0, []), { iso:'2023-10-10',label:'10 Oct 2023' });
  assert.deepEqual(outputDate(null, 0, [1696982399]), { iso:'2023-10-10',label:'10 Oct 2023' });
  assert.equal(outputDate(null, 5, []).label, 'Date unavailable');
});

test('holding time uses elapsed timestamps, rather than assuming each block took ten minutes', () => {
  assert.deepEqual(outputHeldFor({created:0,spent:1},10,[1000,1420]), {label:'7 min',blocks:1,approximate:false});
  assert.deepEqual(outputHeldFor({created:0,spent:1},10,[1000,8200]), {label:'2 hours',blocks:1,approximate:false});
  assert.equal(outputHeldFor({created:0,spent:0},10,[]).label, 'Same block');
});

test('still-unspent age stops at selection, while spent lifespan stops at spend height', () => {
  const times=[1000,87400,173800];
  assert.equal(outputHeldFor({created:0,spent:null},1,times).label,'1 day');
  assert.equal(outputHeldFor({created:0,spent:2},1,times).label,'2 days');
  assert.equal(outputHeldFor({created:1,spent:null},1,times).label,'Just created');
});

test('missing or backwards timestamps give explicitly approximate durations', () => {
  assert.deepEqual(outputHeldFor({created:0,spent:14},20,[]),{label:'≈2 hours',blocks:14,approximate:true});
  assert.equal(outputHeldFor({created:0,spent:1},5,[1000,999]).label,'≈10 min');
  assert.equal(outputHeldFor({created:5,spent:null},3,[]).label,'—');
});
