const state = {
  token: sessionStorage.getItem("salon_token"),
  role: null,
  salons: [],
  selectedSalonId: sessionStorage.getItem("salon_id") || "default",
  appointments: [],
  selectedBarber: null,
  selected: new Date(),
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
};
let widgetScriptPromise;
let callRefreshTimer;
let appointmentLoadSequence = 0;
const $ = (id) => document.getElementById(id);
const monthNames = ["Januar", "Februar", "Mart", "April", "Maj", "Jun", "Jul", "Avgust", "Septembar", "Oktobar", "Novembar", "Decembar"];
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const formatDate = (key) => { const [y, m, d] = key.split("-").map(Number); return `${d}. ${monthNames[m - 1].toLocaleLowerCase("sr-Latn")}`; };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

async function api(path, options = {}) {
  const requestToken = state.token;
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login" && requestToken && state.token === requestToken) expireSession();
    const error = new Error(response.status === 401 && path !== "/api/login" ? "Sesija je istekla. Prijavite se ponovo." : data.error || data.message || `Greška ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showLoggedIn(on) { $("loginView").classList.toggle("hidden", on); $("calendarView").classList.toggle("hidden", !on); }
function expireSession() {
  state.token = null;
  state.role = null;
  state.salons = [];
  state.appointments = [];
  state.selectedBarber = null;
  sessionStorage.removeItem("salon_token");
  sessionStorage.removeItem("salon_id");
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  $("userLabel").textContent = "";
  $("loginError").textContent = "Sesija je istekla. Prijavite se ponovo.";
  showLoggedIn(false);
}
function renderAccess() { const platform = state.role === "platform"; $("addSalonBtn").classList.toggle("hidden", !platform); $("addOwnerBtn").classList.toggle("hidden", !platform); $("provisionBtn").classList.toggle("hidden", !platform || !selectedSalon() || selectedSalon().integration_ready); $("changePasswordBtn").classList.toggle("hidden", state.role !== "owner"); $("salonSelect").disabled = state.role === "owner"; }
function selectedSalon() { return state.salons.find((salon) => salon.id === state.selectedSalonId) || state.salons[0] || null; }

async function loadSalons() {
  const data = await api("/api/admin/salons"); state.salons = data.salons || [];
  if (!state.salons.some((salon) => salon.id === state.selectedSalonId)) state.selectedSalonId = state.salons[0]?.id || "default";
  sessionStorage.setItem("salon_id", state.selectedSalonId);
  const select = $("salonSelect"); select.innerHTML = "";
  state.salons.forEach((salon) => { const option = document.createElement("option"); option.value = salon.id; option.textContent = salon.name; select.appendChild(option); });
  select.value = state.selectedSalonId; renderSalonMeta(); renderAccess();
}

function renderSalonMeta() { const salon = selectedSalon(); $("salonMeta").textContent = salon ? `Agent: ${salon.agent_id || "nije povezan"} · ID salona: ${salon.id} · ${salon.integration_ready ? "Alati povezani" : "Alati nisu povezani"}` : "Nema unetih salona."; }

function ensureWidgetScript() {
  if (customElements.get("elevenlabs-convai")) return Promise.resolve();
  if (widgetScriptPromise) return widgetScriptPromise;
  widgetScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script"); script.src = "https://unpkg.com/@elevenlabs/convai-widget-embed"; script.async = true; script.type = "text/javascript";
    script.onload = () => resolve(); script.onerror = () => reject(new Error("ElevenLabs widget nije mogao da se učita.")); document.head.appendChild(script);
  });
  return widgetScriptPromise;
}

async function openCallDialog() {
  const salon = selectedSalon(); const dialog = $("callDialog"); const host = $("agentWidgetHost");
  if (!salon?.agent_id) { alert("Za ovaj salon nije unet ElevenLabs agent ID."); return; }
  if (!salon.integration_ready) { alert("Agent još nema odvojene webhook alate za ovaj salon. Prvo dovršite povezivanje."); return; }
  $("callTitle").textContent = `Poziv: ${salon.name}`; $("callInfo").textContent = "Učitavam agenta…"; host.innerHTML = "";
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
  clearInterval(callRefreshTimer);
  callRefreshTimer = setInterval(() => {
    if (state.token && dialog.open) loadAppointments().catch(() => {});
  }, 5000);
  try {
    await ensureWidgetScript();
    if (!dialog.open || selectedSalon()?.id !== salon.id) return;
    const widget = document.createElement("elevenlabs-convai"); widget.setAttribute("agent-id", salon.agent_id); widget.setAttribute("variant", "expanded"); widget.setAttribute("start-call-text", "Započni poziv"); host.appendChild(widget);
    $("callInfo").textContent = "Klikni Započni poziv i dozvoli mikrofon. Agent će koristiti alate iz ovog salona.";
  } catch (error) { $("callInfo").textContent = error.message; }
}

$("callDialog").addEventListener("close", () => {
  clearInterval(callRefreshTimer);
  callRefreshTimer = null;
  $("agentWidgetHost").replaceChildren();
  if (state.token) loadAppointments().catch(() => {});
});

async function loadAppointments() {
  const salonId = state.selectedSalonId;
  const token = state.token;
  const sequence = ++appointmentLoadSequence;
  const data = await api(`/api/appointments?salon_id=${encodeURIComponent(salonId)}`);
  if (salonId !== state.selectedSalonId || token !== state.token || sequence !== appointmentLoadSequence) return;
  state.appointments = data.appointments || [];
  render();
}
function visibleAppointments() { return state.selectedBarber ? state.appointments.filter((appointment) => appointment.barber === state.selectedBarber) : state.appointments; }
function render() { $("monthTitle").textContent = `${monthNames[state.month.getMonth()]} ${state.month.getFullYear()}`; renderStaffFilters(); renderCalendar(); renderDay(); }

function renderStaffFilters() {
  const salon = selectedSalon();
  const host = $("staffFilters");
  const barbers = salon?.barbers || [];
  if (state.selectedBarber && !barbers.includes(state.selectedBarber)) state.selectedBarber = null;
  $("scopeLabel").textContent = state.selectedBarber ? `Samo: ${state.selectedBarber}` : "Ceo salon";
  host.innerHTML = "";
  const options = [null, ...barbers];
  options.forEach((barber) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `staff-filter${state.selectedBarber === barber ? " active" : ""}`;
    button.textContent = barber || "Ceo salon";
    button.setAttribute("aria-pressed", String(state.selectedBarber === barber));
    button.addEventListener("click", () => { state.selectedBarber = barber; render(); });
    host.appendChild(button);
  });
}

function renderCalendar() {
  const grid = $("calendar"); grid.innerHTML = ""; const first = new Date(state.month.getFullYear(), state.month.getMonth(), 1); const start = new Date(first); start.setDate(1 - first.getDay()); const today = dateKey(new Date());
  const appointments = visibleAppointments();
  for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); const key = dateKey(d); const day = document.createElement("button"); day.className = "day"; if (d.getMonth() !== state.month.getMonth()) day.classList.add("outside"); if (key === today) day.classList.add("today"); if (key === dateKey(state.selected)) day.classList.add("selected"); const items = appointments.filter((a) => a.date === key); day.innerHTML = `<span class="day-number">${d.getDate()}</span><span class="markers">${items.some((a) => a.status === "confirmed") ? '<i class="dot confirmed"></i>' : ""}${items.some((a) => a.status === "cancelled") ? '<i class="dot cancelled"></i>' : ""}</span>`; day.addEventListener("click", () => { state.selected = d; render(); }); grid.appendChild(day); }
}

function renderDay() {
  const key = dateKey(state.selected); $("selectedTitle").textContent = formatDate(key); $("selectedScope").textContent = state.selectedBarber ? `Zaposleni: ${state.selectedBarber}` : "Svi zaposleni"; const items = visibleAppointments().filter((a) => a.date === key).sort((a, b) => a.time.localeCompare(b.time)); $("dayCount").textContent = `${items.length} ${items.length === 1 ? "termin" : "termina"}`; const host = $("appointments");
  if (!items.length) { host.innerHTML = '<div class="empty">Nema termina za ovaj dan.</div>'; return; }
  host.innerHTML = items.map((a) => `<article class="appointment ${a.status === "cancelled" ? "cancelled-card" : ""}"><div class="appointment-row"><span class="time">${escapeHtml(a.time)}</span><span class="status ${a.status === "cancelled" ? "cancelled" : "confirmed"}">${a.status === "cancelled" ? "Otkazano" : "Zakazano"}</span></div><div class="details">${escapeHtml(a.service)} · ${escapeHtml(a.barber)}<br>${escapeHtml(a.customer_name)} · ${escapeHtml(a.phone)}<br><small>${escapeHtml(a.id)}</small>${a.status === "confirmed" ? `<br><button type="button" class="ghost cancel-booking" data-id="${escapeHtml(a.id)}">Otkaži kao vlasnik</button>` : ""}</div></article>`).join("");
}

$("appointments").addEventListener("click", async (event) => {
  const button = event.target.closest(".cancel-booking");
  if (!button) return;
  const item = state.appointments.find((appointment) => appointment.id === button.dataset.id);
  if (!item || !confirm(`Otkazati termin ${item.date} u ${item.time} za ${item.customer_name}?`)) return;
  button.disabled = true;
  try { await api("/api/owner/cancel-appointment", { method: "POST", body: JSON.stringify({ appointment_id: item.id }) }); await loadAppointments(); }
  catch (error) { button.disabled = false; alert(error.message); }
});

function fillScheduleForm() {
  const base = selectedSalon()?.schedule;
  if (!base) return;
  const schedule = base.staff?.[$("scheduleStaff").value] || base;
  $("scheduleDays").value = schedule.weekdays.join(",");
  $("scheduleStart").value = schedule.start;
  $("scheduleEnd").value = schedule.end;
  $("scheduleBreaks").value = schedule.breaks.map((item) => `${item.start}-${item.end}`).join("\n");
}
$("scheduleBtn").addEventListener("click", () => {
  const salon = selectedSalon();
  if (!salon?.schedule) return;
  $("scheduleStaff").innerHTML = '<option value="">Ceo salon</option>';
  salon.barbers.forEach((name) => { const option = document.createElement("option"); option.value = name; option.textContent = name; $("scheduleStaff").appendChild(option); });
  fillScheduleForm();
  $("scheduleError").textContent = "";
  $("scheduleDialog").showModal();
});
$("scheduleStaff").addEventListener("change", fillScheduleForm);
$("closeScheduleBtn").addEventListener("click", () => $("scheduleDialog").close());
$("cancelScheduleBtn").addEventListener("click", () => $("scheduleDialog").close());
$("scheduleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const weekdays = $("scheduleDays").value.split(",").map((value) => Number(value.trim()));
    const breaks = $("scheduleBreaks").value.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = /^(\d\d:\d\d)\s*-\s*(\d\d:\d\d)$/.exec(line);
      if (!match) throw new Error("Pauza mora biti u obliku 13:00-13:30.");
      return { start: match[1], end: match[2] };
    });
    const previous = selectedSalon().schedule;
    const schedule = structuredClone(previous);
    schedule.staff ||= {};
    const updatedWindow = { weekdays, start: $("scheduleStart").value, end: $("scheduleEnd").value, breaks };
    if ($("scheduleStaff").value) schedule.staff[$("scheduleStaff").value] = updatedWindow;
    else Object.assign(schedule, updatedWindow);
    await api(`/api/salons/${encodeURIComponent(state.selectedSalonId)}/schedule`, { method: "PATCH", body: JSON.stringify({ schedule }) });
    $("scheduleDialog").close(); await loadSalons();
  } catch (error) { $("scheduleError").textContent = error.message; }
});

function openSalonDialog() { const dialog = $("salonDialog"); $("salonError").textContent = ""; if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); }
function closeSalonDialog() { const dialog = $("salonDialog"); if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open"); }

$("loginForm").addEventListener("submit", async (event) => { event.preventDefault(); $("loginError").textContent = ""; try { const data = await api("/api/login", { method: "POST", body: JSON.stringify({ username: $("username").value, password: $("password").value }) }); state.token = data.token; state.role = data.role; sessionStorage.setItem("salon_token", state.token); $("userLabel").textContent = data.user; showLoggedIn(true); await loadSalons(); await loadAppointments(); } catch (error) { $("loginError").textContent = error.message; } });
$("salonSelect").addEventListener("change", async (event) => {
  state.selectedSalonId = event.target.value;
  state.selectedBarber = null;
  state.appointments = [];
  sessionStorage.setItem("salon_id", state.selectedSalonId);
  renderSalonMeta(); renderAccess(); render();
  try { await loadAppointments(); } catch (error) { alert(error.message); }
});
$("provisionBtn").addEventListener("click", async () => {
  const salon = selectedSalon();
  if (!salon || !confirm(`Povezati ${salon.name}? Ovo postavlja znanje u prompt agenta i kreira tri posebna webhook alata. Postojeći prompt tog agenta biće zamenjen.`)) return;
  const button = $("provisionBtn"); button.disabled = true; button.textContent = "Povezujem…";
  try { await api(`/api/admin/salons/${encodeURIComponent(salon.id)}/provision`, { method: "POST" }); await loadSalons(); alert("Agent, znanje i tri alata su povezani. Sada testirajte poziv."); }
  catch (error) { alert(`Povezivanje nije završeno: ${error.message}`); }
  finally { button.disabled = false; button.textContent = "Poveži alate i znanje"; }
});
$("callAgentBtn").addEventListener("click", () => openCallDialog());
$("addSalonBtn").addEventListener("click", openSalonDialog); $("closeSalonBtn").addEventListener("click", closeSalonDialog); $("cancelSalonBtn").addEventListener("click", closeSalonDialog);
$("salonForm").addEventListener("submit", async (event) => { event.preventDefault(); $("salonError").textContent = ""; try { const data = await api("/api/admin/salons", { method: "POST", body: JSON.stringify({ name: $("salonName").value, agent_id: $("salonAgentId").value, barbers: $("salonBarbers").value, services: $("salonServices").value, knowledge_notes: $("salonKnowledge").value }) }); state.selectedSalonId = data.salon.id; sessionStorage.setItem("salon_id", state.selectedSalonId); closeSalonDialog(); await loadSalons(); await loadAppointments(); } catch (error) { $("salonError").textContent = error.message; } });
$("logoutBtn").addEventListener("click", () => { state.token = null; state.role = null; state.salons = []; state.appointments = []; sessionStorage.removeItem("salon_token"); sessionStorage.removeItem("salon_id"); showLoggedIn(false); }); $("refreshBtn").addEventListener("click", () => Promise.all([loadSalons(), loadAppointments()]).catch((error) => { if (error.status !== 401) alert(error.message); }));
$("prevMonth").addEventListener("click", () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); render(); }); $("nextMonth").addEventListener("click", () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); render(); });
$("addOwnerBtn").addEventListener("click", () => { $("ownerError").textContent = ""; $("ownerResult").textContent = ""; $("ownerDialog").showModal(); });
$("closeOwnerBtn").addEventListener("click", () => $("ownerDialog").close());
$("cancelOwnerBtn").addEventListener("click", () => $("ownerDialog").close());
$("ownerForm").addEventListener("submit", async (event) => { event.preventDefault(); $("ownerError").textContent = ""; try { const data = await api("/api/admin/owners", { method: "POST", body: JSON.stringify({ salon_id: state.selectedSalonId, username: $("ownerUsername").value }) }); $("ownerResult").textContent = `Nalog: ${data.username} · Početna lozinka (prikazuje se samo sada): ${data.temporary_password}. Vlasnik treba odmah da je promeni.`; $("ownerUsername").value = ""; } catch (error) { $("ownerError").textContent = error.message; } });
$("changePasswordBtn").addEventListener("click", () => { $("passwordError").textContent = ""; $("passwordDialog").showModal(); });
$("closePasswordBtn").addEventListener("click", () => $("passwordDialog").close());
$("cancelPasswordBtn").addEventListener("click", () => $("passwordDialog").close());
$("passwordForm").addEventListener("submit", async (event) => { event.preventDefault(); $("passwordError").textContent = ""; try { await api("/api/account/password", { method: "POST", body: JSON.stringify({ current_password: $("currentPassword").value, new_password: $("newPassword").value }) }); $("currentPassword").value = ""; $("newPassword").value = ""; $("passwordDialog").close(); alert("Lozinka je promenjena."); } catch (error) { $("passwordError").textContent = error.message; } });
if (state.token) { showLoggedIn(true); Promise.resolve().then(() => api("/api/me")).then((me) => { state.role = me.role; $("userLabel").textContent = me.user; return loadSalons(); }).then(loadAppointments).catch((error) => { if (error.status !== 401) expireSession(); }); }
setInterval(() => { if (state.token) loadAppointments().catch(() => {}); }, 30000);
