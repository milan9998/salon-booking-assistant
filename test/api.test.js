const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const port = 18887;
const base = `http://127.0.0.1:${port}`;
const secret = "test-secret";
let child;
let tempDir;
let adminToken;
let ownerToken;
let testSalonId;

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const { response } = await request("/health", { headers: { "x-agent-secret": secret } });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server se nije pokrenuo na vreme");
}

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(root, ".test-tmp-"));
  child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      BOOKING_API_SECRET: secret,
      ALLOW_LEGACY_SHARED_SECRET: "1",
      BOOKING_DB_FILE: path.join(tempDir, "appointments.db"),
      ADMIN_USER: "admin",
      ADMIN_PASSWORD: "test-only-admin-password-not-for-use",
    },
    stdio: "ignore",
  });
  await waitForServer();
});

test.after(async () => {
  if (child && !child.killed) {
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill();
    });
  }
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("login i zaštita API-ja", async () => {
  const bad = await request("/api/appointments");
  assert.equal(bad.response.status, 401);

  const login = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "test-only-admin-password-not-for-use" }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.ok, true);
  assert.equal(typeof login.body.token, "string");
  adminToken = login.body.token;
});

test("admin može dodati salon sa zasebnim agentom", async () => {
  const denied = await request("/api/admin/salons", { headers: { "x-agent-secret": secret } });
  assert.equal(denied.response.status, 403);

  const created = await request("/api/admin/salons", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "Salon Test",
      agent_id: "agent_test123",
      services: ["sisanje"],
      barbers: ["Ana"],
      knowledge_notes: "Test znanje ovog salona",
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.salon.name, "Salon Test");
  assert.equal(created.body.salon.agent_id, "agent_test123");
  assert.deepEqual(created.body.salon.barbers, ["Ana"]);
  testSalonId = created.body.salon.id;

  const list = await request("/api/admin/salons", { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(list.response.status, 200);
  assert.ok(list.body.salons.some((salon) => salon.id === created.body.salon.id));
});

test("vlasnik vidi samo svoj salon i nema administratorska prava", async () => {
  const created = await request("/api/admin/owners", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ salon_id: testSalonId, username: "owner_test" }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(typeof created.body.temporary_password, "string");
  const login = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username: "owner_test", password: created.body.temporary_password }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.role, "owner");
  ownerToken = login.body.token;
  const ownList = await request("/api/admin/salons", { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.deepEqual(ownList.body.salons.map((salon) => salon.id), [testSalonId]);
  const deniedCalendar = await request("/api/appointments?salon_id=default", { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(deniedCalendar.response.status, 403);
  const deniedCreate = await request("/api/admin/salons", {
    method: "POST", headers: { Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ name: "Tuđ salon" }),
  });
  assert.equal(deniedCreate.response.status, 403);
});

test("svaki salon ima odvojenu dostupnost i kalendar", async () => {
  const headers = { "x-agent-secret": secret, "x-salon-id": testSalonId };
  const available = await request("/api/check-availability", {
    method: "POST", headers, body: JSON.stringify({ date: "2031-04-15", service: "sisanje", barber: "Ana" }),
  });
  assert.equal(available.response.status, 200);
  const created = await request("/api/book-appointment", {
    method: "POST", headers, body: JSON.stringify({ date: "2031-04-15", time: "10:00", service: "sisanje", barber: "Ana", customer_name: "Salon Test", phone: "063222333" }),
  });
  assert.equal(created.response.status, 201);

  const adminCalendar = await request(`/api/appointments?salon_id=${encodeURIComponent(testSalonId)}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(adminCalendar.response.status, 200);
  assert.equal(adminCalendar.body.salon_id, testSalonId);
  assert.equal(adminCalendar.body.appointments.length, 1);

  // Webhook alat nikada ne sme da čita imena i telefone iz kalendara.
  const restrictedCalendar = await request(`/api/appointments?salon_id=${encodeURIComponent(testSalonId)}`, { headers: { "x-agent-secret": secret } });
  assert.equal(restrictedCalendar.response.status, 403);
  const crossSalon = await request("/api/check-availability", {
    method: "POST", headers, body: JSON.stringify({ salon_id: "default", date: "2031-04-15", service: "sisanje", barber: "Ana" }),
  });
  assert.equal(crossSalon.response.status, 404);
});

test("provera, zakazivanje, zauzetost i otkazivanje termina", async () => {
  const headers = { "x-agent-secret": secret };
  const booking = { date: "2031-04-15", time: "10:00", service: "sisanje", barber: "Marko", customer_name: "Test Korisnik", phone: "+381 63-111-222" };

  const available = await request("/api/check-availability", {
    method: "POST", headers, body: JSON.stringify({ date: booking.date, service: booking.service, barber: booking.barber, time: booking.time }),
  });
  assert.equal(available.response.status, 200);
  assert.equal(available.body.ok, true);
  assert.ok(available.body.available_slots.includes(booking.time));

  const created = await request("/api/book-appointment", { method: "POST", headers, body: JSON.stringify(booking) });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.appointment.status, "confirmed");

  // Isti korisnik ne može imati drugi aktivan termin istog dana u istom salonu,
  // čak ni kod drugog frizera ili u drugom vremenu.
  const sameDayDifferentSlot = await request("/api/book-appointment", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...booking, time: "11:00", barber: "Nikola" }),
  });
  assert.equal(sameDayDifferentSlot.response.status, 200);
  assert.equal(sameDayDifferentSlot.body.code, "CUSTOMER_WEEKLY_LIMIT");
  assert.equal(sameDayDifferentSlot.body.ok, false);
  assert.match(sameDayDifferentSlot.body.error, /sedam dana/);

  const prebookingLimit = await request("/api/check-availability", {
    method: "POST",
    headers,
    body: JSON.stringify({ date: booking.date, service: booking.service, barber: booking.barber, time: "11:00", phone: booking.phone }),
  });
  assert.equal(prebookingLimit.body.ok, false);
  assert.equal(prebookingLimit.body.code, "CUSTOMER_WEEKLY_LIMIT");
  assert.deepEqual(prebookingLimit.body.available_slots, []);
  assert.equal(prebookingLimit.body.next_eligible_date, "2031-04-22");
  assert.deepEqual(prebookingLimit.body.next_available_slot, { date: "2031-04-22", time: "09:00", barber: "Marko" });

  const afterBook = await request("/api/check-availability", {
    method: "POST", headers, body: JSON.stringify({ date: booking.date, service: booking.service, barber: booking.barber, time: booking.time }),
  });
  assert.ok(!afterBook.body.available_slots.includes(booking.time));
  assert.equal(afterBook.body.available_slots.length, 2);
  assert.deepEqual(afterBook.body.available_slots, ["09:30", "10:30"]);
  assert.equal(afterBook.body.requested_time_status, "SLOT_TAKEN");

  const duplicate = await request("/api/book-appointment", { method: "POST", headers, body: JSON.stringify(booking) });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.ok, false);
  assert.equal(duplicate.body.code, "CUSTOMER_WEEKLY_LIMIT");
  assert.equal(duplicate.body.next_eligible_date, "2031-04-22");

  const wrongPhone = await request("/api/cancel-appointment", {
    method: "POST", headers, body: JSON.stringify({ date: booking.date, time: booking.time, phone: "063999444" }),
  });
  assert.equal(wrongPhone.response.status, 404);
  const cancelled = await request("/api/cancel-appointment", {
    method: "POST", headers, body: JSON.stringify({ customer_name: "Pogrešno čuto ime", date: booking.date, time: booking.time, phone: "063111222" }),
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.ok, true);
  assert.equal(cancelled.body.appointment.status, "cancelled");

  // Otkazani termin više ne blokira isti slot; drugi korisnik može da ga zauzme.
  const rebooked = await request("/api/book-appointment", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...booking, customer_name: "Drugi Korisnik", phone: "063555666" }),
  });
  assert.equal(rebooked.response.status, 201);
  assert.equal(rebooked.body.ok, true);
  assert.equal(rebooked.body.appointment.status, "confirmed");

  // Posle jednog otkazivanja korisnik sme još jednom da rezerviše.
  const sameCustomerAgain = await request("/api/book-appointment", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...booking, time: "11:00", barber: "Nikola" }),
  });
  assert.equal(sameCustomerAgain.response.status, 201);
  assert.equal(sameCustomerAgain.body.ok, true);

  const secondCancelTooSoon = await request("/api/cancel-appointment", {
    method: "POST", headers, body: JSON.stringify({ customer_name: booking.customer_name, date: booking.date, time: "11:00", phone: booking.phone }),
  });
  assert.equal(secondCancelTooSoon.response.status, 200);
  assert.equal(secondCancelTooSoon.body.code, "CUSTOMER_WEEKLY_CANCEL_LIMIT");
  assert.equal(secondCancelTooSoon.body.ok, false);

  const ownerCancel = await request("/api/owner/cancel-appointment", {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ appointment_id: sameCustomerAgain.body.appointment.id }),
  });
  assert.equal(ownerCancel.response.status, 200);

  const sameCustomerNextWeek = await request("/api/book-appointment", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...booking, date: "2031-04-22", time: "10:00", barber: "Marko" }),
  });
  assert.equal(sameCustomerNextWeek.response.status, 201);

  const cancelNextWeek = await request("/api/cancel-appointment", {
    method: "POST",
    headers,
    body: JSON.stringify({ customer_name: booking.customer_name, date: "2031-04-22", time: "10:00", phone: booking.phone }),
  });
  assert.equal(cancelNextWeek.response.status, 200);
  assert.equal(cancelNextWeek.body.code, "CUSTOMER_WEEKLY_CANCEL_LIMIT");

  // Limit otkazivanja važi po telefonu; drugi korisnik nije blokiran.
  const otherCustomerCancel = await request("/api/cancel-appointment", {
    method: "POST",
    headers,
    body: JSON.stringify({ date: booking.date, time: booking.time, phone: "063555666" }),
  });
  assert.equal(otherCustomerCancel.response.status, 200);

  const repeatedCancel = await request("/api/cancel-appointment", {
    method: "POST", headers, body: JSON.stringify({ customer_name: booking.customer_name, date: booking.date, time: booking.time, phone: booking.phone }),
  });
  assert.equal(repeatedCancel.response.status, 404);

  const appointments = await request("/api/appointments", { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(appointments.response.status, 200);
  assert.equal(appointments.body.appointments[0].status, "cancelled");
});

test("login stranica se servira", async () => {
  const response = await fetch(`${base}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Salon termini/);
  assert.match(html, /loginForm/);
  assert.match(html, /callAgentBtn/);
  assert.match(html, /agentWidgetHost/);
});

test("otkazivanje ne bira nasumično kada isti broj ima dva termina u isto vreme", async () => {
  const db = new DatabaseSync(path.join(tempDir, "appointments.db"));
  const insert = db.prepare(`INSERT INTO appointments
    (id,status,salon_id,date,time,service,barber,customer_name,phone,created_at)
    VALUES (?, 'confirmed', 'default', '2031-04-16', '10:00', 'sisanje', ?, ?, '063777888', ?)`);
  insert.run('BR-AMB001', 'Marko', 'Milan', new Date().toISOString());
  insert.run('BR-AMB002', 'Nikola', 'Miljan', new Date().toISOString());
  db.close();

  const result = await request("/api/cancel-appointment", {
    method: "POST",
    headers: { "x-agent-secret": secret },
    body: JSON.stringify({ date: "2031-04-16", time: "10:00", phone: "063777888" }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.code, "APPOINTMENT_AMBIGUOUS");
  const check = new DatabaseSync(path.join(tempDir, "appointments.db"), { readOnly: true });
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM appointments WHERE id IN ('BR-AMB001','BR-AMB002') AND status = 'confirmed'").get().n, 2);
  check.close();
});

test("prošlost, neradni dan i pauza nisu ponuđeni kao termini", async () => {
  const headers = { "x-agent-secret": secret, "x-salon-id": testSalonId };
  const past = await request("/api/check-availability", {
    method: "POST", headers, body: JSON.stringify({ date: "2000-01-01", service: "sisanje", barber: "Ana" }),
  });
  assert.equal(past.response.status, 200);
  assert.equal(past.body.code, "PAST_DATE");
  assert.deepEqual(past.body.available_slots, []);
  assert.match(past.body.reason, /prošlosti/);

  const schedule = { weekdays: [1, 2, 3, 4, 5, 6], start: "10:00", end: "12:00", breaks: [{ start: "10:30", end: "11:00" }], staff: {} };
  const updated = await request(`/api/salons/${testSalonId}/schedule`, {
    method: "PATCH", headers: { Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ schedule }),
  });
  assert.equal(updated.response.status, 200);
  const available = await request("/api/check-availability", {
    method: "POST", headers, body: JSON.stringify({ date: "2031-04-15", service: "sisanje", barber: "Ana" }),
  });
  assert.deepEqual(available.body.available_slots, ["11:00", "11:30"]);
  assert.ok(!available.body.available_slots.includes("10:30"));
  assert.ok(!available.body.available_slots.includes("09:00"));

  const needsStaff = await request("/api/check-availability", {
    method: "POST", headers, body: JSON.stringify({ date: "2031-04-15", service: "sisanje", time: "12:00" }),
  });
  assert.equal(needsStaff.body.code, "NEED_STAFF");
  assert.ok(needsStaff.body.available_staff.includes("Ana"));

  const outside = await request("/api/check-availability", {
    method: "POST", headers, body: JSON.stringify({ date: "2031-04-15", service: "sisanje", barber: "Ana", time: "18:00" }),
  });
  assert.equal(outside.body.requested_time_status, "OUTSIDE_HOURS");
  assert.match(outside.body.reason, /10:00 do 12:00/);
  assert.equal(outside.body.working_hours.last_start, "11:30");

  const pause = await request("/api/check-availability", {
    method: "POST", headers, body: JSON.stringify({ date: "2031-04-15", service: "sisanje", barber: "Ana", time: "10:30" }),
  });
  assert.equal(pause.body.requested_time_status, "ON_BREAK");
  assert.match(pause.body.reason, /10:30 do 11:00/);

  const blocked = await request("/api/book-appointment", {
    method: "POST", headers,
    body: JSON.stringify({ date: "2031-04-15", time: "10:30", service: "sisanje", barber: "Ana", customer_name: "Pauza", phone: "063999888" }),
  });
  assert.equal(blocked.response.status, 200);
  assert.equal(blocked.body.code, "ON_BREAK");

  const tooLate = await request("/api/book-appointment", {
    method: "POST", headers,
    body: JSON.stringify({ date: "2031-04-15", time: "18:00", service: "sisanje", barber: "Ana", customer_name: "Kasno", phone: "063999777" }),
  });
  assert.equal(tooLate.body.code, "OUTSIDE_HOURS");
  assert.match(tooLate.body.error, /10:00 do 12:00/);

  const staffSchedule = { ...schedule, staff: { Ana: { weekdays: [1, 2, 3, 4, 5, 6], start: "13:00", end: "14:00", breaks: [] } } };
  const updatedStaff = await request(`/api/salons/${testSalonId}/schedule`, {
    method: "PATCH", headers: { Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ schedule: staffSchedule }),
  });
  assert.equal(updatedStaff.response.status, 200);
  const staffSlots = await request("/api/check-availability", {
    method: "POST", headers, body: JSON.stringify({ date: "2031-04-15", service: "sisanje", barber: "Ana" }),
  });
  assert.deepEqual(staffSlots.body.available_slots, ["13:00", "13:30"]);

  const deniedForeignSchedule = await request("/api/salons/default/schedule", {
    method: "PATCH", headers: { Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ schedule }),
  });
  assert.equal(deniedForeignSchedule.response.status, 403);
});

test("zasebna tajna salona ne može pristupiti tuđem salonu", async () => {
  const isolatedSecret = "isolated-test-secret";
  const db = new DatabaseSync(path.join(tempDir, "appointments.db"));
  db.prepare("UPDATE salons SET webhook_secret_hash = ?, webhook_secret_id = ? WHERE id = ?")
    .run(crypto.createHash("sha256").update(isolatedSecret).digest("hex"), "test-secret-id", testSalonId);
  db.close();
  const body = JSON.stringify({ date: "2031-04-15", service: "sisanje", barber: "Ana" });
  const oldShared = await request("/api/check-availability", {
    method: "POST", headers: { "x-salon-id": testSalonId, "x-agent-secret": secret }, body,
  });
  assert.equal(oldShared.response.status, 401);
  const own = await request("/api/check-availability", {
    method: "POST", headers: { "x-salon-id": testSalonId, "x-agent-secret": isolatedSecret }, body,
  });
  assert.equal(own.response.status, 200);
  const other = await request("/api/check-availability", {
    method: "POST", headers: { "x-salon-id": "default", "x-agent-secret": isolatedSecret }, body,
  });
  assert.equal(other.response.status, 401);
});

test("vlasnik otkazuje samo termin svog salona", async () => {
  const ownCalendar = await request(`/api/appointments?salon_id=${testSalonId}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const own = ownCalendar.body.appointments.find((item) => item.status === "confirmed");
  assert.ok(own);
  const cancelled = await request("/api/owner/cancel-appointment", {
    method: "POST", headers: { Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ appointment_id: own.id }),
  });
  assert.equal(cancelled.response.status, 200);
  const ownAfter = await request(`/api/appointments?salon_id=${testSalonId}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(ownAfter.body.appointments.find((item) => item.id === own.id).cancelled_by, "owner");
  const foreignCalendar = await request("/api/appointments?salon_id=default", { headers: { Authorization: `Bearer ${adminToken}` } });
  const foreign = foreignCalendar.body.appointments.find((item) => item.status === "confirmed");
  assert.ok(foreign);
  const denied = await request("/api/owner/cancel-appointment", {
    method: "POST", headers: { Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ appointment_id: foreign.id }),
  });
  assert.equal(denied.response.status, 403);
});
