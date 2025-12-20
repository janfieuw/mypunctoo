// js/app.js

const SUBSCRIPTION_STATUS_KEY = "mypunctoo_subscription_status";
const AUTH_TOKEN_KEY = "mypunctoo_auth_token";

// =========================
// Auth + Fetch
// =========================
function getAuthToken() {
  try {
    return window.localStorage.getItem(AUTH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

async function apiFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = Object.assign({}, options.headers || {});
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

async function requireSessionOrRedirect() {
  const token = getAuthToken();
  if (!token) {
    window.location.href = "/login";
    return false;
  }

  const res = await apiFetch("/api/me", { cache: "no-cache" });
  if (!res.ok) {
    try {
      window.localStorage.removeItem(AUTH_TOKEN_KEY);
    } catch {}
    window.location.href = "/login";
    return false;
  }
  return true;
}

// =========================
// View Loader
// =========================
async function loadView(viewName) {
  try {
    const response = await fetch(`/views/${viewName}.html`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Failed to load view: ${viewName}`);
    const html = await response.text();
    document.getElementById("app").innerHTML = html;
    initView(viewName);
  } catch (err) {
    console.error(err);
    document.getElementById("app").innerHTML = `
      <section class="card">
        <h1 class="card-title">Error</h1>
        <p class="card-text">
          Could not load view <strong>${viewName}</strong>.
        </p>
      </section>
    `;
  }
}

function initTabs() {
  const buttons = document.querySelectorAll(".nav-btn");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.view;
      if (!target) return;

      buttons.forEach((b) => {
        if (b.dataset.view) b.classList.remove("active");
      });

      btn.classList.add("active");
      loadView(target);
    });
  });
}

function initLogout() {
  const btn = document.getElementById("logoutBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    try {
      await apiFetch("/api/logout", { method: "POST" });
    } catch {}
    try {
      window.localStorage.removeItem(AUTH_TOKEN_KEY);
    } catch {}
    window.location.href = "/login";
  });
}

// =========================
// Subscription (UI-only)
// =========================
function loadSubscriptionStatus() {
  try {
    const raw = window.localStorage.getItem(SUBSCRIPTION_STATUS_KEY);
    if (!raw) return "active";
    const parsed = JSON.parse(raw);
    return parsed === "inactive" ? "inactive" : "active";
  } catch (e) {
    console.warn("Could not read subscription status:", e);
    return "active";
  }
}

function saveSubscriptionStatus(status) {
  try {
    window.localStorage.setItem(SUBSCRIPTION_STATUS_KEY, JSON.stringify(status));
  } catch (e) {
    console.warn("Could not save subscription status:", e);
  }
}

function applySubscriptionStatus(status) {
  const isActive = status === "active";

  const dashboardBadge = document.getElementById("dashboard-subscription-status");
  if (dashboardBadge) {
    dashboardBadge.textContent = isActive ? "Active" : "Inactive";
    dashboardBadge.classList.toggle("kpi-badge--inactive", !isActive);
  }

  const clientBadge = document.getElementById("client-status-badge");
  if (clientBadge) {
    clientBadge.textContent = isActive ? "Active" : "Inactive";
    clientBadge.classList.toggle("client-status-badge--active", isActive);
    clientBadge.classList.toggle("client-status-badge--inactive", !isActive);
  }

  const toggleBtn = document.getElementById("subscription-toggle");
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-pressed", String(isActive));
    toggleBtn.classList.toggle("sub-toggle-switch--on", isActive);
    toggleBtn.classList.toggle("sub-toggle-switch--off", !isActive);
  }
}

function initSubscriptionControls() {
  const toggleBtn = document.getElementById("subscription-toggle");
  if (!toggleBtn) {
    applySubscriptionStatus(loadSubscriptionStatus());
    return;
  }

  const modal = document.getElementById("deactivate-modal");
  const cancelBtn = document.getElementById("cancel-deactivate");
  const confirmBtn = document.getElementById("confirm-deactivate");

  function openModal() {
    if (!modal) return;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }

  function closeModal() {
    if (!modal) return;
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  applySubscriptionStatus(loadSubscriptionStatus());

  toggleBtn.addEventListener("click", () => {
    const current = loadSubscriptionStatus();
    const newState = current === "active" ? "inactive" : "active";

    if (newState === "inactive") {
      openModal();
    } else {
      saveSubscriptionStatus("active");
      applySubscriptionStatus("active");
    }
  });

  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);

  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      saveSubscriptionStatus("inactive");
      applySubscriptionStatus("inactive");
      closeModal();
    });
  }

  if (modal) {
    const backdrop = modal.querySelector(".modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeModal);
  }
}

// =========================
// Router init
// =========================
function initView(viewName) {
  applySubscriptionStatus(loadSubscriptionStatus());

  if (viewName === "client-record") {
    initSubscriptionControls();
  }

  if (viewName === "dashboard") {
    hydrateDashboard();
  }

  if (viewName === "client-record") {
    hydrateClientRecord();
  }

  // Employees page
  if (viewName === "users") {
    hydrateUsers();
  }

  // Linked devices page (Beheren)
  if (viewName === "beheren") {
    hydrateBeheren();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  (async () => {
    const ok = await requireSessionOrRedirect();
    if (!ok) return;

    initTabs();
    initLogout();
    loadView("dashboard");
  })();
});

// =========================
// Dashboard
// =========================
async function hydrateDashboard() {
  try {
    const res = await apiFetch("/api/stats", { cache: "no-cache" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Could not load stats");

    const s = data.stats || {};
    const elUsers = document.getElementById("kpi-users-total");
    const elActive = document.getElementById("kpi-users-active");
    const elCheckins = document.getElementById("kpi-checkins-today");

    if (elUsers) elUsers.textContent = String(s.employeesTotal ?? "–");
    if (elActive) elActive.textContent = String(s.employeesActive ?? "–");
    if (elCheckins) elCheckins.textContent = String(s.checkinsToday ?? "–");
  } catch (e) {
    console.warn(e);
  }
}

// =========================
// Client record
// =========================
async function hydrateClientRecord() {
  try {
    const res = await apiFetch("/api/company", { cache: "no-cache" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Could not load company");

    const c = data.company || {};
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value || "–";
    };

    // Company
    set("cr-company-name", c.name);
    set("cr-customer-number", c.customerNumber);
    set("cr-vat", c.vatNumber);

    // Registered address
    const regAddrLines = [c.street, `${c.postalCode || ""} ${c.city || ""}`.trim(), c.country].filter(Boolean);
    const regEl = document.getElementById("cr-registered-address");
    if (regEl) {
      regEl.innerHTML = regAddrLines.length ? regAddrLines.map((l) => `${escapeHtml(l)}<br>`).join("") : "–";
    }

    // Main contact
    set("cr-contact-name", `${c.contact?.firstName || ""} ${c.contact?.lastName || ""}`.trim());

    // Billing
    set("cr-invoice-email", c.invoiceEmail || "");
    set("cr-billing-ref", c.billingReference || "–");

    // Delivery (always)
    const del = c.delivery || {};
    const delAddrLines = [
      del.street || c.street,
      `${del.postalCode || c.postalCode || ""} ${del.city || c.city || ""}`.trim(),
      del.country || c.country
    ].filter(Boolean);

    const delAddrEl = document.getElementById("cr-delivery-address");
    if (delAddrEl) {
      delAddrEl.innerHTML = delAddrLines.length ? delAddrLines.map((l) => `${escapeHtml(l)}<br>`).join("") : "–";
    }

    set("cr-delivery-contact", c.deliveryContactPerson || c.registeredContactPerson || "–");

    const metaEl = document.getElementById("client-status-meta");
    if (metaEl) {
      metaEl.innerHTML = `Subscription no.: <strong>${escapeHtml(c.subscriptionNumber || "–")}</strong><br>
        Start date: <strong>${escapeHtml(c.subscriptionStartDate || "–")}</strong>`;
    }
  } catch (e) {
    console.warn(e);
  }
}

// =========================
// Users helpers
// =========================
function usersSetError(msg) {
  const el = document.getElementById("users-error");
  if (!el) return;
  el.textContent = msg ? String(msg) : "";
}

function devicesSetError(msg) {
  const el = document.getElementById("devices-error");
  if (!el) return;
  el.textContent = msg ? String(msg) : "";
}

function scheduleSetError(msg) {
  const el = document.getElementById("schedule-error");
  if (!el) return;
  el.textContent = msg ? String(msg) : "";
}

function normalizeUpper(str) {
  return String(str || "").trim().toUpperCase();
}

function normalizeLower(str) {
  return String(str || "").trim().toLowerCase();
}

function formatDateISO(d) {
  if (!d) return "";
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function statusLabel(status) {
  return normalizeLower(status) === "inactive" ? "INACTIVE" : "ACTIVE";
}

async function usersFetchEmployees() {
  const res = await apiFetch("/api/employees", { cache: "no-cache" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "Could not load employees");
  return data.employees || [];
}

// =========================
// Expected working schedule (MINUTES UI)
// =========================
const WEEKDAYS = [
  { key: 1, label: "MONDAY" },
  { key: 2, label: "TUESDAY" },
  { key: 3, label: "WEDNESDAY" },
  { key: 4, label: "THURSDAY" },
  { key: 5, label: "FRIDAY" },
  { key: 6, label: "SATURDAY" },
  { key: 0, label: "SUNDAY" }
];

let currentScheduleEmployeeId = null;

function openScheduleModal(employeeId, employeeName) {
  const modal = document.getElementById("schedule-modal");
  if (!modal) return;

  currentScheduleEmployeeId = Number(employeeId);

  const title = document.getElementById("schedule-modal-title");
  if (title) {
    title.textContent = `WORKING SCHEDULE (MINUTES) — ${employeeName || ""}`.trim();
  }

  scheduleSetError("");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  modal.classList.add("open");
}

function closeScheduleModal() {
  const modal = document.getElementById("schedule-modal");
  if (!modal) return;

  currentScheduleEmployeeId = null;
  scheduleSetError("");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  modal.classList.remove("open");
}

async function fetchExpectedSchedule(employeeId) {
  const res = await apiFetch(`/api/employees/${employeeId}/expected-schedule`, { cache: "no-cache" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "Could not load expected schedule");
  return data.schedule || [];
}

async function saveExpectedSchedule(employeeId, schedule) {
  const res = await apiFetch(`/api/employees/${employeeId}/expected-schedule`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schedule })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "Could not save expected schedule");
  return data.schedule || [];
}

function renderScheduleTable(scheduleRows) {
  const tbody = document.getElementById("schedule-tbody");
  if (!tbody) return;

  const mapByDay = new Map();
  (scheduleRows || []).forEach((r) => {
    mapByDay.set(Number(r.weekday), {
      weekday: Number(r.weekday),
      expected_minutes: Number(r.expected_minutes || 0),
      break_minutes: Number(r.break_minutes || 0)
    });
  });

  tbody.innerHTML = WEEKDAYS.map((d) => {
    const row = mapByDay.get(d.key) || { weekday: d.key, expected_minutes: 0, break_minutes: 0 };

    return `
      <tr data-weekday="${d.key}">
        <td><strong>${escapeHtml(d.label)}</strong></td>
        <td>
          <input class="users-input" type="number" min="0" step="5"
            value="${escapeHtml(row.expected_minutes)}" data-field="expected" style="max-width:160px;" />
        </td>
        <td>
          <input class="users-input" type="number" min="0" step="5"
            value="${escapeHtml(row.break_minutes)}" data-field="break" style="max-width:160px;" />
        </td>
      </tr>
    `;
  }).join("");
}

function collectScheduleFromModal() {
  const tbody = document.getElementById("schedule-tbody");
  if (!tbody) return [];

  const out = [];
  tbody.querySelectorAll("tr[data-weekday]").forEach((tr) => {
    const weekday = Number(tr.dataset.weekday);
    const expected = Number(tr.querySelector("input[data-field='expected']")?.value || 0);
    const br = Number(tr.querySelector("input[data-field='break']")?.value || 0);
    out.push({ weekday, expected_minutes: expected, break_minutes: br });
  });

  return out;
}

function emptyScheduleRows() {
  return WEEKDAYS.map((d) => ({ weekday: d.key, expected_minutes: 0, break_minutes: 0 }));
}

function attachScheduleModalHandlersOnce() {
  const modal = document.getElementById("schedule-modal");
  if (!modal || modal.dataset.bound === "1") return;

  const closeBtn = document.getElementById("schedule-close");
  const saveBtn = document.getElementById("schedule-save");
  const backdrop = modal.querySelector(".modal-backdrop");

  if (closeBtn) closeBtn.addEventListener("click", closeScheduleModal);
  if (backdrop) backdrop.addEventListener("click", closeScheduleModal);

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      if (!currentScheduleEmployeeId) return;

      scheduleSetError("");
      saveBtn.disabled = true;

      try {
        const schedule = collectScheduleFromModal();

        for (const r of schedule) {
          if (r.break_minutes > r.expected_minutes) throw new Error("BREAK MINUTES cannot exceed WORK MINUTES.");
          if (r.expected_minutes < 0 || r.break_minutes < 0) throw new Error("Minutes cannot be negative.");
        }

        await saveExpectedSchedule(currentScheduleEmployeeId, schedule);

        // Refresh list so "ADD" becomes "ADDED/VIEW"
        await usersRenderEmployees();
        closeScheduleModal();
      } catch (err) {
        console.warn(err);
        scheduleSetError(err?.message || "Something went wrong.");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  modal.dataset.bound = "1";
}

function employeeHasWorkingSchedule(employee) {
  // Server now provides this flag (recommended)
  if (employee && employee.has_working_schedule === true) return true;
  return false;
}

// =========================
// Users table (Employees page)
// =========================
async function usersRenderEmployees() {
  const tbody = document.getElementById("users-tbody");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Loading…</td></tr>`;

  const employees = await usersFetchEmployees();

  if (!employees.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No employees yet.</td></tr>`;
    return;
  }

  const rows = employees.map((e) => {
    const id = e.id;
    const code = e.employee_code || "";
    const fullName = `${e.first_name || ""} ${e.last_name || ""}`.trim();
    const created = formatDateISO(e.created_at) || "–";

    const hasPunches = !!e.has_punches;
    const currentStatus = normalizeLower(e.status) === "inactive" ? "inactive" : "active";
    const nextStatus = currentStatus === "active" ? "inactive" : "active";

    const schedulePresent = employeeHasWorkingSchedule(e);

    // STATUS: clickable pill (ACTIVE/INACTIVE)
    const statusBtn = `
      <button class="status-pill ${currentStatus}" type="button"
        data-action="toggle-status" data-id="${escapeHtml(id)}" data-next="${escapeHtml(nextStatus)}">
        ${escapeHtml(statusLabel(currentStatus))}
      </button>
    `;

    // WORKING SCHEDULE column: ADD / ADDED-VIEW / REMOVE
    const addOrViewBtn = schedulePresent
      ? `<button class="users-btn users-btn--green" type="button" data-action="schedule" data-id="${escapeHtml(id)}" data-name="${escapeHtml(fullName)}">ADDED/VIEW</button>`
      : `<button class="users-btn users-btn--white" type="button" data-action="schedule" data-id="${escapeHtml(id)}" data-name="${escapeHtml(fullName)}">ADD</button>`;

    const removeScheduleBtn = schedulePresent
      ? `<button class="users-btn users-btn--red" type="button" data-action="remove-schedule" data-id="${escapeHtml(id)}" data-name="${escapeHtml(fullName)}">REMOVE WORKING SCHEDULE</button>`
      : ``;

    const scheduleActions = `<div class="users-actions">${addOrViewBtn}${removeScheduleBtn}</div>`;

    const deleteBtn = hasPunches
      ? `<span class="muted-note">RAW DATA PRESENT</span>`
      : `<button class="users-btn users-btn--red" type="button" data-action="delete" data-id="${escapeHtml(id)}">DELETE</button>`;

    return `
      <tr>
        <td>${escapeHtml(code)}</td>
        <td>${escapeHtml(fullName)}</td>
        <td>${statusBtn}</td>
        <td>${escapeHtml(created)}</td>
        <td>${scheduleActions}</td>
        <td>${deleteBtn}</td>
      </tr>
    `;
  });

  tbody.innerHTML = rows.join("");

  // Event delegation
  tbody.onclick = async (ev) => {
    const target = ev.target;
    if (!target) return;

    const btn = target.closest ? target.closest("[data-action]") : null;
    if (!btn) return;

    const action = btn.dataset.action || "";
    const id = btn.dataset.id;

    usersSetError("");

    try {
      if (action === "schedule") {
        attachScheduleModalHandlersOnce();
        openScheduleModal(id, btn.dataset.name || "");

        const scheduleTbody = document.getElementById("schedule-tbody");
        if (scheduleTbody) scheduleTbody.innerHTML = `<tr><td colspan="3" class="table-empty">Loading…</td></tr>`;

        const rows = await fetchExpectedSchedule(id);
        renderScheduleTable(rows);
        return;
      }

      if (action === "remove-schedule") {
        const ok = window.confirm("Remove working schedule? This is always allowed.");
        if (!ok) return;

        btn.disabled = true;
        await saveExpectedSchedule(id, emptyScheduleRows());
        await usersRenderEmployees();
        return;
      }

      if (action === "toggle-status") {
        const next = normalizeLower(btn.dataset.next || "");
        if (!["active", "inactive"].includes(next)) return;

        btn.disabled = true;

        const r = await apiFetch(`/api/employees/${id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next })
        });

        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || "Could not update status");

        await usersRenderEmployees();
        return;
      }

      if (action === "delete") {
        const ok = window.confirm("Delete this employee? This is only allowed if there are no scans yet.");
        if (!ok) return;

        btn.disabled = true;

        const r = await apiFetch(`/api/employees/${id}`, { method: "DELETE" });

        if (r.status === 204) {
          await usersRenderEmployees();
          return;
        }

        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Could not delete employee");
      }
    } catch (err) {
      console.warn(err);
      usersSetError(err?.message || "Something went wrong.");
      btn.disabled = false;
    }
  };
}

// =========================
// Device links (Beheren page)
// =========================
async function devicesFetchBindings() {
  const res = await apiFetch("/api/devices", { cache: "no-cache" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "Could not load devices");
  return data.devices || [];
}

function formatDateTime(dt) {
  if (!dt) return "–";
  try {
    const d = new Date(dt);
    if (Number.isNaN(d.getTime())) return "–";
    return d.toLocaleString();
  } catch {
    return "–";
  }
}

async function devicesRenderBindings() {
  const tbody = document.getElementById("devices-tbody");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="5" class="table-empty">Loading…</td></tr>`;

  const bindings = await devicesFetchBindings();

  if (!bindings.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">No device links yet.</td></tr>`;
    return;
  }

  const rows = bindings.map((b) => {
    const deviceId = b.device_id || "";
    const code = b.employee_code || "";
    const fullName = `${b.first_name || ""} ${b.last_name || ""}`.trim();
    const lastSeen = formatDateTime(b.last_seen_at);

    return `
      <tr>
        <td>${escapeHtml(deviceId)}</td>
        <td>${escapeHtml(code)}</td>
        <td>${escapeHtml(fullName)}</td>
        <td>${escapeHtml(lastSeen)}</td>
        <td>
          <button class="users-btn users-btn--danger" type="button" data-action="unlink" data-device="${escapeHtml(deviceId)}">
            UNLINK
          </button>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = rows.join("");

  tbody.onclick = async (ev) => {
    const btn = ev.target && ev.target.closest && ev.target.closest("button[data-action='unlink']");
    if (!btn) return;

    const deviceId = btn.dataset.device || "";
    if (!deviceId) return;

    devicesSetError("");

    const ok = window.confirm("Unlink this device? The next scan on this phone will ask for an employee code again.");
    if (!ok) return;

    btn.disabled = true;

    try {
      const r = await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not unlink device");
      await devicesRenderBindings();
    } catch (err) {
      console.warn(err);
      devicesSetError(err?.message || "Something went wrong.");
      btn.disabled = false;
    }
  };
}

// =========================
// Users view hydrate
// =========================
async function hydrateUsers() {
  try {
    usersSetError("");
    scheduleSetError("");

    const form = document.getElementById("employee-create-form");
    if (form) {
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        usersSetError("");

        const firstEl = document.getElementById("emp-first");
        const lastEl = document.getElementById("emp-last");

        const first_name = normalizeUpper(firstEl?.value);
        const last_name = normalizeUpper(lastEl?.value);

        if (!first_name || !last_name) {
          usersSetError("Please fill in FIRST NAME and LAST NAME.");
          return;
        }

        const btn = document.getElementById("employee-create-btn");
        if (btn) btn.disabled = true;

        try {
          const r = await apiFetch("/api/employees", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ first_name, last_name })
          });

          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error(j.error || "Could not create employee");

          if (firstEl) firstEl.value = "";
          if (lastEl) lastEl.value = "";

          await usersRenderEmployees();
        } catch (err) {
          console.warn(err);
          usersSetError(err?.message || "Something went wrong.");
        } finally {
          if (btn) btn.disabled = false;
        }
      };
    }

    attachScheduleModalHandlersOnce();
    await usersRenderEmployees();
  } catch (e) {
    console.warn(e);
    usersSetError(e?.message || "Could not load employees.");
  }
}

// =========================
// Beheren view hydrate
// =========================
async function hydrateBeheren() {
  try {
    devicesSetError("");
    await devicesRenderBindings();
  } catch (e) {
    console.warn(e);
    devicesSetError(e?.message || "Could not load device links.");
  }
}

// =========================
// Utils
// =========================
function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
