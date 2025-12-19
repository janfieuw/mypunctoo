// js/app.js

const SUBSCRIPTION_STATUS_KEY = "mypunctoo_subscription_status";
const AUTH_TOKEN_KEY = "mypunctoo_auth_token";

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
    try { window.localStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
    window.location.href = "/login";
    return false;
  }
  return true;
}

async function loadView(viewName) {
  try {
    // ✅ IMPORTANT: absolute path so it works from /app as wellL
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
    try { window.localStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
    window.location.href = "/login";
  });
}

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

  if (viewName === "users") {
    hydrateUsers();
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
    const regAddrLines = [
      c.street,
      `${c.postalCode || ""} ${c.city || ""}`.trim(),
      c.country
    ].filter(Boolean);

    const regEl = document.getElementById("cr-registered-address");
    if (regEl) {
      regEl.innerHTML = regAddrLines.length
        ? regAddrLines.map(l => `${escapeHtml(l)}<br>`).join("")
        : "–";
    }

    // Main contact
    set("cr-contact-name", `${c.contact?.firstName || ""} ${c.contact?.lastName || ""}`.trim());

    // Billing
    set("cr-invoice-email", c.invoiceEmail || "");
    set("cr-billing-ref", c.billingReference || "–");

    // ✅ Delivery address: ALWAYS show an address (API guarantees it, but we keep UI fallback too)
    const del = c.delivery || {};
    const delAddrLines = [
      del.street || c.street,
      `${del.postalCode || c.postalCode || ""} ${del.city || c.city || ""}`.trim(),
      del.country || c.country
    ].filter(Boolean);

    const delAddrEl = document.getElementById("cr-delivery-address");
    if (delAddrEl) {
      delAddrEl.innerHTML = delAddrLines.length
        ? delAddrLines.map(l => `${escapeHtml(l)}<br>`).join("")
        : "–";
    }

    // Delivery contact (always fallback)
    set("cr-delivery-contact", c.deliveryContactPerson || c.registeredContactPerson || "–");

    // Subscription meta
    const metaEl = document.getElementById("client-status-meta");
    if (metaEl) {
      metaEl.innerHTML = `Subscription no.: <strong>${escapeHtml(c.subscriptionNumber || "–")}</strong><br>
        Start date: <strong>${escapeHtml(c.subscriptionStartDate || "–")}</strong>`;
    }
  } catch (e) {
    console.warn(e);
  }
}

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

function normalizeUpper(str) {
  return String(str || "").trim().toUpperCase();
}

function normalizeLower(str) {
  return String(str || "").trim().toLowerCase();
}

function formatDateISO(d) {
  if (!d) return "";
  // API returns dates as "YYYY-MM-DD..." (date or ISO)
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function statusLabel(status) {
  const s = normalizeLower(status);
  if (s === "inactive") return "INACTIVE";
  return "ACTIVE";
}

function statusBadgeClass(status) {
  const s = normalizeLower(status);
  return s === "inactive" ? "badge badge--inactive" : "badge badge--active";
}

async function usersFetchEmployees() {
  const res = await apiFetch("/api/employees", { cache: "no-cache" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "Could not load employees");
  return data.employees || [];
}

async function usersRenderEmployees() {
  const tbody = document.getElementById("users-tbody");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="5" class="table-empty">Loading…</td></tr>`;

  const employees = await usersFetchEmployees();

  if (!employees.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">No employees yet.</td></tr>`;
    return;
  }

  const rows = employees.map((e) => {
    const id = e.id;
    const code = e.employee_code || "";
    const fullName = `${e.first_name || ""} ${e.last_name || ""}`.trim();

    // Creation date is automatic -> show created_at
    const created = formatDateISO(e.created_at) || "–";

    const hasPunches = !!e.has_punches;
    const isInactive = normalizeLower(e.status) === "inactive";

    const toggleLabel = isInactive ? "SET ACTIVE" : "SET INACTIVE";

    // Delete is only allowed when there are NO punches
    const deleteBtn = hasPunches
      ? `<button class="users-btn users-btn--disabled" type="button" disabled title="Not allowed after first scan.">DELETE</button>`
      : `<button class="users-btn users-btn--danger" type="button" data-action="delete" data-id="${escapeHtml(id)}">DELETE</button>`;

    const toggleBtn = `<button class="users-btn users-btn--secondary" type="button" data-action="toggle" data-id="${escapeHtml(id)}" data-next="${escapeHtml(isInactive ? "active" : "inactive")}">${escapeHtml(toggleLabel)}</button>`;

    const actions = `<div class="users-actions">${toggleBtn}${deleteBtn}</div>`;

    return `
      <tr>
        <td>${escapeHtml(code)}</td>
        <td>${escapeHtml(fullName)}</td>
        <td><span class="${escapeHtml(statusBadgeClass(e.status))}">${escapeHtml(statusLabel(e.status))}</span></td>
        <td>${escapeHtml(created)}</td>
        <td>${actions}</td>
      </tr>
    `;
  });

  tbody.innerHTML = rows.join("");

  // Attach click handlers (event delegation)
  tbody.onclick = async (ev) => {
    const btn = ev.target && ev.target.closest && ev.target.closest("button[data-action]");
    if (!btn) return;

    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (!id) return;

    usersSetError("");

    try {
      if (action === "toggle") {
        const next = btn.dataset.next || "";
        btn.disabled = true;

        const r = await apiFetch(`/api/employees/${id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next })
        });

        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || "Could not update status");

        await usersRenderEmployees();
        await devicesRenderBindings();
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

async function hydrateUsers() {
  try {
    usersSetError("");
    devicesSetError("");

    // Create form handler
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
            body: JSON.stringify({
              first_name,
              last_name
            })
          });

          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error(j.error || "Could not create employee");

          // reset
          if (firstEl) firstEl.value = "";
          if (lastEl) lastEl.value = "";

          await usersRenderEmployees();
          await devicesRenderBindings();
        } catch (err) {
          console.warn(err);
          usersSetError(err?.message || "Something went wrong.");
        } finally {
          if (btn) btn.disabled = false;
        }
      };
    }

    await usersRenderEmployees();
    await devicesRenderBindings();
  } catch (e) {
    console.warn(e);
    usersSetError(e?.message || "Could not load users.");
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
