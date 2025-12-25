// public/js/app.js

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
          Could not load view <strong>${escapeHtml(viewName)}</strong>.
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
    clientBadge.textContent = isActive ? "Actief" : "Inactief";
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

  if (viewName === "users") {
    hydrateUsers();
  }

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
// Client record (NOW: DB-accurate)
// =========================
async function hydrateClientRecord() {
  try {
    const res = await apiFetch("/api/company", { cache: "no-cache" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Could not load company");

    const c = data.company || {};

    const set = (id, value) => {
      const el = document.getElementById(id);
      if (!el) return;
      const v = value === null || value === undefined || String(value).trim() === "" ? "–" : String(value);
      el.textContent = v;
    };

    const setAddress = (id, addressString) => {
      const el = document.getElementById(id);
      if (!el) return;
      const v =
        addressString === null || addressString === undefined || String(addressString).trim() === ""
          ? ""
          : String(addressString);

      el.innerHTML = v ? escapeHtml(v).replaceAll(", ", "<br>") : "–";
    };

    // Basis
    set("cr-name", c.name);
    set("cr-vat-number", c.vat_number);
    set("cr-customer-number", c.customer_number);
    set("cr-website", c.website);

    // Contact & facturatie
    set("cr-registered-contact", c.registered_contact_person);
    set("cr-billing-email", c.billing_email);
    set("cr-billing-reference", c.billing_reference);
    set("cr-delivery-contact", c.delivery_contact_person);

    // Zetel
    set("cr-registered-street", c.registered_street);
    set("cr-registered-box", c.registered_box);
    set("cr-registered-postal", c.registered_postal_code);
    set("cr-registered-city", c.registered_city);

    // Levering
    set("cr-delivery-street", c.delivery_street);
    set("cr-delivery-box", c.delivery_box);
    set("cr-delivery-postal", c.delivery_postal_code);
    set("cr-delivery-city", c.delivery_city);

    // Samenvatting zetel (bestaat echt als kolom)
    setAddress("cr-registered-address", c.registered_address);

    // Note: als alle levering velden leeg zijn -> levering = zetel
    const allDeliveryEmpty =
      !String(c.delivery_street || "").trim() &&
      !String(c.delivery_box || "").trim() &&
      !String(c.delivery_postal_code || "").trim() &&
      !String(c.delivery_city || "").trim();

    set("cr-delivery-note", allDeliveryEmpty ? "Leveringsadres = maatschappelijke zetel" : "—");

    // Meta (created_at + customer_number)
    const metaEl = document.getElementById("client-status-meta");
    if (metaEl) {
      metaEl.innerHTML = `Account aangemaakt: <strong>${escapeHtml(formatDateTimeISO(c.created_at))}</strong><br>
        Klantnummer: <strong>${escapeHtml(c.customer_number ?? "–")}</strong>`;
    }
  } catch (e) {
    console.warn(e);
  }
}

// =========================
// Users helpers (ongewijzigd)
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

function formatDateTimeISO(v) {
  if (!v) return "–";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

// =========================
// Device links + Users modules (zoals je had)
// =========================
// (Laat de rest van app.js staan zoals in jouw huidige file.)
// In jouw project zitten die functies er al onder (users/devices/schedule).

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
