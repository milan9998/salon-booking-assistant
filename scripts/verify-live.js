const base = 'http://127.0.0.1:18787';
const publicBase = process.argv[2];
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(publicBase || '')) {
  throw new Error('Navedi aktuelni javni trycloudflare URL kao argument');
}

async function requireStatus(url, expected, options = {}) {
  const response = await fetch(url, options);
  if (response.status !== expected) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}, očekivano ${expected}`);
  return response;
}

(async () => {
  await requireStatus(`${base}/`, 200);
  await requireStatus(`${publicBase}/`, 200);
  const login = await requireStatus(`${base}/api/login`, 200, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD }),
  });
  const { token } = await login.json();
  const salonsResponse = await requireStatus(`${base}/api/admin/salons`, 200, { headers: { authorization: `Bearer ${token}` } });
  const { salons } = await salonsResponse.json();
  if (salons.length !== 4 || salons.some((salon) => !salon.integration_ready)) throw new Error('Četiri salona nisu spremna');
  const check = await requireStatus(`${base}/api/check-availability`, 200, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ salon_id: 'default', date: '2031-04-15', service: 'sisanje', barber: 'Marko', time: '23:00' }),
  });
  const checked = await check.json();
  if (checked.requested_time_status !== 'OUTSIDE_HOURS' || !checked.reason?.includes('Radno vreme')) {
    throw new Error('Live API ne razlikuje vreme van radnog vremena od zauzetog termina');
  }
  const old = await fetch(`${base}/api/check-availability`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-secret': process.env.BOOKING_API_SECRET, 'x-salon-id': 'default' },
    body: JSON.stringify({ date: '2031-04-15', service: 'sisanje', barber: 'Marko' }),
  });
  if (old.status !== 401) throw new Error('Stari zajednički ključ i dalje prolazi');
  console.log('Lokalni sajt: 200; javni tunel: 200; admin prijava: 200; 4 salona spremna; vreme van radnog vremena: ispravno; stari zajednički ključ: odbijen.');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
