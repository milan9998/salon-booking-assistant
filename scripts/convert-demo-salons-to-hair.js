const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.env.BOOKING_DB_FILE || path.join(__dirname, '..', 'appointments.db');
const db = new DatabaseSync(databasePath);
const changes = [
  {
    id: 'kozmeticki-salon-aura',
    oldName: 'Kozmetički salon AURA',
    name: 'Frizerski salon AURA',
    services: ['sisanje', 'feniranje', 'farbanje'],
    barbers: ['Milica', 'Jelena'],
    knowledge: 'Frizerski salon AURA. Milica i Jelena rade šišanje, feniranje i farbanje. Ne nudimo manikir, pedikir niti tretmane lica. Za cene i lokaciju pitati salon ako nisu posebno navedeni.',
  },
  {
    id: 'masazni-studio-relax',
    oldName: 'Masažni studio RELAX',
    name: 'Frizerski salon RELAX',
    services: ['sisanje', 'feniranje', 'farbanje'],
    barbers: ['Luka', 'Tamara'],
    knowledge: 'Frizerski salon RELAX. Luka i Tamara rade šišanje, feniranje i farbanje. Ne nudimo masaže. Za cene i lokaciju pitati salon ako nisu posebno navedeni.',
  },
];

try {
  const before = db.prepare('SELECT id, name, agent_id, services_json, barbers_json FROM salons ORDER BY id').all();
  if (before.length !== 4 || !before.some((row) => row.id === 'default') ||
      !before.some((row) => row.id === 'frizerski-salon-viva')) {
    throw new Error('Očekivana četiri salona nisu pronađena; baza nije promenjena.');
  }
  for (const change of changes) {
    const row = before.find((item) => item.id === change.id);
    if (!row || !row.agent_id || ![change.oldName, change.name].includes(row.name) ||
        JSON.stringify(JSON.parse(row.barbers_json)) !== JSON.stringify(change.barbers)) {
      throw new Error(`Neočekivano stanje salona ${change.id}; baza nije promenjena.`);
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const update = db.prepare('UPDATE salons SET name = ?, services_json = ?, knowledge_notes = ? WHERE id = ?');
    for (const change of changes) {
      const result = update.run(change.name, JSON.stringify(change.services), change.knowledge, change.id);
      if (result.changes !== 1) throw new Error(`Salon ${change.id} nije ažuriran.`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const after = db.prepare('SELECT id, name, agent_id, services_json, barbers_json FROM salons ORDER BY id').all();
  if (after.length !== before.length || after.some((row, index) =>
    row.id !== before[index].id || row.agent_id !== before[index].agent_id ||
    row.barbers_json !== before[index].barbers_json)) {
    throw new Error('Provera identiteta salona ili radnika nije prošla.');
  }
  console.log(after.map((row) => `${row.name}: ${JSON.parse(row.barbers_json).join(', ')}; ${JSON.parse(row.services_json).join(', ')}`).join('\n'));
} finally {
  db.close();
}
