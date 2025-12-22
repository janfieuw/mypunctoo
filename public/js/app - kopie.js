// js/app.js

const SUBSCRIPTION_STATUS_KEY = "mypunctoo_subscription_status";
const AUTH_TOKEN_KEY = "mypunctoo_auth_token";

// =========================
// Local storage helpers
// =========================
function getAuthToken() {
  try {
    return window.localStorage.getItem(AUTH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function setAuthToken(token) {
  try {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token || "");
  } catch {}
}

function clearAuthToken() {
  try {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {}
}

function getSubscriptionStatus() {
  try {
    return window.localStorage.getItem(SUBSCRIPTION_STATUS_KEY) || "active";
  } catch {
    return "active";
  }
}

function setSubscriptionStatus(status) {
  try {
    window.localStorage.setItem(SUBSCRIPTION_STATUS_KEY, status || "active");
  } catch {}
}

// =========================
// Small HTML escape helper
// =========================
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// =========================
// Auth + Fetch
// =========================
async function apiFetch(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const token = getAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && !(opts.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, { ...opts, headers });
}

function requireAuthOnAppPages() {
  const token = getAuthToken();
  const isLogin = window.location.pathname.endsWith("/login") || window.location.pathname.endsWith("/login.html");
  const isSignup = window.location.pathname.endsWith("/signup") || window.location.pathname.endsWith("/signup.html");
  const isPunch = window.location.pathname.endsWith("/punch") || window.location.pathname.endsWith("/punch.html");
  const isHome = window.location.pathname === "/" || window.location.pathname.endsWith("/index.html");

  if (!token && !isLogin && !isSignup && !isPunch && !isHome) {
    window.location.href = "/login";
  }
}

// =========================
// Navigation
// =========================
function showView(viewId) {
  const views = document.querySelectorAll(".view");
  views.forEach((v) => v.classList.add("hidden"));

  const target = document.getElementById(viewId);
  if (target) target.classList.remove("hidden");
}

function setActiveMenu(menuId) {
  const items = document.querySelectorAll(".menu-item");
  items.forEach((i) => i.classList.remove("active"));

  const el = document.getElementById(menuId);
  if (el) el.classList.add("active");
}

function wireMenu() {
  const btnDashboard = document.getElementById("menu-dashboard");
  const btnClientRecord = document.getElementById("menu-client-record");
  const btnEmployees = document.getElementById("menu-employees");
  const btnDevices = document.getElementById("menu-devices");
  const btnRaw = document.getElementById("menu-raw");
  const btnReports = document.getElementById("menu-reports");
  const btnInvoices = document.getElementById("menu-invoices");
  const btnLogout = document.getElementById("menu-logout");

  if (btnDashboard) {
    btnDashboard.addEventListener("click", () => {
      setActiveMenu("menu-dashboard");
      showView("view-dashboard");
      hydrateDashboard();
    });
  }

  if (btnClientRecord) {
    btnClientRecord.addEventListener("click", () => {
      setActiveMenu("menu-client-record");
      showView("view-client-record");
      hydrateClientRecord();
    });
  }

  if (btnEmployees) {
    btnEmployees.addEventListener("click", () => {
      setActiveMenu("menu-employees");
      showView("view-employees");
      hydrateEmployees();
    });
  }

  if (btnDevices) {
    btnDevices.addEventListener("click", () => {
      setActiveMenu("menu-devices");
      showView("view-devices");
      hydrateDevices();
    });
  }

  if (btnRaw) {
    btnRaw.addEventListener("click", () => {
      setActiveMenu("menu-raw");
      showView("view-raw-data");
      hydrateRawData();
    });
  }

  if (btnReports) {
    btnReports.addEventListener("click", () => {
      setActiveMenu("menu-reports");
      showView("view-reports");
      hydrateReports();
    });
  }

  if (btnInvoices) {
    btnInvoices.addEventListener("click", () => {
      setActiveMenu("menu-invoices");
      showView("view-invoices");
      hydrateInvoices();
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      try {
        await apiFetch("/api/logout", { method: "POST" });
      } catch {}
      clearAuthToken();
      window.location.href = "/login";
    });
  }
}

// =========================
// Dashboard
// =========================
async function hydrateDashboard() {
  try {
    const r = await apiFetch("/api/stats", { cache: "no-cache" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "Could not load stats");

    const s = data.stats || {};
    const elUsers = document.getElementById("dash-users-count");
    const elUsersActive = document.getElementById("dash-users-active-count");
    const elCheckins = document.getElementById("dash-checkins-today");

    if (elUsers) elUsers.textContent = String(s.employeesTotal ?? "–");
    if (elUsersActive) elUsersActive.textContent = String(s.employeesActive ?? "–");
    if (elCheckins) elCheckins.textContent = String(s.checkinsToday ?? "–");
  } catch (e) {
    console.warn(e);
  }
}

// =========================
// Client record
// =========================
function setToggleUI(isActive) {
  const badge = document.getElementById("client-status-badge");
  const toggle = document.getElementById("subscription-toggle");
  const state = document.getElementById("toggle-state");

  if (badge) {
    badge.textContent = isActive ? "Active" : "Inactive";
    badge.classList.toggle("client-status-badge--active", isActive);
    badge.classList.toggle("client-status-badge--inactive", !isActive);
  }

  if (toggle) toggle.checked = !isActive;
  if (state) state.textContent = isActive ? "ON" : "OFF";
}

function wireSubscriptionToggle() {
  const toggle = document.getElementById("subscription-toggle");
  const modal = document.getElementById("deactivate-modal");
  const cancelBtn = document.getElementById("cancel-deactivate");
  const confirmBtn = document.getElementById("confirm-deactivate");

  if (!toggle) return;

  toggle.addEventListener("change", () => {
    const current = getSubscriptionStatus();
    const isActive = current === "active";

    // if switching to inactive -> open modal
    if (isActive && toggle.checked) {
      if (modal) modal.classList.add("open");
      toggle.checked = false; // revert UI until confirmed
      return;
    }

    // switching back to active -> immediate
    if (!isActive && !toggle.checked) {
      setSubscriptionStatus("active");
      setToggleUI(true);
    }
  });

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      if (modal) modal.classList.remove("open");
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      setSubscriptionStatus("inactive");
      setToggleUI(false);
      if (modal) modal.classList.remove("open");
    });
  }

  // Close modal on backdrop click
  if (modal) {
    modal.addEventListener("click", (e) => {
      const target = e.target;
      if (target && target.classList.contains("modal-backdrop")) {
        modal.classList.remove("open");
      }
    });
  }
}

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

    // Contract start (account creation date)
    const contractStartRaw =
      c.contractStartDate || c.contract_start_date || c.createdAt || c.created_at || null;
    const csEl = document.getElementById("cr-contract-start");
    if (csEl) {
      if (contractStartRaw) {
        const d = new Date(contractStartRaw);
        csEl.textContent = isNaN(d.getTime()) ? "–" : d.toLocaleDateString("nl-BE");
      } else {
        csEl.textContent = "–";
      }
    }

    // Registered address
    const regAddrLines = [c.street, `${c.postalCode || ""} ${c.city || ""}`.trim(), c.country].filter(Boolean);
    const regEl = document.getElementById("cr-registered-address");
    if (regEl) {
      regEl.innerHTML = regAddrLines.length ? regAddrLines.map((l) => `${escapeHtml(l)}<br>`).join("") : "–";
    }

    // Main contact
    set("cr-contact-name", c.registeredContactPerson || "");
    const roleEl = document.getElementById("cr-contact-role");
    if (roleEl) roleEl.textContent = ""; // reserved

    // Invoices
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
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function usersCloseModal() {
  const modal = document.getElementById("user-modal");
  if (modal) modal.classList.remove("open");
}

function usersOpenModal() {
  const modal = document.getElementById("user-modal");
  if (modal) modal.classList.add("open");
}

// =========================
// Employees
// =========================
async function hydrateEmployees() {
  try {
    usersSetError("");

    const r = await apiFetch("/api/employees", { cache: "no-cache" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "Could not load employees");

    const list = Array.isArray(data.employees) ? data.employees : [];
    const tbody = document.getElementById("employees-tbody");
    if (!tbody) return;

    tbody.innerHTML = "";

    for (const e of list) {
      const tr = document.createElement("tr");

      const tdCode = document.createElement("td");
      tdCode.textContent = e.employee_code || "–";
      tr.appendChild(tdCode);

      const tdFirst = document.createElement("td");
      tdFirst.textContent = e.first_name || "–";
      tr.appendChild(tdFirst);

      const tdLast = document.createElement("td");
      tdLast.textContent = e.last_name || "–";
      tr.appendChild(tdLast);

      const tdStatus = document.createElement("td");
      tdStatus.textContent = (e.status || "–").toUpperCase();
      tr.appendChild(tdStatus);

      const tdActions = document.createElement("td");
      tdActions.className = "actions-cell";

      const btnSchedule = document.createElement("button");
      btnSchedule.className = "btn btn-secondary";
      btnSchedule.textContent = "Working schedule";
      btnSchedule.addEventListener("click", () => openScheduleModal(e));
      tdActions.appendChild(btnSchedule);

      const btnToggle = document.createElement("button");
      btnToggle.className = "btn btn-secondary";
      btnToggle.textContent = (String(e.status).toLowerCase() === "active") ? "Deactivate" : "Activate";
      btnToggle.addEventListener("click", () => toggleEmployeeStatus(e));
      tdActions.appendChild(btnToggle);

      const btnDelete = document.createElement("button");
      btnDelete.className = "btn btn-danger";
      btnDelete.textContent = "Delete";
      btnDelete.addEventListener("click", () => deleteEmployee(e));
      tdActions.appendChild(btnDelete);

      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }

    const addBtn = document.getElementById("employees-add-btn");
    if (addBtn) {
      addBtn.onclick = () => {
        const modal = document.getElementById("employee-add-modal");
        if (modal) modal.classList.add("open");
      };
    }
  } catch (e) {
    usersSetError(e.message || "Server error.");
  }
}

async function toggleEmployeeStatus(emp) {
  try {
    const newStatus = String(emp.status || "").toLowerCase() === "active" ? "inactive" : "active";
    const r = await apiFetch(`/api/employees/${emp.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: newStatus })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "Could not update status");
    await hydrateEmployees();
    await hydrateDashboard();
  } catch (e) {
    usersSetError(e.message || "Server error.");
  }
}

async function deleteEmployee(emp) {
  try {
    if (!confirm("Delete this employee? This cannot be undone.")) return;

    const r = await apiFetch(`/api/employees/${emp.id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || "Could not delete employee");
    }

    await hydrateEmployees();
    await hydrateDashboard();
  } catch (e) {
    usersSetError(e.message || "Server error.");
  }
}

function wireEmployeeAddModal() {
  const modal = document.getElementById("employee-add-modal");
  const closeBtn = document.getElementById("employee-add-close");
  const cancelBtn = document.getElementById("employee-add-cancel");
  const saveBtn = document.getElementById("employee-add-save");

  if (closeBtn) closeBtn.addEventListener("click", () => modal && modal.classList.remove("open"));
  if (cancelBtn) cancelBtn.addEventListener("click", () => modal && modal.classList.remove("open"));

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      try {
        usersSetError("");

        const first = document.getElementById("employee-add-first")?.value || "";
        const last = document.getElementById("employee-add-last")?.value || "";

        const r = await apiFetch("/api/employees", {
          method: "POST",
          body: JSON.stringify({ first_name: first, last_name: last })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data.error || "Could not add employee");

        if (modal) modal.classList.remove("open");
        await hydrateEmployees();
        await hydrateDashboard();
      } catch (e) {
        usersSetError(e.message || "Server error.");
      }
    });
  }

  if (modal) {
    modal.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.classList.contains("modal-backdrop")) {
        modal.classList.remove("open");
      }
    });
  }
}

// =========================
// Working schedule modal
// =========================
function minutesFromInput(id) {
  const v = document.getElementById(id)?.value ?? "";
  const n = Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function wireScheduleModal() {
  const modal = document.getElementById("schedule-modal");
  const closeBtn = document.getElementById("schedule-close");
  const cancelBtn = document.getElementById("schedule-cancel");
  const saveBtn = document.getElementById("schedule-save");

  if (closeBtn) closeBtn.addEventListener("click", () => modal && modal.classList.remove("open"));
  if (cancelBtn) cancelBtn.addEventListener("click", () => modal && modal.classList.remove("open"));

  if (modal) {
    modal.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.classList.contains("modal-backdrop")) {
        modal.classList.remove("open");
      }
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      try {
        const employeeId = Number(modal?.dataset?.employeeId || 0);
        if (!employeeId) return;

        const schedule = [];
        for (let weekday = 0; weekday <= 6; weekday++) {
          const expected = minutesFromInput(`sch-exp-${weekday}`);
          const brk = minutesFromInput(`sch-brk-${weekday}`);
          schedule.push({ weekday, expected_minutes: expected, break_minutes: brk });
        }

        const r = await apiFetch(`/api/employees/${employeeId}/expected-schedule`, {
          method: "PUT",
          body: JSON.stringify({ schedule })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data.error || "Could not save schedule");

        modal.classList.remove("open");
        await hydrateEmployees();
      } catch (e) {
        usersSetError(e.message || "Server error.");
      }
    });
  }
}

async function openScheduleModal(emp) {
  try {
    usersSetError("");
    const modal = document.getElementById("schedule-modal");
    if (!modal) return;

    modal.dataset.employeeId = String(emp.id);

    const r = await apiFetch(`/api/employees/${emp.id}/expected-schedule`, { cache: "no-cache" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "Could not load schedule");

    const rows = Array.isArray(data.schedule) ? data.schedule : [];
    const map = new Map();
    for (const row of rows) map.set(Number(row.weekday), row);

    for (let weekday = 0; weekday <= 6; weekday++) {
      const row = map.get(weekday) || { expected_minutes: 0, break_minutes: 0 };
      const expEl = document.getElementById(`sch-exp-${weekday}`);
      const brkEl = document.getElementById(`sch-brk-${weekday}`);
      if (expEl) expEl.value = String(row.expected_minutes ?? 0);
      if (brkEl) brkEl.value = String(row.break_minutes ?? 0);
    }

    modal.classList.add("open");
  } catch (e) {
    usersSetError(e.message || "Server error.");
  }
}

// =========================
// Devices
// =========================
async function hydrateDevices() {
  try {
    const r = await apiFetch("/api/devices", { cache: "no-cache" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "Could not load devices");

    const list = Array.isArray(data.devices) ? data.devices : [];
    const tbody = document.getElementById("devices-tbody");
    if (!tbody) return;

    tbody.innerHTML = "";

    for (const d of list) {
      const tr = document.createElement("tr");

      const tdDevice = document.createElement("td");
      tdDevice.textContent = d.device_id || "–";
      tr.appendChild(tdDevice);

      const tdEmp = document.createElement("td");
      const name = [d.first_name, d.last_name].filter(Boolean).join(" ").trim();
      tdEmp.textContent = name || "–";
      tr.appendChild(tdEmp);

      const tdCode = document.createElement("td");
      tdCode.textContent = d.employee_code || "–";
      tr.appendChild(tdCode);

      const tdLast = document.createElement("td");
      tdLast.textContent = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("nl-BE") : "–";
      tr.appendChild(tdLast);

      const tdActions = document.createElement("td");
      const btn = document.createElement("button");
      btn.className = "btn btn-danger";
      btn.textContent = "Unlink";
      btn.addEventListener("click", () => unlinkDevice(d.device_id));
      tdActions.appendChild(btn);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  } catch (e) {
    console.warn(e);
  }
}

async function unlinkDevice(deviceId) {
  try {
    if (!confirm("Unlink this device?")) return;

    const r = await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "Could not unlink device");

    await hydrateDevices();
  } catch (e) {
    console.warn(e);
  }
}

// =========================
// Raw data / Reports / Invoices
// (placeholders - kept as-is)
// =========================
async function hydrateRawData() {
  // Intentionally left minimal (existing implementation)
}

async function hydrateReports() {
  // Intentionally left minimal (existing implementation)
}

async function hydrateInvoices() {
  // Intentionally left minimal (existing implementation)
}

// =========================
// Boot
// =========================
document.addEventListener("DOMContentLoaded", () => {
  requireAuthOnAppPages();
  wireMenu();
  wireSubscriptionToggle();
  wireEmployeeAddModal();
  wireScheduleModal();

  // Default view
  setActiveMenu("menu-dashboard");
  showView("view-dashboard");
  hydrateDashboard();
});
