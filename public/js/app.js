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
    const response = await fetch(`views/${viewName}.html`, { cache: "no-cache" });
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

async function hydrateUsers() {
  try {
    const res = await apiFetch("/api/employees", { cache: "no-cache" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Could not load users");

    const tbody = document.getElementById("users-tbody");
    if (!tbody) return;

    const rows = (data.employees || []).map((u) => {
      const end = u.endDate ? escapeHtml(u.endDate) : "–";
      return `
        <tr>
          <td>${escapeHtml(u.id)}</td>
          <td>${escapeHtml(`${u.firstName} ${u.lastName}`)}</td>
          <td>${escapeHtml(u.status)}</td>
          <td>${escapeHtml(u.startDate || "–")}</td>
          <td>${end}</td>
        </tr>
      `;
    });

    tbody.innerHTML = rows.join("") || `
      <tr><td colspan="5" class="table-empty">No users yet.</td></tr>
    `;
  } catch (e) {
    console.warn(e);
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
