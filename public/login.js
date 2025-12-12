// js/login.js
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
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.ok === false) {
      const msg = data.error || "Login failed.";
      throw new Error(msg);
    }

    return data;
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const email = (emailInput.value || "").trim();
      const password = passwordInput.value || "";

      if (!email || !password) {
        setStatus("Vul je e-mail en wachtwoord in.", true);
        return;
      }

      setStatus("");
      setLoading(true);

      try {
        const data = await callLogin(email, password);

        if (data.token) {
          window.localStorage.setItem(AUTH_TOKEN_KEY, data.token);
        }

        setStatus("Login succesvol.", false);

        const redirectUrl = data.redirectUrl || "/index.html";
        window.location.href = redirectUrl;
      } catch (err) {
        setStatus(err.message || "Login failed.", true);
      } finally {
        setLoading(false);
      }
    });
  }
})();
