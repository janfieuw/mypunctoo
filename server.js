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

const LOWER_WORDS = new Set(['de','der','den','van','von','da','di','la','le','du','des','of','and']);
function toTitleCase(str) {
  const s = safeText(str);
  if (!s) return '';
  return s
    .toLowerCase()
    .split(/(\s+|-|')/g)
    .map((part, idx) => {
      if (part.match(/^\s+|-|'$/)) return part;
      if (idx !== 0 && LOWER_WORDS.has(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');
}

function normalizeUpper(str) {
  return safeText(str).toUpperCase();
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

function buildAddressLine(addr) {
  if (!addr) return '';
  const line = [
    safeText(addr.street),
    safeText(addr.box),
    [safeText(addr.postalCode), safeText(addr.city)].filter(Boolean).join(' ').trim(),
    safeText(addr.country)
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

    const key = String(email).trim().toLowerCase();
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

      // ✅ NEW
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

    const emailKey = String(email || '').trim().toLowerCase();
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
      !registered_contact_person || // ✅ NEW required
      !registered_street ||
      !registered_postal_code ||
      !registered_city ||
      !registered_country_code ||
      !billing_email
    ) {
      return res.status(400).json({ ok: false, error: 'Missing company fields.' });
    }

    const regCountry = String(registered_country_code).toUpperCase();
    if (!EU_COUNTRIES.has(regCountry)) {
      return res.status(400).json({ ok: false, error: 'Invalid country code.' });
    }

    const billingEmailKey = String(billing_email).trim().toLowerCase();
    if (!isValidEmail(billingEmailKey)) {
      return res.status(400).json({ ok: false, error: 'Invalid billing e-mail address.' });
    }

    const deliveryIsDifferent = !!delivery_is_different;

    let delCountry = '';
    if (deliveryIsDifferent) {
      if (
        !delivery_contact_person || // ✅ NEW required if delivery differs
        !delivery_street ||
        !delivery_postal_code ||
        !delivery_city ||
        !delivery_country_code
      ) {
        return res.status(400).json({ ok: false, error: 'Missing delivery address fields.' });
      }
      delCountry = String(delivery_country_code).toUpperCase();
      if (!EU_COUNTRIES.has(delCountry)) {
        return res.status(400).json({ ok: false, error: 'Invalid delivery country code.' });
      }
    }

    if (!isValidWebsite(website)) {
      return res.status(400).json({ ok: false, error: 'Invalid website URL.' });
    }

    const websiteClean = safeText(website);
    const websiteNormalized = websiteClean
      ? (websiteClean.startsWith('http') ? websiteClean : `https://${websiteClean}`)
      : '';

    s.draftCompany = {
      name: toTitleCase(company_name),
      enterpriseNumber: normalizeUpper(enterprise_number),
      website: websiteNormalized || null,

      // ✅ NEW (kept separate for later use)
      registeredContactPerson: toTitleCase(registered_contact_person),
      deliveryContactPerson: deliveryIsDifferent ? toTitleCase(delivery_contact_person) : null,

      registeredAddress: {
        street: toTitleCase(registered_street),
        box: normalizeUpper(registered_box),
        postalCode: safeText(registered_postal_code),
        city: toTitleCase(registered_city),
        country: regCountry
      },

      billing: {
        email: billingEmailKey,
        reference: toTitleCase(billing_reference)
      },

      deliveryAddress: deliveryIsDifferent ? {
        street: toTitleCase(delivery_street),
        box: normalizeUpper(delivery_box),
        postalCode: safeText(delivery_postal_code),
        city: toTitleCase(delivery_city),
        country: delCountry
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

    const emailKey = String(email || '').trim().toLowerCase();
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

    // Build address text blocks (keeps DB schema unchanged)
    const regLine = buildAddressLine(c.registeredAddress);
    const delLine = buildAddressLine(c.deliveryAddress);

    const registeredAddressTextParts = [
      `CONTACT PERSON: ${safeText(c.registeredContactPerson)}`,
      regLine
    ].filter(Boolean);

    // If delivery differs, store it as extra lines in the registered_address text
    if (c.deliveryAddress) {
      registeredAddressTextParts.push(
        '',
        `DELIVERY CONTACT PERSON: ${safeText(c.deliveryContactPerson)}`,
        delLine
      );
    }

    const registeredAddressText = registeredAddressTextParts.join('\n');
    const billingAddressText = registeredAddressText; // consistent with current behaviour

    const companyCode = makeCompanyCode(c.name);

    // Create company (mapped to your existing schema)
    const compIns = await client.query(
      `INSERT INTO companies (
        company_code,
        name,
        vat_number,
        registered_address,
        billing_address,
        billing_email,
        billing_reference,
        estimated_user_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id`,
      [
        companyCode,
        c.name,
        c.enterpriseNumber || null,
        registeredAddressText || null,
        billingAddressText || null,
        c.billing?.email || null,
        c.billing?.reference || null,
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
    const emailKey = String(email || '').trim().toLowerCase();

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

    res.json({ ok: true, company: rows[0] });
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
