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

  function setLoading(isLoading) {
    if (!loginButton) return;
    loginButton.disabled = isLoading;
    loginButton.textContent = isLoading ? "Logging in..." : "Log in";
  }

  async function callLogin(email, password) {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.ok === false) {
      throw new Error(data.error || "Login failed.");
    }

    return data;
  }

  async function doLogin(e) {
    if (e) e.preventDefault();

    const email = (emailInput?.value || "").trim();
    const password = passwordInput?.value || "";

    if (!email || !password) {
      setStatus("Vul je e-mail en wachtwoord in.", true);
      return;
    }

    setStatus("");
    setLoading(true);

    try {
      const data = await callLogin(email, password);

      if (!data.token) {
        setStatus("Server gaf geen token terug.", true);
        return;
      }

      window.localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      window.location.href = data.redirectUrl || "/index.html";
    } catch (err) {
      setStatus(err?.message || "Login failed.", true);
    } finally {
      setLoading(false);
    }
  }

  // Bewijs dat JS actief is
  setStatus("JS loaded. Ready.", false);

  if (form) form.addEventListener("submit", doLogin);
  if (loginButton) loginButton.addEventListener("click", doLogin);
})();
