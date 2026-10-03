const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function mountApp(reply) {
  const elements = new Map();
  const values = new Map([['salon_token', 'old-token'], ['salon_id', 'default']]);
  let alertCount = 0;
  let closedDialogs = 0;
  function element(id = '') {
    const classes = new Set(id === 'calendarView' ? ['hidden'] : []);
    return {
      classList: {
        add: (name) => classes.add(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
        contains: (name) => classes.has(name),
      },
      listeners: {},
      addEventListener(name, listener) { this.listeners[name] = listener; },
      appendChild() {}, setAttribute() {},
      innerHTML: '', textContent: '', value: '',
    };
  }
  const context = {
    sessionStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
      createElement: () => element(),
      querySelectorAll: () => [{ close: () => { closedDialogs++; } }],
    },
    fetch: reply,
    alert: () => { alertCount++; },
    setInterval: () => 0,
    console,
  };
  vm.runInNewContext(source, context, { filename: 'app.js' });
  return { elements, values, alertCount: () => alertCount, closedDialogs: () => closedDialogs };
}

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('stari token pri otvaranju stranice vraća korisnika na prijavu', async () => {
  const app = mountApp(async () => response(401, { error: 'Unauthorized' }));
  await new Promise(setImmediate);
  assert.equal(app.values.has('salon_token'), false);
  assert.equal(app.elements.get('loginView').classList.contains('hidden'), false);
  assert.equal(app.elements.get('calendarView').classList.contains('hidden'), true);
  assert.match(app.elements.get('loginError').textContent, /Prijavite se ponovo/);
  assert.equal(app.alertCount(), 0);
});

test('401 na Osveži zatvara dijalog i ne prikazuje Unauthorized alert', async () => {
  let expired = false;
  const app = mountApp(async (url) => {
    if (expired) return response(401, { error: 'Unauthorized' });
    if (url === '/api/me') return response(200, { role: 'platform', user: 'admin' });
    if (url === '/api/admin/salons') return response(200, { salons: [] });
    return response(200, { appointments: [] });
  });
  await new Promise(setImmediate);
  assert.equal(app.elements.get('calendarView').classList.contains('hidden'), false);
  expired = true;
  await app.elements.get('refreshBtn').listeners.click();
  assert.equal(app.values.has('salon_token'), false);
  assert.equal(app.elements.get('loginView').classList.contains('hidden'), false);
  assert.equal(app.elements.get('calendarView').classList.contains('hidden'), true);
  assert.ok(app.closedDialogs() > 0);
  assert.equal(app.alertCount(), 0);
});
