// /js/login.js
(function () {
  const form = document.getElementById("loginForm");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const statusEl = document.getElementById("status");
  const loginButton = document.getElementById("loginButton");

  const AUTH_TOKEN_KEY = "mypunctoo_auth_token";

  function setStatus(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.classList.toggle("status--error", !!isError);
    statusEl.classList.toggle("status--ok", !isError && !!message);
  }

  function setLoading(loading) {
    if (loginButton) {
      loginButton.disabled = !!loading;
      loginButton.classList.toggle("btn--loading", !!loading);
    }
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  }

  async function doLogin(e) {
    if (e) e.preventDefault();

    const email = String(emailInput?.value || "").trim().toLowerCase();
    const password = String(passwordInput?.value || "");

    setStatus("");

    if (!email || !password) {
      setStatus("Vul e-mail en wachtwoord in.", true);
      return;
    }
    if (!isValidEmail(email)) {
      setStatus("Ongeldig e-mailadres.", true);
      return;
    }

    setLoading(true);
    setStatus("Aanmelden...");

    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      const data = await r.json().catch(() => ({}));

      if (!r.ok || !data.ok) {
        setStatus(data.error || "Aanmelden mislukt.", true);
        return;
      }

      if (!data.token) {
        setStatus("Interne fout: token ontbreekt.", true);
        return;
      }

      // ✅ token opslaan zoals app.js verwacht
      window.localStorage.setItem(AUTH_TOKEN_KEY, data.token);

      // ✅ dashboard = "/" (index.html), NIET "/app"
      window.location.href = data.redirectUrl || "/";
    } catch (err) {
      setStatus("Netwerkfout tijdens aanmelden.", true);
    } finally {
      setLoading(false);
    }
  }

  if (form) form.addEventListener("submit", doLogin);
  if (loginButton) loginButton.addEventListener("click", doLogin);
})();
