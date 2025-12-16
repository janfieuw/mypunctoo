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
    const regAddr = [
      c.street,
      `${c.postalCode || ""} ${c.city || ""}`.trim(),
      c.country
    ].filter(Boolean).join("\n");

    const regEl = document.getElementById("cr-registered-address");
    if (regEl) {
      regEl.innerHTML = regAddr
        ? regAddr.split("\n").map(l => `${escapeHtml(l)}<br>`).join("")
        : "–";
    }

    // Main contact
    set(
      "cr-contact-name",
      `${c.contact?.firstName || ""} ${c.contact?.lastName || ""}`.trim()
    );

    // Billing
    set("cr-invoice-email", c.invoiceEmail || "");
    set("cr-billing-ref", c.billingReference || "–");

    // Delivery
    const delAddr = [
      c.delivery?.street,
      `${c.delivery?.postalCode || ""} ${c.delivery?.city || ""}`.trim(),
      c.delivery?.country
    ].filter(Boolean).join("\n");

    const delAddrEl = document.getElementById("cr-delivery-address");
    if (delAddrEl) {
      delAddrEl.innerHTML = delAddr
        ? delAddr.split("\n").map(l => `${escapeHtml(l)}<br>`).join("")
        : "Same as registered address.";
    }

    set(
      "cr-delivery-contact",
      c.deliveryContactPerson || c.registeredContactPerson || "–"
    );

    // Subscription meta (blijft rechtsboven)
    const metaEl = document.getElementById("client-status-meta");
    if (metaEl) {
      metaEl.innerHTML = `Subscription no.: <strong>${escapeHtml(c.subscriptionNumber || "–")}</strong><br>
        Start date: <strong>${escapeHtml(c.subscriptionStartDate || "–")}</strong>`;
    }

  } catch (e) {
    console.warn(e);
  }
}

