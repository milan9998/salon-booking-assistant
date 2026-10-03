const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { provisionSalon } = require("./scripts/provision-salon");

const PORT = Number(process.env.PORT || 8787);
const API_SECRET = process.env.BOOKING_API_SECRET || "";
const DB_FILE = process.env.BOOKING_DB_FILE || path.join(__dirname, "appointments.db");
const STATIC_ROOT = path.join(__dirname, "public");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DEFAULT_SALON_ID = process.env.DEFAULT_SALON_ID || "default";
const DEFAULT_SALON_NAME = process.env.DEFAULT_SALON_NAME || "Frizerski salon LIBE";
const DEFAULT_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || "";
const sessions = new Map();
const loginAttempts = new Map();
if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD mora biti podešen u .env");

const SERVICES = {
  sisanje: { label: "Šišanje", durationMinutes: 30 },
  brada: { label: "Sređivanje brade", durationMinutes: 30 },
  "sisanje-i-brada": { label: "Šišanje i brada", durationMinutes: 60 },
  feniranje: { label: "Feniranje", durationMinutes: 30 },
  farbanje: { label: "Farbanje", durationMinutes: 90 },
  manikir: { label: "Manikir", durationMinutes: 45 },
  pedikir: { label: "Pedikir", durationMinutes: 45 },
  "tretman-lica": { label: "Tretman lica", durationMinutes: 60 },
  "relaks-masaza": { label: "Relaks masaža", durationMinutes: 60 },
  "sportska-masaza": { label: "Sportska masaža", durationMinutes: 60 },
  "masaza-ledja": { label: "Masaža leđa", durationMinutes: 30 },
};
// Keep legacy definitions for historic appointments, but only offer hair services now.
const HAIR_SERVICES = ["sisanje", "brada", "sisanje-i-brada", "feniranje", "farbanje"];

const BARBERS = ["Marko", "Nikola"];
const DEFAULT_SCHEDULE = { weekdays: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00", breaks: [], staff: {} };
let writeQueue = Promise.resolve();
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS salons (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT 'Europe/Belgrade',
    services_json TEXT NOT NULL DEFAULT '["sisanje","brada","sisanje-i-brada"]',
    barbers_json TEXT NOT NULL DEFAULT '["Marko","Nikola"]',
    knowledge_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    salon_id TEXT NOT NULL DEFAULT 'default',
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    service TEXT NOT NULL,
    barber TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TEXT NOT NULL,
    cancelled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS owner_accounts (
    username TEXT PRIMARY KEY,
    salon_id TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

// Migrate databases created before multi-salon support.
const appointmentColumns = db.prepare("PRAGMA table_info(appointments)").all();
if (!appointmentColumns.some((column) => column.name === "salon_id")) {
  db.exec("ALTER TABLE appointments ADD COLUMN salon_id TEXT NOT NULL DEFAULT 'default'");
}
if (!appointmentColumns.some((column) => column.name === "cancelled_at")) {
  db.exec("ALTER TABLE appointments ADD COLUMN cancelled_at TEXT");
}
if (!appointmentColumns.some((column) => column.name === "cancelled_by")) {
  db.exec("ALTER TABLE appointments ADD COLUMN cancelled_by TEXT");
}
const salonColumns = db.prepare("PRAGMA table_info(salons)").all();
if (!salonColumns.some((column) => column.name === "webhook_secret_hash")) {
  db.exec("ALTER TABLE salons ADD COLUMN webhook_secret_hash TEXT");
}
if (!salonColumns.some((column) => column.name === "webhook_secret_id")) {
  db.exec("ALTER TABLE salons ADD COLUMN webhook_secret_id TEXT");
}
if (!salonColumns.some((column) => column.name === "schedule_json")) {
  db.exec("ALTER TABLE salons ADD COLUMN schedule_json TEXT NOT NULL DEFAULT '{\"weekdays\":[1,2,3,4,5,6],\"start\":\"09:00\",\"end\":\"18:00\",\"breaks\":[],\"staff\":{}}'");
}
if (!salonColumns.some((column) => column.name === "integration_ready")) {
  db.exec("ALTER TABLE salons ADD COLUMN integration_ready INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE salons SET integration_ready = 1 WHERE webhook_secret_id IS NOT NULL");
}
db.exec("CREATE INDEX IF NOT EXISTS appointments_salon_date_idx ON appointments(salon_id, date, time)");
db.prepare(`
  INSERT OR IGNORE INTO salons
    (id, name, agent_id, timezone, services_json, barbers_json, knowledge_notes, created_at)
  VALUES (?, ?, ?, 'Europe/Belgrade', ?, ?, '', ?)
`).run(
  DEFAULT_SALON_ID,
  DEFAULT_SALON_NAME,
  DEFAULT_AGENT_ID,
  JSON.stringify(["sisanje", "brada", "sisanje-i-brada"]),
  JSON.stringify(BARBERS),
  new Date().toISOString(),
);
// Keep the built-in salon mapped to the manually created ElevenLabs agent when
// ELEVENLABS_AGENT_ID is supplied after the first database boot.
if (DEFAULT_AGENT_ID) {
  db.prepare("UPDATE salons SET agent_id = ? WHERE id = ? AND (agent_id = '' OR agent_id IS NULL)").run(DEFAULT_AGENT_ID, DEFAULT_SALON_ID);
}

function parseJsonList(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return Array.isArray(parsed) ? parsed.map((item) => String(item).trim()).filter(Boolean) : fallback;
  } catch {
    return fallback;
  }
}

function parseSchedule(value) {
  try {
    const parsed = value ? JSON.parse(value) : DEFAULT_SCHEDULE;
    return {
      weekdays: parsed.weekdays || DEFAULT_SCHEDULE.weekdays,
      start: parsed.start || DEFAULT_SCHEDULE.start,
      end: parsed.end || DEFAULT_SCHEDULE.end,
      breaks: parsed.breaks || [],
      staff: parsed.staff || {},
    };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

function validScheduleWindow(value) {
  return value && Array.isArray(value.weekdays) && value.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
    validTime(value.start) && validTime(value.end) && minutes(value.start) < minutes(value.end) &&
    Array.isArray(value.breaks) && value.breaks.every((item) => item && validTime(item.start) && validTime(item.end) &&
      minutes(item.start) < minutes(item.end) && minutes(item.start) >= minutes(value.start) && minutes(item.end) <= minutes(value.end));
}

function validSchedule(value, salon) {
  if (!validScheduleWindow(value) || !value.staff || typeof value.staff !== "object" || Array.isArray(value.staff)) return false;
  return Object.entries(value.staff).every(([name, window]) => salonBarbers(salon).includes(name) && validScheduleWindow(window));
}

function salonServices(salon) {
  return parseJsonList(salon.services_json, HAIR_SERVICES).filter((id) => HAIR_SERVICES.includes(id));
}

function salonBarbers(salon) {
  return parseJsonList(salon.barbers_json, BARBERS);
}

function serializeSalon(row) {
  return {
    id: row.id,
    name: row.name,
    agent_id: row.agent_id,
    timezone: row.timezone,
    services: salonServices(row),
    barbers: salonBarbers(row),
    knowledge_notes: row.knowledge_notes,
    schedule: parseSchedule(row.schedule_json),
    integration_ready: Boolean(row.integration_ready),
    created_at: row.created_at,
  };
}

function getSalon(id = DEFAULT_SALON_ID) {
  const row = db.prepare("SELECT id,name,agent_id,timezone,services_json,barbers_json,knowledge_notes,schedule_json,webhook_secret_id,integration_ready,created_at FROM salons WHERE id = ?").get(id);
  return row || null;
}

function listSalons() {
  return db.prepare("SELECT id,name,agent_id,timezone,services_json,barbers_json,knowledge_notes,schedule_json,webhook_secret_id,integration_ready,created_at FROM salons ORDER BY name").all().map(serializeSalon);
}

function requestSalon(request, body = {}, auth = null) {
  const fromHeader = String(request.headers["x-salon-id"] || "").trim();
  const fromBody = String(body.salon_id || "").trim();
  if (auth?.kind === "owner" || auth?.kind === "tool") {
    if ((fromHeader && fromHeader !== auth.salonId) || (fromBody && fromBody !== auth.salonId)) return null;
    return getSalon(auth.salonId);
  }
  return getSalon(fromHeader || fromBody || DEFAULT_SALON_ID);
}

function inputList(value, fallback) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function createSalonId(name) {
  const base = String(name || "salon")
    .toLocaleLowerCase("sr-Latn")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "salon";
  let id = base;
  let suffix = 2;
  while (getSalon(id)) id = `${base}-${suffix++}`;
  return id;
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type,authorization,x-agent-secret,x-salon-id",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("Request body is too large");
  }
  return raw ? JSON.parse(raw) : {};
}

async function readAppointments(salonId = null) {
  if (salonId) {
    return db.prepare("SELECT id,status,salon_id,date,time,service,barber,customer_name,phone,created_at,cancelled_at,cancelled_by FROM appointments WHERE salon_id = ? ORDER BY date,time").all(salonId);
  }
  return db.prepare("SELECT id,status,salon_id,date,time,service,barber,customer_name,phone,created_at,cancelled_at,cancelled_by FROM appointments ORDER BY date,time").all();
}

function normalizeService(value, salon = null) {
  const text = String(value || "").toLocaleLowerCase("sr-Latn");
  const allowed = salon ? new Set(salonServices(salon)) : new Set(Object.keys(SERVICES));
  if (text.includes("brad") && text.includes("sis") && allowed.has("sisanje-i-brada")) return "sisanje-i-brada";
  if (text.includes("brad") && text.includes("šiš") && allowed.has("sisanje-i-brada")) return "sisanje-i-brada";
  if (text.includes("brad") && allowed.has("brada")) return "brada";
  if ((text.includes("sis") || text.includes("šiš")) && allowed.has("sisanje")) return "sisanje";
  if (text.includes("fenir") && allowed.has("feniranje")) return "feniranje";
  if (text.includes("farb") && allowed.has("farbanje")) return "farbanje";
  return allowed.has(text) ? text : null;
}

function normalizeBarber(value, salon = null) {
  const allowed = salon ? salonBarbers(salon) : BARBERS;
  const match = allowed.find(
    (name) => name.toLocaleLowerCase("sr-Latn") === String(value || "").toLocaleLowerCase("sr-Latn"),
  );
  return match || null;
}

function validDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function calendarDayDistance(firstDate, secondDate) {
  const first = Date.parse(`${firstDate}T00:00:00Z`);
  const second = Date.parse(`${secondDate}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return Number.POSITIVE_INFINITY;
  return Math.abs(second - first) / 86_400_000;
}

function addCalendarDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function validTime(value) {
  return /^(?:0\d|1\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function normalizePhone(value) {
  // Compare phone numbers by digits so spaces, dashes and a leading + do not matter.
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  // Serbia: accept both local 06x and international +381 6x notation.
  if (digits.startsWith("3816")) digits = `0${digits.slice(3)}`;
  return digits;
}

function normalizeCustomerName(value) {
  return String(value || "").trim().replace(/\s+/g, " ")
    .toLocaleLowerCase("sr-Latn")
    .replace(/đ/g, "dj")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function validSerbianMobile(value) {
  // Local Serbian mobile numbers start with 06 and contain 9 or 10 digits.
  return /^06\d{7,8}$/.test(normalizePhone(value));
}

function minutes(time) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function clockTime(totalMinutes) {
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

function localClock(timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function scheduleWindow(salon, barber) {
  const schedule = parseSchedule(salon.schedule_json);
  return schedule.staff[barber] || schedule;
}

function dateAvailabilityReason(date, salon) {
  const today = localClock(salon.timezone).date;
  if (date < today) return "Ne zakazujemo termine u prošlosti.";
  return null;
}

function slotRuleStatus(time, durationMinutes, date, barber, salon) {
  const start = minutes(time);
  const window = scheduleWindow(salon, barber);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const pastDate = dateAvailabilityReason(date, salon);
  if (pastDate) return { code: "PAST_DATE", reason: pastDate };
  if (!window.weekdays.includes(weekday)) return { code: "CLOSED_DAY", reason: `${barber} ne radi tog dana.` };
  if (start % 30 !== 0) return { code: "INVALID_TIME", reason: "Termini počinju na pun sat ili pola sata." };
  if (start < minutes(window.start) || start + durationMinutes > minutes(window.end)) {
    const lastStartMinutes = minutes(window.end) - durationMinutes;
    const detail = lastStartMinutes >= minutes(window.start)
      ? `Za ovu uslugu poslednji početak termina je ${clockTime(lastStartMinutes)}.`
      : "Za ovu uslugu nema dovoljno vremena u današnjem rasporedu.";
    return { code: "OUTSIDE_HOURS", reason: `Radno vreme za ${barber} je od ${window.start} do ${window.end}. ${detail}` };
  }
  const pause = window.breaks.find((item) => start < minutes(item.end) && minutes(item.start) < start + durationMinutes);
  if (pause) return { code: "ON_BREAK", reason: `${barber} ima pauzu od ${pause.start} do ${pause.end}.` };
  const now = localClock(salon.timezone);
  if (date === now.date && start <= minutes(now.time)) return { code: "PAST_TIME", reason: "To vreme je već prošlo." };
  return { code: "AVAILABLE", reason: "Traženo vreme je u radnom vremenu." };
}

function validSlot(time, durationMinutes, date, barber, salon) {
  return slotRuleStatus(time, durationMinutes, date, barber, salon).code === "AVAILABLE";
}

function requestedSlotStatus(appointments, date, time, barber, service, salon) {
  const duration = SERVICES[service].durationMinutes;
  const rule = slotRuleStatus(time, duration, date, barber, salon);
  if (rule.code !== "AVAILABLE") return rule;
  if (appointments.some((item) => overlaps(item, date, time, barber, duration, salon.id))) {
    return { code: "SLOT_TAKEN", reason: "Taj termin je već zauzet." };
  }
  return { code: "AVAILABLE", reason: "Traženi termin je slobodan." };
}

function overlaps(existing, date, time, barber, durationMinutes, salonId = DEFAULT_SALON_ID) {
  if (existing.status !== "confirmed" || existing.salon_id !== salonId || existing.date !== date || existing.barber !== barber) return false;
  const requestedStart = minutes(time);
  const requestedEnd = requestedStart + durationMinutes;
  const existingStart = minutes(existing.time);
  const existingDuration = SERVICES[existing.service]?.durationMinutes || 30;
  const existingEnd = existingStart + existingDuration;
  return requestedStart < existingEnd && existingStart < requestedEnd;
}

function availableSlots(appointments, date, barber, service, salon) {
  const duration = SERVICES[service].durationMinutes;
  const slots = [];
  const window = scheduleWindow(salon, barber);
  for (let start = minutes(window.start); start + duration <= minutes(window.end); start += 30) {
    const time = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
    if (validSlot(time, duration, date, barber, salon) && !appointments.some((item) => overlaps(item, date, time, barber, duration, salon.id))) slots.push(time);
  }
  return slots;
}

function nearestAvailableSlots(slots, requestedTime, requestedStatus) {
  if (!requestedTime) return slots.slice(0, 2);
  if (requestedStatus?.code === "AVAILABLE") return [requestedTime];
  const target = minutes(requestedTime);
  return [...slots]
    .sort((left, right) => Math.abs(minutes(left) - target) - Math.abs(minutes(right) - target) || left.localeCompare(right))
    .slice(0, 2);
}

function sessionFor(request) {
  const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (token && session && session.expiresAt > Date.now()) return session;
  if (token) sessions.delete(token);
  return null;
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function secureEqualHex(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function passwordHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function authContext(request) {
  const session = sessionFor(request);
  if (session) return session;
  const salonId = String(request.headers["x-salon-id"] || DEFAULT_SALON_ID).trim();
  const provided = String(request.headers["x-agent-secret"] || "");
  if (!provided || !getSalon(salonId)) return null;
  const stored = db.prepare("SELECT webhook_secret_hash FROM salons WHERE id = ?").get(salonId);
  if (stored?.webhook_secret_hash) {
    if (secureEqualHex(hashSecret(provided), stored.webhook_secret_hash)) return { kind: "tool", salonId };
    return null;
  }
  // Legacy shared-secret mode is test-only and off in the live multi-salon app.
  if (process.env.ALLOW_LEGACY_SHARED_SECRET === "1" && API_SECRET &&
      secureEqualHex(hashSecret(provided), hashSecret(API_SECRET))) return { kind: "tool", salonId };
  return null;
}

function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes("..")) return false;
  const file = path.join(STATIC_ROOT, relative);
  if (!file.startsWith(STATIC_ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  response.end(fs.readFileSync(file));
  return true;
}

async function appendAppointment(appointment) {
  const operation = writeQueue.catch(() => {}).then(async () => {
    const appointments = await readAppointments();
    const duration = SERVICES[appointment.service].durationMinutes;
    const recentCustomerAppointment = findWeeklyBookingConflict(appointments, appointment.salon_id, appointment.date, appointment.phone);
    if (recentCustomerAppointment) {
      const error = new Error("Za ovaj broj telefona već postoji rezervacija u ovom salonu u periodu od sedam dana. Novi termin je moguće zakazati najmanje sedam dana od datuma te rezervacije.");
      error.code = "CUSTOMER_WEEKLY_LIMIT";
      throw error;
    }
    if (appointments.some((item) => overlaps(item, appointment.date, appointment.time, appointment.barber, duration, appointment.salon_id))) {
      const error = new Error("Termin je u medjuvremenu zauzet");
      error.code = "SLOT_TAKEN";
      throw error;
    }
    db.prepare(`INSERT INTO appointments
      (id,status,salon_id,date,time,service,barber,customer_name,phone,created_at)
      VALUES (@id,@status,@salon_id,@date,@time,@service,@barber,@customer_name,@phone,@created_at)`)
      .run(appointment);
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function findWeeklyBookingConflict(appointments, salonId, date, phone) {
  const requestedPhone = normalizePhone(phone);
  if (!requestedPhone) return null;
  return appointments.find((item) =>
    item.status === "confirmed" &&
    item.salon_id === salonId &&
    normalizePhone(item.phone) === requestedPhone &&
    calendarDayDistance(item.date, date) < 7,
  ) || null;
}

function nextEligibleBookingDate(appointments, salonId, requestedDate, phone) {
  let candidate = requestedDate;
  const confirmed = appointments.filter((item) =>
    item.status === "confirmed" && item.salon_id === salonId && normalizePhone(item.phone) === normalizePhone(phone));
  for (let attempt = 0; attempt <= confirmed.length; attempt += 1) {
    const conflict = confirmed.find((item) => calendarDayDistance(item.date, candidate) < 7);
    if (!conflict) return candidate;
    candidate = addCalendarDays(conflict.date, 7);
  }
  return null;
}

function nextAvailableBookingSlot(appointments, salon, firstDate, barber, service) {
  if (!firstDate || !barber || !service) return null;
  for (let offset = 0; offset < 90; offset += 1) {
    const date = addCalendarDays(firstDate, offset);
    const time = availableSlots(appointments, date, barber, service, salon)[0];
    if (time) return { date, time, barber };
  }
  return null;
}

function weeklyLimitDetails(appointments, salon, requestedDate, phone, barber, service) {
  const nextEligibleDate = nextEligibleBookingDate(appointments, salon.id, requestedDate, phone);
  return {
    next_eligible_date: nextEligibleDate,
    next_available_slot: nextAvailableBookingSlot(appointments, salon, nextEligibleDate, barber, service),
  };
}

async function cancelAppointment({ salon_id: salonId, date, time, phone }) {
  const requestedPhone = normalizePhone(phone);
  const operation = writeQueue.catch(() => {}).then(async () => {
    const matches = db.prepare(
      "SELECT id,status,salon_id,date,time,service,barber,customer_name,phone,created_at,cancelled_at FROM appointments WHERE status = 'confirmed' AND salon_id = ? AND date = ? AND time = ?",
    ).all(salonId, date, time).filter((item) => normalizePhone(item.phone) === requestedPhone);

    if (matches.length === 0) {
      const error = new Error("Nije pronađen potvrđen termin za taj datum, vreme i broj telefona. Molim vas proverite podatke.");
      error.code = "APPOINTMENT_NOT_FOUND";
      throw error;
    }
    if (matches.length > 1) {
      const error = new Error("Pronađeno je više termina sa tim podacima. Molim vas kontaktirajte salon da vlasnik proveri i otkaže tačan termin.");
      error.code = "APPOINTMENT_AMBIGUOUS";
      throw error;
    }

    const recentCancellation = db.prepare(
      "SELECT cancelled_at,phone FROM appointments WHERE status = 'cancelled' AND salon_id = ? AND cancelled_at IS NOT NULL AND (cancelled_by = 'customer' OR cancelled_by IS NULL)",
    ).all(salonId).find((item) => {
      const cancellationTime = Date.parse(String(item.cancelled_at || ""));
      return normalizePhone(item.phone) === requestedPhone && Number.isFinite(cancellationTime) && Date.now() - cancellationTime < 7 * 86_400_000;
    });
    if (recentCancellation) {
      const error = new Error("Već ste jednom otkazali termin u poslednjih sedam dana. Za novo otkazivanje molim vas kontaktirajte salon; vlasnik može da vam pomogne.");
      error.code = "CUSTOMER_WEEKLY_CANCEL_LIMIT";
      throw error;
    }

    const cancelledAt = new Date().toISOString();
    db.prepare("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'customer' WHERE id = ? AND status = 'confirmed'").run(cancelledAt, matches[0].id);
    return { ...matches[0], status: "cancelled", cancelled_at: cancelledAt, cancelled_by: "customer" };
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return json(response, 204, {});
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(request);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const clientId = String(request.headers["cf-connecting-ip"] || request.socket.remoteAddress || "unknown");
      const attempt = loginAttempts.get(clientId);
      if (attempt && attempt.until > Date.now() && attempt.count >= 5) {
        return json(response, 429, { ok: false, error: "Previše pokušaja. Pokušajte za 15 minuta." });
      }
      let identity = null;
      if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
        identity = { kind: "platform", username };
      } else {
        const account = db.prepare("SELECT username,salon_id,password_salt,password_hash FROM owner_accounts WHERE username = ?").get(username);
        if (account && secureEqualHex(passwordHash(password, account.password_salt), account.password_hash)) {
          identity = { kind: "owner", username, salonId: account.salon_id };
        }
      }
      if (!identity) {
        loginAttempts.set(clientId, { count: (attempt?.until > Date.now() ? attempt.count : 0) + 1, until: Date.now() + 15 * 60_000 });
        return json(response, 401, { ok: false, error: "Pogrešno korisničko ime ili lozinka" });
      }
      loginAttempts.delete(clientId);
      const token = crypto.randomBytes(24).toString("hex");
      sessions.set(token, { ...identity, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
      return json(response, 200, { ok: true, token, user: username, role: identity.kind, salon_id: identity.salonId || null });
    }

    if (request.method === "GET" && serveStatic(response, url.pathname)) return;
    const auth = authContext(request);
    if (!auth) return json(response, 401, { ok: false, error: "Unauthorized" });

    if (request.method === "GET" && url.pathname === "/api/me") {
      if (auth.kind === "tool") return json(response, 403, { ok: false, error: "Session required" });
      return json(response, 200, { ok: true, user: auth.username, role: auth.kind, salon_id: auth.salonId || null });
    }

    if (request.method === "POST" && url.pathname === "/api/account/password") {
      if (auth.kind !== "owner") return json(response, 403, { ok: false, error: "Vlasnički nalog je obavezan" });
      const body = await readBody(request);
      const currentPassword = String(body.current_password || "");
      const newPassword = String(body.new_password || "");
      const account = db.prepare("SELECT password_salt,password_hash FROM owner_accounts WHERE username = ?").get(auth.username);
      if (!account || !secureEqualHex(passwordHash(currentPassword, account.password_salt), account.password_hash)) {
        return json(response, 403, { ok: false, error: "Trenutna lozinka nije tačna" });
      }
      if (newPassword.length < 14 || newPassword.length > 200) {
        return json(response, 400, { ok: false, error: "Nova lozinka mora imati najmanje 14 znakova" });
      }
      const salt = crypto.randomBytes(16).toString("hex");
      db.prepare("UPDATE owner_accounts SET password_salt = ?, password_hash = ? WHERE username = ?")
        .run(salt, passwordHash(newPassword, salt), auth.username);
      return json(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true, storage: "appointments.db", database: "sqlite", salons: listSalons().length });
    }

    if (url.pathname === "/api/admin/salons" && (request.method === "GET" || request.method === "POST")) {
      if (auth.kind === "tool") return json(response, 403, { ok: false, error: "Session required" });
      if (request.method === "GET") {
        const salons = auth.kind === "platform" ? listSalons() : [getSalon(auth.salonId)].filter(Boolean).map(serializeSalon);
        return json(response, 200, { ok: true, salons });
      }
      if (auth.kind !== "platform") return json(response, 403, { ok: false, error: "Platform admin required" });

      const body = await readBody(request);
      const name = String(body.name || "").trim();
      const agentId = String(body.agent_id || "").trim();
      if (!name || name.length > 120) return json(response, 400, { ok: false, error: "Naziv salona je obavezan (do 120 karaktera)" });
      if (!/^agent_[A-Za-z0-9]+$/.test(agentId)) return json(response, 400, { ok: false, error: "Unesite važeći ElevenLabs agent_id" });

      const services = inputList(body.services, HAIR_SERVICES).filter((id) => HAIR_SERVICES.includes(id));
      const barbers = inputList(body.barbers, BARBERS).slice(0, 20);
      if (!services.length || !barbers.length) return json(response, 400, { ok: false, error: "Salon mora imati bar jedan servis i jednog frizera" });

      const salon = {
        id: createSalonId(name),
        name,
        agent_id: agentId,
        timezone: String(body.timezone || "Europe/Belgrade"),
        services_json: JSON.stringify(services),
        barbers_json: JSON.stringify(barbers),
        knowledge_notes: String(body.knowledge_notes || "").trim().slice(0, 20_000),
        created_at: new Date().toISOString(),
      };
      db.prepare(`
        INSERT INTO salons (id,name,agent_id,timezone,services_json,barbers_json,knowledge_notes,created_at)
        VALUES (@id,@name,@agent_id,@timezone,@services_json,@barbers_json,@knowledge_notes,@created_at)
      `).run(salon);
      return json(response, 201, { ok: true, salon: serializeSalon(salon) });
    }

    if (request.method === "POST" && url.pathname === "/api/admin/owners") {
      if (auth.kind !== "platform") return json(response, 403, { ok: false, error: "Platform admin required" });
      const body = await readBody(request);
      const salonId = String(body.salon_id || "").trim();
      const username = String(body.username || "").trim().toLowerCase();
      if (!getSalon(salonId) || !/^[a-z0-9._-]{4,50}$/.test(username) || username === ADMIN_USER.toLowerCase()) {
        return json(response, 400, { ok: false, error: "Potreban je postojeći salon i jedinstveno korisničko ime (4–50 znakova)" });
      }
      if (db.prepare("SELECT 1 FROM owner_accounts WHERE username = ?").get(username)) {
        return json(response, 409, { ok: false, error: "Korisničko ime već postoji" });
      }
      const temporaryPassword = crypto.randomBytes(18).toString("base64url");
      const salt = crypto.randomBytes(16).toString("hex");
      db.prepare("INSERT INTO owner_accounts (username,salon_id,password_salt,password_hash,created_at) VALUES (?,?,?,?,?)")
        .run(username, salonId, salt, passwordHash(temporaryPassword, salt), new Date().toISOString());
      return json(response, 201, { ok: true, username, salon_id: salonId, temporary_password: temporaryPassword });
    }

    if (request.method === "POST" && /^\/api\/admin\/salons\/[^/]+\/provision$/.test(url.pathname)) {
      if (auth.kind !== "platform") return json(response, 403, { ok: false, error: "Platform admin required" });
      const salonId = decodeURIComponent(url.pathname.split("/")[4]);
      const salon = getSalon(salonId);
      if (!salon) return json(response, 404, { ok: false, error: "Salon nije pronađen" });
      if (salon.integration_ready) return json(response, 200, { ok: true, already_ready: true });
      try {
        const result = await provisionSalon(db, salon, salonServices(salon), salonBarbers(salon));
        return json(response, 200, { ok: true, ...result });
      } catch (error) {
        return json(response, 502, { ok: false, error: error.message });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/services") {
      const salon = getSalon(auth.salonId || DEFAULT_SALON_ID);
      return json(response, 200, {
        ok: true,
        salon: salon ? serializeSalon(salon) : null,
        services: Object.entries(SERVICES).filter(([id]) => !salon || salonServices(salon).includes(id)).map(([id, item]) => ({ id, ...item })),
        barbers: salon ? salonBarbers(salon) : [],
      });
    }

    if (request.method === "GET" && url.pathname === "/api/appointments") {
      if (auth.kind === "tool") return json(response, 403, { ok: false, error: "Owner session required" });
      let salonId = auth.salonId || DEFAULT_SALON_ID;
      const requestedSalonId = String(url.searchParams.get("salon_id") || "").trim();
      if (requestedSalonId && auth.kind === "platform") salonId = requestedSalonId;
      if (requestedSalonId && auth.kind === "owner" && requestedSalonId !== auth.salonId) {
        return json(response, 403, { ok: false, error: "Salon nije dostupan ovom nalogu" });
      }
      if (!getSalon(salonId)) return json(response, 404, { ok: false, error: "Salon nije pronađen" });
      return json(response, 200, { ok: true, salon_id: salonId, appointments: await readAppointments(salonId) });
    }

    if (request.method === "PATCH" && /^\/api\/salons\/[^/]+\/schedule$/.test(url.pathname)) {
      if (auth.kind === "tool") return json(response, 403, { ok: false, error: "Owner session required" });
      const salonId = decodeURIComponent(url.pathname.split("/")[3]);
      const salon = getSalon(salonId);
      if (!salon) return json(response, 404, { ok: false, error: "Salon nije pronađen" });
      if (auth.kind === "owner" && auth.salonId !== salonId) return json(response, 403, { ok: false, error: "Salon nije dostupan ovom nalogu" });
      const body = await readBody(request);
      if (!validSchedule(body.schedule, salon)) return json(response, 400, { ok: false, error: "Neispravno radno vreme ili pauza" });
      db.prepare("UPDATE salons SET schedule_json = ? WHERE id = ?").run(JSON.stringify(body.schedule), salonId);
      return json(response, 200, { ok: true, salon: serializeSalon(getSalon(salonId)) });
    }

    if (request.method === "POST" && url.pathname === "/api/owner/cancel-appointment") {
      if (auth.kind === "tool") return json(response, 403, { ok: false, error: "Owner session required" });
      const body = await readBody(request);
      const appointmentId = String(body.appointment_id || "").trim();
      const operation = writeQueue.catch(() => {}).then(() => {
        const item = db.prepare("SELECT id,status,salon_id FROM appointments WHERE id = ?").get(appointmentId);
        if (!item || item.status !== "confirmed") return null;
        if (auth.kind === "owner" && item.salon_id !== auth.salonId) return "forbidden";
        db.prepare("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'owner' WHERE id = ? AND status = 'confirmed'")
          .run(new Date().toISOString(), appointmentId);
        return item;
      });
      writeQueue = operation.catch(() => {});
      const result = await operation;
      if (result === "forbidden") return json(response, 403, { ok: false, error: "Salon nije dostupan ovom nalogu" });
      if (!result) return json(response, 404, { ok: false, error: "Aktivan termin nije pronađen" });
      return json(response, 200, { ok: true, appointment_id: appointmentId });
    }

    if (request.method === "POST" && url.pathname === "/api/check-availability") {
      const body = await readBody(request);
      const salon = requestSalon(request, body, auth);
      if (!salon) return json(response, 404, { ok: false, error: "Salon nije pronađen" });
      const service = normalizeService(body.service, salon);
      const barber = normalizeBarber(body.barber, salon);
      if (!validDate(body.date)) return json(response, 200, { ok: false, code: "INVALID_DATE", reason: "Potreban je važeći datum u formatu YYYY-MM-DD." });
      if (!service) return json(response, 200, { ok: false, code: "UNKNOWN_SERVICE", reason: "Ta usluga nije dostupna u ovom salonu.", available_services: salonServices(salon) });
      if (body.time != null && !validTime(body.time)) return json(response, 200, { ok: false, code: "INVALID_TIME", reason: "Potrebno je tačno vreme u formatu HH:MM." });
      if (body.phone && !validSerbianMobile(body.phone)) return json(response, 200, { ok: false, code: "INVALID_PHONE", reason: "Broj telefona mora da počinje sa 06 i da ima 9 ili 10 cifara." });
      const pastDate = dateAvailabilityReason(body.date, salon);
      if (pastDate) return json(response, 200, { ok: false, code: "PAST_DATE", reason: pastDate, available_slots: [] });
      const appointments = await readAppointments(salon.id);
      if (body.phone && findWeeklyBookingConflict(appointments, salon.id, body.date, body.phone)) {
        const details = weeklyLimitDetails(appointments, salon, body.date, body.phone, barber, service);
        return json(response, 200, {
          ok: false,
          code: "CUSTOMER_WEEKLY_LIMIT",
          reason: `Za ovaj broj telefona već postoji aktivna rezervacija u ovom salonu u razmaku kraćem od sedam dana. Sedmodnevno ograničenje prestaje ${details.next_eligible_date}.`,
          available_slots: [],
          ...details,
        });
      }
      if (!body.barber) return json(response, 200, { ok: false, code: "NEED_STAFF", reason: "Koji zaposleni vam odgovara?", available_staff: salonBarbers(salon) });
      if (!barber) return json(response, 200, { ok: false, code: "UNKNOWN_STAFF", reason: "Taj zaposleni ne radi u ovom salonu.", available_staff: salonBarbers(salon) });
      const schedule = scheduleWindow(salon, barber);
      const weekday = new Date(`${body.date}T00:00:00Z`).getUTCDay();
      const closed = !schedule.weekdays.includes(weekday);
      const requested = body.time ? requestedSlotStatus(appointments, body.date, body.time, barber, service, salon) : null;
      const slots = availableSlots(appointments, body.date, barber, service, salon);
      const offeredSlots = nearestAvailableSlots(slots, body.time, requested);
      const lastStartMinutes = minutes(schedule.end) - SERVICES[service].durationMinutes;
      return json(response, 200, {
        ok: true,
        salon_id: salon.id,
        date: body.date,
        service,
        barber,
        timezone: salon.timezone,
        working_hours: { start: schedule.start, end: schedule.end, last_start: lastStartMinutes >= minutes(schedule.start) ? clockTime(lastStartMinutes) : null, breaks: schedule.breaks },
        ...(closed ? { day_status: "CLOSED_DAY", reason: `${barber} ne radi tog dana.` } : {}),
        ...(requested ? { requested_time: body.time, requested_time_available: requested.code === "AVAILABLE", requested_time_status: requested.code, reason: requested.reason } : {}),
        available_slots: offeredSlots,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/book-appointment") {
      const body = await readBody(request);
      const salon = requestSalon(request, body, auth);
      if (!salon) return json(response, 404, { ok: false, error: "Salon nije pronađen" });
      const service = normalizeService(body.service, salon);
      const barber = normalizeBarber(body.barber, salon);
      if (
        !validDate(body.date) ||
        !validTime(body.time) ||
        !service ||
        !barber ||
        !String(body.customer_name || "").trim() ||
        !validSerbianMobile(body.phone)
      ) {
        return json(response, 400, {
          ok: false,
          error: "Potrebni su date, time, service, barber, customer_name i srpski mobilni broj koji počinje sa 06",
        });
      }

      const slotRule = slotRuleStatus(body.time, SERVICES[service].durationMinutes, body.date, barber, salon);
      if (slotRule.code !== "AVAILABLE") return json(response, 200, { ok: false, code: slotRule.code, error: slotRule.reason });

      const appointment = {
        id: `BR-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
        status: "confirmed",
        salon_id: salon.id,
        date: body.date,
        time: body.time,
        service,
        barber,
        customer_name: String(body.customer_name).trim(),
        phone: String(body.phone).trim(),
        created_at: new Date().toISOString(),
      };

      try {
        await appendAppointment(appointment);
      } catch (error) {
        if (error.code === "CUSTOMER_WEEKLY_LIMIT") {
          // Return business rules as a normal webhook result so the voice agent
          // receives the specific reason instead of a generic HTTP error.
          const appointments = await readAppointments(salon.id);
          const details = weeklyLimitDetails(appointments, salon, body.date, body.phone, barber, service);
          return json(response, 200, { ok: false, code: error.code, error: error.message, ...details });
        }
        if (error.code === "SLOT_TAKEN" || error.code === "CUSTOMER_DAY_LIMIT" || error.code === "CUSTOMER_DAILY_LIMIT") {
          return json(response, 200, { ok: false, code: error.code, error: error.message });
        }
        throw error;
      }
      return json(response, 201, { ok: true, salon_id: salon.id, appointment });
    }

    if (request.method === "POST" && url.pathname === "/api/cancel-appointment") {
      const body = await readBody(request);
      const salon = requestSalon(request, body, auth);
      if (!salon) return json(response, 404, { ok: false, error: "Salon nije pronađen" });
      if (!validDate(body.date) || !validTime(body.time) || !validSerbianMobile(body.phone)) {
        return json(response, 400, {
          ok: false,
          error: "Potrebni su date (YYYY-MM-DD), time (HH:MM) i srpski mobilni broj koji počinje sa 06",
        });
      }

      try {
        const appointment = await cancelAppointment({ salon_id: salon.id, date: body.date, time: body.time, phone: body.phone });
        return json(response, 200, { ok: true, salon_id: salon.id, appointment });
      } catch (error) {
        if (error.code === "APPOINTMENT_NOT_FOUND") {
          return json(response, 404, { ok: false, error: error.message });
        }
        if (error.code === "APPOINTMENT_AMBIGUOUS") {
          return json(response, 200, { ok: false, code: error.code, error: error.message });
        }
        if (error.code === "CUSTOMER_WEEKLY_CANCEL_LIMIT") {
          return json(response, 200, { ok: false, code: error.code, error: error.message });
        }
        throw error;
      }
    }

    return json(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return json(response, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Booking demo API: http://127.0.0.1:${PORT}`);
  console.log(`SQLite database: ${DB_FILE}`);
  console.log(API_SECRET ? "API secret protection: enabled" : "API secret protection: disabled");
});
