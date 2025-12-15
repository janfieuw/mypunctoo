const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { pool } = require('./db/db');

const app = express();
const PORT = process.env.PORT || 3000;
const rootDir = __dirname;

// =========================================================
// Middleware
// =========================================================
app.use(express.json());

app.use((req, res, next) => {
  if (!req.path.endsWith('.html')) return next();

  if (req.path.startsWith('/views/')) return next();
  if (req.path === '/login.html') return res.redirect(301, '/login');
  if (req.path === '/signup.html') return res.redirect(301, '/signup');
  if (req.path === '/index.html') return res.redirect(301, '/app');

  return res.status(404).send('Not found');
});

// =========================================================
// Static files
// =========================================================
app.use(express.static(path.join(rootDir, 'public')));

// =========================================================
// Public routes
// =========================================================
app.get('/', (_, res) => res.redirect('/login'));
app.get('/signup', (_, res) => res.sendFile(path.join(rootDir, 'public', 'signup.html')));
app.get('/login', (_, res) => res.sendFile(path.join(rootDir, 'public', 'login.html')));
app.get('/app', (_, res) => res.sendFile(path.join(rootDir, 'public', 'index.html')));

// =========================================================
// In-memory (alleen voor signup drafts + sessions)
// =========================================================
const signupTokens = new Map(); // signupToken -> { email, passHash, status, draftCompany }
const sessionsByToken = new Map(); // sessionToken -> { userId }

// =========================================================
// Helpers
// =========================================================
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const EU_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
  'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'
]);

function safeText(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function normalizeUpper(str) {
  return safeText(str).toUpperCase();
}

function normalizeLower(str) {
  return safeText(str).toLowerCase();
}

function getTokenFromRequest(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

async function requireAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req);
    if (!token || !sessionsByToken.has(token)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { userId } = sessionsByToken.get(token);

    const { rows } = await pool.query(
      'SELECT id, email, role, is_active, company_id FROM client_portal_users WHERE id = $1 LIMIT 1',
      [userId]
    );

    if (!rows.length || rows[0].is_active !== true) {
      sessionsByToken.delete(token);
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    req.auth = { token, user: rows[0] };
    next();
  } catch (err) {
    console.error('requireAuth error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
}

function isValidWebsite(url) {
  const v = safeText(url);
  if (!v) return true; // optional
  try {
    const u = new URL(v.startsWith('http') ? v : `https://${v}`);
    return ['http:', 'https:'].includes(u.protocol);
  } catch {
    return false;
  }
}

function intSafe(n, fallback = 0) {
  const x = parseInt(String(n || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function buildAddressLineFromFields(street, box, postalCode, city, countryCode) {
  const line = [
    safeText(street),
    safeText(box),
    [safeText(postalCode), safeText(city)].filter(Boolean).join(' ').trim(),
    safeText(countryCode)
  ].filter(Boolean).join(', ');
  return line;
}

function makeCompanyCode(companyName) {
  const base = safeText(companyName)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8);

  const suffix = String(Math.floor(1000 + Math.random() * 9000));
  return `${base || 'COMP'}-${suffix}`;
}

// =========================================================
// Pricing
// =========================================================
const PRICING = {
  startupFee: 49,
  monthlyFee: 9,
  extraPlatePrice: 39
};

// =========================================================
// DB helpers
// =========================================================
async function emailExists(emailLower) {
  const { rows } = await pool.query(
    'SELECT 1 FROM client_portal_users WHERE email = $1 LIMIT 1',
    [emailLower]
  );
  return rows.length > 0;
}

// =========================================================
// API: Signup step 1 (Account: email + password)
// =========================================================
app.post('/api/signup/step1', async (req, res) => {
  try {
    const { email, password, password_confirm } = req.body || {};

    if (!email || !password || !password_confirm) {
      return res.status(400).json({ ok: false, error: 'Missing required fields.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid e-mail address.' });
    }

    if (String(password).length < 8) {
      return res.status(400).json({ ok: false, error: 'Password too short.' });
    }

    if (password !== password_confirm) {
      return res.status(400).json({ ok: false, error: 'Passwords do not match.' });
    }

    const key = normalizeLower(email);
    if (await emailExists(key)) {
      return res.status(400).json({ ok: false, error: 'E-mail already registered.' });
    }

    const passHash = await bcrypt.hash(String(password), 10);

    const signupToken = uuidv4();
    signupTokens.set(signupToken, {
      email: key,
      passHash,
      status: 'pending_step2',
      draftCompany: null
    });

    res.json({ ok: true, signupToken });
  } catch (err) {
    console.error('signup step1 error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// API: Signup step 2 (Company details saved; no activation yet)
// =========================================================
app.post('/api/signup/step2', async (req, res) => {
  try {
    const {
      signup_token,
      email,
      password,

      company_name,
      enterprise_number,
      website,

      registered_contact_person,
      delivery_contact_person,

      registered_street,
      registered_box,
      registered_postal_code,
      registered_city,
      registered_country_code,

      billing_email,
      billing_reference,

      delivery_is_different,
      delivery_street,
      delivery_box,
      delivery_postal_code,
      delivery_city,
      delivery_country_code
    } = req.body || {};

    if (!signup_token || !signupTokens.has(signup_token)) {
      return res.status(400).json({ ok: false, error: 'Signup session expired.' });
    }

    const s = signupTokens.get(signup_token);

    const emailKey = normalizeLower(email || '');
    if (s.email !== emailKey) {
      return res.status(400).json({ ok: false, error: 'Invalid signup data.' });
    }

    const okPass = await bcrypt.compare(String(password || ''), s.passHash);
    if (!okPass) {
      return res.status(400).json({ ok: false, error: 'Invalid signup data.' });
    }

    if (s.status !== 'pending_step2') {
      return res.status(400).json({ ok: false, error: 'Unexpected signup state.' });
    }

    if (
      !company_name ||
      !enterprise_number ||
      !registered_contact_person ||
      !registered_street ||
      !registered_postal_code ||
      !registered_city ||
      !registered_country_code ||
      !billing_email
    ) {
      return res.status(400).json({ ok: false, error: 'Missing company fields.' });
    }

    const regCountry = normalizeUpper(registered_country_code);
    if (!EU_COUNTRIES.has(regCountry)) {
      return res.status(400).json({ ok: false, error: 'Invalid country code.' });
    }

    const billingEmailKey = normalizeLower(billing_email);
    if (!isValidEmail(billingEmailKey)) {
      return res.status(400).json({ ok: false, error: 'Invalid billing e-mail address.' });
    }

    const deliveryIsDifferent = !!delivery_is_different;

    let delCountry = '';
    if (deliveryIsDifferent) {
      if (
        !delivery_contact_person ||
        !delivery_street ||
        !delivery_postal_code ||
        !delivery_city ||
        !delivery_country_code
      ) {
        return res.status(400).json({ ok: false, error: 'Missing delivery address fields.' });
      }
      delCountry = normalizeUpper(delivery_country_code);
      if (!EU_COUNTRIES.has(delCountry)) {
        return res.status(400).json({ ok: false, error: 'Invalid delivery country code.' });
      }
    }

    if (!isValidWebsite(website)) {
      return res.status(400).json({ ok: false, error: 'Invalid website URL.' });
    }

    const websiteClean = safeText(website);
    const websiteNormalized = websiteClean
      ? normalizeLower(websiteClean.startsWith('http') ? websiteClean : `https://${websiteClean}`)
      : '';

    // ✅ Alles wat in dashboard/DB komt => HOOFDLETTERS (behalve email/website)
    s.draftCompany = {
      name: normalizeUpper(company_name),
      enterpriseNumber: normalizeUpper(enterprise_number),
      website: websiteNormalized || null,

      registeredContactPerson: normalizeUpper(registered_contact_person),
      deliveryContactPerson: deliveryIsDifferent ? normalizeUpper(delivery_contact_person) : null,

      registered: {
        street: normalizeUpper(registered_street),
        box: normalizeUpper(registered_box),
        postalCode: normalizeUpper(registered_postal_code),
        city: normalizeUpper(registered_city),
        countryCode: regCountry
      },

      billing: {
        email: billingEmailKey, // lowercase
        reference: normalizeUpper(billing_reference)
      },

      delivery: deliveryIsDifferent ? {
        street: normalizeUpper(delivery_street),
        box: normalizeUpper(delivery_box),
        postalCode: normalizeUpper(delivery_postal_code),
        city: normalizeUpper(delivery_city),
        countryCode: delCountry
      } : null
    };

    s.status = 'pending_step3';

    res.json({ ok: true });
  } catch (err) {
    console.error('signup step2 error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// API: Signup step 3 (Confirm order; create company + user in DB)
// =========================================================
app.post('/api/signup/step3', async (req, res) => {
  const client = await pool.connect();
  try {
    const { signup_token, email, password, extra_plates, sales_terms } = req.body || {};

    if (!signup_token || !signupTokens.has(signup_token)) {
      return res.status(400).json({ ok: false, error: 'Signup session expired.' });
    }

    const s = signupTokens.get(signup_token);

    const emailKey = normalizeLower(email || '');
    if (s.email !== emailKey) {
      return res.status(400).json({ ok: false, error: 'Invalid signup data.' });
    }

    const okPass = await bcrypt.compare(String(password || ''), s.passHash);
    if (!okPass) {
      return res.status(400).json({ ok: false, error: 'Invalid signup data.' });
    }

    if (s.status !== 'pending_step3' || !s.draftCompany) {
      return res.status(400).json({ ok: false, error: 'Missing company details.' });
    }

    if (!sales_terms) {
      return res.status(400).json({ ok: false, error: 'Sales terms must be accepted.' });
    }

    const qty = clamp(intSafe(extra_plates, 0), 0, 99);

    // race-safe check
    if (await emailExists(emailKey)) {
      return res.status(400).json({ ok: false, error: 'E-mail already registered.' });
    }

    await client.query('BEGIN');

    const c = s.draftCompany;

    // Registered (structured + legacy text)
    const regLine = buildAddressLineFromFields(
      c.registered.street,
      c.registered.box,
      c.registered.postalCode,
      c.registered.city,
      c.registered.countryCode
    );

    // Delivery (structured; if not different => mirror registered)
    const del = c.delivery ? c.delivery : c.registered;

    const delLine = buildAddressLineFromFields(
      del.street,
      del.box,
      del.postalCode,
      del.city,
      del.countryCode
    );

    // Billing (geen aparte billing velden in signup => mirror registered)
    const bill = c.registered;

    const billLine = buildAddressLineFromFields(
      bill.street,
      bill.box,
      bill.postalCode,
      bill.city,
      bill.countryCode
    );

    const companyCode = makeCompanyCode(c.name);

    // ✅ Correct insert: alles in eigen kolommen + legacy address fields ook netjes
    const compIns = await client.query(
      `INSERT INTO companies (
        company_code,
        name,
        vat_number,

        website,

        registered_contact_person,
        delivery_contact_person,

        registered_street,
        registered_box,
        registered_postal_code,
        registered_city,
        registered_country_code,

        billing_street,
        billing_box,
        billing_postal_code,
        billing_city,
        billing_country_code,

        delivery_street,
        delivery_box,
        delivery_postal_code,
        delivery_city,
        delivery_country_code,

        registered_address,
        billing_address,

        billing_email,
        billing_reference,

        estimated_user_count
      ) VALUES (
        $1,$2,$3,
        $4,
        $5,$6,
        $7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,
        $17,$18,$19,$20,$21,
        $22,$23,
        $24,$25,
        $26
      )
      RETURNING id`,
      [
        companyCode,
        c.name,
        c.enterpriseNumber || null,

        c.website || null,

        c.registeredContactPerson || null,
        (c.delivery ? c.deliveryContactPerson : c.registeredContactPerson) || null,

        c.registered.street || null,
        c.registered.box || null,
        c.registered.postalCode || null,
        c.registered.city || null,
        c.registered.countryCode || null,

        bill.street || null,
        bill.box || null,
        bill.postalCode || null,
        bill.city || null,
        bill.countryCode || null,

        del.street || null,
        del.box || null,
        del.postalCode || null,
        del.city || null,
        del.countryCode || null,

        regLine || null,
        billLine || null,

        c.billing?.email || null,      // lowercase
        c.billing?.reference || null,  // uppercase

        1
      ]
    );

    const companyId = compIns.rows[0].id;

    // Create user linked to company
    const userIns = await client.query(
      `INSERT INTO client_portal_users (email, password_hash, role, is_active, company_id)
       VALUES ($1,$2,'customer_admin', true, $3)
       RETURNING id`,
      [emailKey, s.passHash, companyId]
    );

    const userId = userIns.rows[0].id;

    await client.query('COMMIT');

    // end signup session
    signupTokens.delete(signup_token);

    res.json({
      ok: true,
      redirectUrl: '/login',
      order: {
        startupFeeExclVat: PRICING.startupFee,
        extraPlatesQty: qty,
        extraPlatePriceExclVat: PRICING.extraPlatePrice,
        totalTodayExclVat: PRICING.startupFee + (qty * PRICING.extraPlatePrice),
        monthlyExclVat: PRICING.monthlyFee,
        salesTermsAccepted: true
      },
      created: { userId, companyId }
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}

    console.error('signup step3 error:', err);

    if (String(err?.code) === '23505') {
      return res.status(400).json({ ok: false, error: 'E-mail already registered.' });
    }

    res.status(500).json({ ok: false, error: 'Server error.' });
  } finally {
    client.release();
  }
});

// =========================================================
// API: Login (DB)
// =========================================================
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const emailKey = normalizeLower(email || '');

    const { rows } = await pool.query(
      'SELECT id, email, password_hash, is_active FROM client_portal_users WHERE email = $1 LIMIT 1',
      [emailKey]
    );

    if (!rows.length || rows[0].is_active !== true) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
    }

    const ok = await bcrypt.compare(String(password), rows[0].password_hash);
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
    }

    const token = uuidv4();
    sessionsByToken.set(token, { userId: rows[0].id });

    res.json({ ok: true, token, redirectUrl: '/app' });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// API: Current user
// =========================================================
app.get('/api/me', requireAuth, async (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.auth.user.id,
      email: req.auth.user.email,
      role: req.auth.user.role,
      companyId: req.auth.user.company_id
    }
  });
});

// =========================================================
// API: Logout
// =========================================================
app.post('/api/logout', requireAuth, (req, res) => {
  sessionsByToken.delete(req.auth.token);
  res.json({ ok: true });
});

// =========================================================
// API: Company (companies) from DB
// =========================================================
app.get('/api/company', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    if (!companyId) return res.status(404).json({ ok: false });

    const { rows } = await pool.query(
      `SELECT
        id,
        company_code,
        name,
        vat_number,

        registered_contact_person,
        delivery_contact_person,

        website,

        registered_street,
        registered_box,
        registered_postal_code,
        registered_city,
        registered_country_code,

        billing_street,
        billing_box,
        billing_postal_code,
        billing_city,
        billing_country_code,

        delivery_street,
        delivery_box,
        delivery_postal_code,
        delivery_city,
        delivery_country_code,

        registered_address,
        billing_address,

        billing_email,
        billing_reference,

        estimated_user_count,
        created_at,
        updated_at
      FROM companies
      WHERE id = $1
      LIMIT 1`,
      [companyId]
    );

    if (!rows.length) return res.status(404).json({ ok: false });

    // Extra safeguard: force uppercase for displayed fields
    // (Email + website blijven lowercase)
    const r = rows[0];

    const company_code = safeText(r.company_code);
    const name = normalizeUpper(r.name);
    const vat_number = normalizeUpper(r.vat_number);

    const registered_contact_person = normalizeUpper(r.registered_contact_person);
    const delivery_contact_person = normalizeUpper(r.delivery_contact_person);

    const website = safeText(r.website) ? normalizeLower(r.website) : r.website;

    const registered_street = normalizeUpper(r.registered_street);
    const registered_box = normalizeUpper(r.registered_box);
    const registered_postal_code = normalizeUpper(r.registered_postal_code);
    const registered_city = normalizeUpper(r.registered_city);
    const registered_country_code = normalizeUpper(r.registered_country_code);

    const billing_street = normalizeUpper(r.billing_street);
    const billing_box = normalizeUpper(r.billing_box);
    const billing_postal_code = normalizeUpper(r.billing_postal_code);
    const billing_city = normalizeUpper(r.billing_city);
    const billing_country_code = normalizeUpper(r.billing_country_code);

    const delivery_street = normalizeUpper(r.delivery_street);
    const delivery_box = normalizeUpper(r.delivery_box);
    const delivery_postal_code = normalizeUpper(r.delivery_postal_code);
    const delivery_city = normalizeUpper(r.delivery_city);
    const delivery_country_code = normalizeUpper(r.delivery_country_code);

    const registered_address = normalizeUpper(r.registered_address);
    const billing_address = normalizeUpper(r.billing_address);

    const billing_email = safeText(r.billing_email) ? normalizeLower(r.billing_email) : r.billing_email;
    const billing_reference = normalizeUpper(r.billing_reference);

    // ---- FIX: maak ook het object dat app.js verwacht (camelCase + contact) ----
    const fullContact = safeText(registered_contact_person);
    const parts = fullContact.split(/\s+/).filter(Boolean);
    const firstName = parts.shift() || '';
    const lastName = parts.join(' ') || '';

    const company = {
      // app.js velden (camelCase)
      name,
      code: company_code,
      vatNumber: vat_number,
      billingPlan: '–', // (nog geen veld in DB)
      contact: {
        firstName,
        lastName,
        role: '',
        email: '' // contact-email bestaat niet in DB; invoiceEmail komt hieronder
      },
      employeeCount: r.estimated_user_count,
      invoiceEmail: billing_email || '',
      billingReference: billing_reference || '–',

      // geregistreerd adres (app.js toont dit)
      street: registered_street,
      postalCode: registered_postal_code,
      city: registered_city,
      country: registered_country_code,

      subscriptionNumber: '–',
      subscriptionStartDate: '–',

      // extra (handig/debug; stoort app.js niet)
      website: website || '',
      registeredContactPerson: registered_contact_person || '',
      deliveryContactPerson: delivery_contact_person || '',

      // legacy/extra address (optioneel)
      registeredAddressText: registered_address || '',
      billingAddressText: billing_address || '',

      // delivery & billing structured (optioneel)
      billing: {
        street: billing_street,
        box: billing_box,
        postalCode: billing_postal_code,
        city: billing_city,
        country: billing_country_code
      },
      delivery: {
        street: delivery_street,
        box: delivery_box,
        postalCode: delivery_postal_code,
        city: delivery_city,
        country: delivery_country_code
      }
    };

    res.json({ ok: true, company });
  } catch (err) {
    console.error('company error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// Health (DB check)
// =========================================================
app.get('/api/health', async (_, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (err) {
    console.error('DB healthcheck failed:', err);
    res.json({ ok: true, db: false });
  }
});

app.listen(PORT, () => {
  console.log(`MyPunctoo backend listening on port ${PORT}`);
});

