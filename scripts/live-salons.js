async function getLiveSalons() {
  const base = new URL(process.env.BOOKING_LOCAL_URL || `http://127.0.0.1:${process.env.PORT || 18787}`);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.pathname !== '/') {
    throw new Error('Lokalni booking API mora biti loopback HTTP adresa');
  }
  if (!process.env.ADMIN_PASSWORD) throw new Error('Nedostaje ADMIN_PASSWORD za lokalni API');
  const login = await fetch(new URL('/api/login', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!login.ok) throw new Error(`Lokalna prijava: HTTP ${login.status}`);
  const { token } = await login.json();
  const response = await fetch(new URL('/api/admin/integrations', base), {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Lokalna PostgreSQL konfiguracija: HTTP ${response.status}`);
  const result = await response.json();
  if (!Array.isArray(result.salons) || result.salons.length === 0) throw new Error('Nema salona u aktivnoj PostgreSQL aplikaciji');
  return result.salons;
}

module.exports = { getLiveSalons };
