const test = require('node:test');
const assert = require('node:assert/strict');
const { applyResponseRules, responseSettings } = require('../scripts/agent-response-policy');

test('ponovno podešavanje ne duplira pravila i čuva postojeći prompt salona', () => {
  const original = 'Salon AURA. Osoblje Milica i Jelena. Pravilo otkazivanja ostaje isto.';
  const first = applyResponseRules(original);
  assert.equal(applyResponseRules(first), first);
  assert.ok(first.endsWith(`${original}\n`));
  assert.equal(first.split('[POČETAK PRAVILA KRATKIH ODGOVORA]').length, 2);
  assert.equal(responseSettings(original).llm, 'gpt-4.1-mini');
  assert.equal(responseSettings(original).thinking_budget, null);
  assert.equal(responseSettings(original).reasoning_effort, null);
  assert.equal(responseSettings(original).enable_reasoning_summary, false);
});

test('ne prepisuje prompt ako postoji nepotpun prethodni blok', () => {
  assert.throws(() => applyResponseRules('[POČETAK PRAVILA KRATKIH ODGOVORA]nedovršeno'), /Nepotpuna/);
});
