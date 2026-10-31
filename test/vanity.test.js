// update-22: a token whose address lacks the app's mined suffix cannot be that app's launch.
// Fixtures are real: Aicrash (Robinhood, 2026-10-30) claimed Bankr with a 25% 1-day vest and no ...ba3;
// 0xcb75...ff31 (TEST402) was one of the 19 off-policy look-alikes and the only one without ...ba3;
// DRS copied the suffix (...ecba3) and is caught by its allocation alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVanity, judgeClaim, loadRegistry } from '../src/attribution.js';

const BANKR = '0xf60633d02690e2a15a54ab919925f3d038df163e';
const AICRASH = '0x78b13470ea291f425835e170718472f775e785b4';
const TEST402 = '0xcb75a545a3b4143ae7d93293db7d79b90256ff31';
const DRS = '0xe2943e4ba51bb08c1222f2a95b10ce4bb18ecba3';
const REAL = '0x4a7c549036e1f4acf7ea0f7e2592c54f88e1eba3';
const SUPPLY = 100_000_000_000n * 10n ** 18n; // totalSupply as a BigInt; judgeClaim takes the string
const SUP = SUPPLY.toString();
const bankr = (id) => loadRegistry(id).platformSpecs.find((s) => s.launchpadId === 'doppler').platform.known.get(BANKR);
// the pre-mint as the birth receipt yields it (see premintFacts): a schedule table and allocations
const sched = { 0: { cliff: 0, duration: 0 }, 1: { cliff: 2592000, duration: 31536000 }, 2: { cliff: 0, duration: 86400 } };
const mint = (pct, scheduleId) => ({ escrowed: '0', schedules: sched, allocations: [{ to: '0x' + '1'.repeat(40), scheduleId, amount: String(SUPPLY * BigInt(pct) / 100n) }] });
const BANKR_15 = mint(15, '1'), INSTANT_24 = mint(24, '0'), VEST_25_1D = mint(25, '2');

test('both registries give Bankr the ba3 rule', () => {
  for (const id of [4663, 8453]) assert.equal(bankr(id).vanity.suffix, 'ba3');
});

test('checkVanity: no rule or no address is null; the suffix is a refutation, never a confirmation', () => {
  const rule = bankr(4663).vanity;
  assert.equal(checkVanity(null, REAL), null);
  assert.equal(checkVanity(rule, null), null);
  assert.equal(checkVanity(rule, REAL), 'matches');
  assert.equal(checkVanity(rule, AICRASH), 'failed');
});

test('Aicrash: not Bankr, and the claim now says why in the address, not only in the mint', () => {
  const c = judgeClaim(bankr(4663), '0x8ff3ee16374003efd7879c5229b4a1c9dc80d49e', null, VEST_25_1D, SUP, AICRASH);
  assert.deepEqual([c.result, c.vanity, c.allocations], ['failed', 'failed', 'failed']);
});

test('a copy of Bankr\'s exact 15% / 30d / 365d policy still fails without the suffix (the gap the allocation rule left)', () => {
  const c = judgeClaim(bankr(4663), '0x8ff3ee16374003efd7879c5229b4a1c9dc80d49e', null, BANKR_15, SUP, AICRASH);
  assert.deepEqual([c.result, c.allocations, c.vanity], ['failed', 'verified', 'failed']);
});

test('TEST402 (the one off-policy look-alike without ba3) fails on both rules', () => {
  const c = judgeClaim(bankr(4663), '0x' + '2'.repeat(40), null, mint(14, '0'), SUP, TEST402);
  assert.equal(c.result, 'failed'); assert.equal(c.vanity, 'failed');
});

test('a mined ba3 suffix does not rescue an off-policy mint (DRS) and does not confirm an on-policy one', () => {
  const drs = judgeClaim(bankr(4663), '0xa032ab028968ccf8430165f77486bc805e5d789e', null, INSTANT_24, SUP, DRS);
  assert.deepEqual([drs.result, drs.vanity], ['failed', 'matches']);
  const real = judgeClaim(bankr(4663), '0xb4543c7a4ce156af9db1e88b584f47d6397b7d0f', null, BANKR_15, SUP, REAL);
  assert.deepEqual([real.result, real.vanity], ['unverified', 'matches']);
});

test('an old call without the token address judges exactly as before (no vanity field)', () => {
  const c = judgeClaim(bankr(4663), '0x' + '4'.repeat(40), null, BANKR_15, SUP);
  assert.equal(c.vanity, undefined); assert.equal(c.result, 'unverified');
});
