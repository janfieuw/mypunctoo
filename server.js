const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
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

function formatYYYYMMDD(d = new Date()) {
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const t = safeText(v);
    if (t) return t;
  }
  return '';
}

// =========================================================
// Employee identifiers (AUTO)
// - employee_no: 1..9999 per company (toon als 0001)
// - employee_code: random A-Z0-9
// =========================================================
function genEmployeeCode(len = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[crypto.randomInt(0, chars.length)];
  }
  return out;
}

function formatEmployeeNo(no) {
  const n = Number(no);
  if (!Number.isFinite(n)) return '';
  return String(n).padStart(4, '0');
}

async function ensureEmployeeCounterTable() {
  // Safe create
  await pool.query(
    `CREATE TABLE IF NOT EXISTS company_employee_counters (
      company_id INTEGER PRIMARY KEY,
      last_employee_no INTEGER NOT NULL DEFAULT 0
    )`
  );
}

async function allocateNextEmployeeNo(client, companyId) {
  // Ensure counter row exists
  await client.query(
    `INSERT INTO company_employee_counters (company_id, last_employee_no)
     VALUES ($1, 0)
     ON CONFLICT (company_id) DO NOTHING`,
    [companyId]
  );

  // Lock row
  const counterRes = await client.query(
    `SELECT last_employee_no
     FROM company_employee_counters
     WHERE company_id = $1
     FOR UPDATE`,
    [companyId]
  );

  const last = counterRes.rows[0] ? Number(counterRes.rows[0].last_employee_no) : 0;
  const nextNo = last + 1;

  if (nextNo > 9999) {
    throw new Error('EMPLOYEE_LIMIT_REACHED');
  }

  await client.query(
    `UPDATE company_employee_counters
     SET last_employee_no = $2
     WHERE company_id = $1`,
    [companyId, nextNo]
  );

  return nextNo;
}

async function createEmployeeAutoIdentifiers(client, companyId) {
  // Transaction expected by caller
  const employeeNo = await allocateNextEmployeeNo(client, companyId);

  // Generate code and ensure uniqueness (per company)
  for (let i = 0; i < 10; i++) {
    const code = genEmployeeCode(10);

    // Check uniqueness (fast path)
    const exists = await client.query(
      `SELECT 1
       FROM employees
       WHERE company_id = $1 AND employee_code = $2
       LIMIT 1`,
      [companyId, code]
    );
    if (exists.rows.length) continue;

    return { employeeNo, employeeCode: code };
  }

  throw new Error('EMPLOYEE_CODE_GENERATION_FAILED');
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

    const bill = c.registered;

    const billLine = buildAddressLineFromFields(
      bill.street,
      bill.box,
      bill.postalCode,
      bill.city,
      bill.countryCode
    );

    const companyCode = makeCompanyCode(c.name);

    // =========================================================
    // ✅ CUSTOMER NUMBER (globale teller)
    // =========================================================
    const yyyymmdd = formatYYYYMMDD(new Date());

    const counterRes = await client.query(
      `UPDATE customer_number_counter
       SET last_seq = last_seq + 1
       WHERE id = 1
       RETURNING last_seq`
    );

    if (!counterRes.rows.length) {
      throw new Error('Customer number counter not initialized.');
    }

    const globalSeq = counterRes.rows[0].last_seq;
    const customerNumber = `PUN-${yyyymmdd}${String(globalSeq).padStart(9, '0')}`;

    const compIns = await client.query(
      `INSERT INTO companies (
        customer_number,

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
        $1,

        $2,$3,$4,
        $5,

        $6,$7,

        $8,$9,$10,$11,$12,

        $13,$14,$15,$16,$17,

        $18,$19,$20,$21,$22,

        $23,$24,

        $25,$26,

        $27
      )
      RETURNING id`,
      [
        customerNumber,

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

        // ✅ delivery ALTIJD ingevuld: ofwel delivery uit form, ofwel mirror registered
        del.street || null,
        del.box || null,
        del.postalCode || null,
        del.city || null,
        del.countryCode || null,

        regLine || null,
        billLine || null,

        c.billing?.email || null,
        c.billing?.reference || null,

        1
      ]
    );

    const companyId = compIns.rows[0].id;

    const userIns = await client.query(
      `INSERT INTO client_portal_users (email, password_hash, role, is_active, company_id)
       VALUES ($1,$2,'customer_admin', true, $3)
       RETURNING id`,
      [emailKey, s.passHash, companyId]
    );

    const userId = userIns.rows[0].id;

    await client.query('COMMIT');

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
        customer_number,

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

        delivery_street,
        delivery_box,
        delivery_postal_code,
        delivery_city,
        delivery_country_code,

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

    const r = rows[0];

    // Registered (upper)
    const regStreet = normalizeUpper(r.registered_street);
    const regBox = normalizeUpper(r.registered_box);
    const regPostal = normalizeUpper(r.registered_postal_code);
    const regCity = normalizeUpper(r.registered_city);
    const regCountry = normalizeUpper(r.registered_country_code);

    // Delivery raw (upper) - may be empty for older records
    const delStreetRaw = normalizeUpper(r.delivery_street);
    const delBoxRaw = normalizeUpper(r.delivery_box);
    const delPostalRaw = normalizeUpper(r.delivery_postal_code);
    const delCityRaw = normalizeUpper(r.delivery_city);
    const delCountryRaw = normalizeUpper(r.delivery_country_code);

    // ✅ Delivery ALWAYS: field-by-field fallback to registered
    const delStreet = firstNonEmpty(delStreetRaw, regStreet);
    const delBox = firstNonEmpty(delBoxRaw, regBox);
    const delPostal = firstNonEmpty(delPostalRaw, regPostal);
    const delCity = firstNonEmpty(delCityRaw, regCity);
    const delCountry = firstNonEmpty(delCountryRaw, regCountry);

    const registered_contact_person = normalizeUpper(r.registered_contact_person);
    const delivery_contact_person = normalizeUpper(r.delivery_contact_person);

    const contactName = safeText(registered_contact_person);
    const parts = contactName.split(/\s+/).filter(Boolean);
    const firstName = parts.shift() || '';
    const lastName = parts.join(' ') || '';

    const company = {
      customerNumber: safeText(r.customer_number) || '–',

      name: normalizeUpper(r.name),
      vatNumber: normalizeUpper(r.vat_number),

      contact: { firstName, lastName, role: '', email: '' },

      invoiceEmail: safeText(r.billing_email) ? normalizeLower(r.billing_email) : '',
      billingReference: normalizeUpper(r.billing_reference) || '–',

      // registered (for display)
      street: regStreet,
      postalCode: regPostal,
      city: regCity,
      country: regCountry,

      // ✅ delivery ALWAYS present
      delivery: {
        street: delStreet,
        box: delBox,
        postalCode: delPostal,
        city: delCity,
        country: delCountry
      },

      // ✅ delivery contact ALWAYS: fallback to registered contact
      registeredContactPerson: registered_contact_person || '',
      deliveryContactPerson: safeText(delivery_contact_person) ? delivery_contact_person : (registered_contact_person || ''),

      subscriptionNumber: '–',
      subscriptionStartDate: '–'
    };

    res.json({ ok: true, company });
  } catch (err) {
    console.error('company error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// API: Employees - LIST (includes has_punches for UI rules)
// =========================================================
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    if (!companyId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { rows } = await pool.query(
      `SELECT
         e.id,
         e.company_id,
         e.employee_no,
         e.employee_code,
         e.first_name,
         e.last_name,
         e.email,
         e.phone,
         e.start_date,
         e.end_date,
         e.status,
         e.created_at,
         e.updated_at,
         EXISTS (
           SELECT 1
           FROM punches p
           WHERE p.employee_id = e.id
             AND p.company_id = e.company_id
           LIMIT 1
         ) AS has_punches
       FROM employees e
       WHERE e.company_id = $1
       ORDER BY e.last_name ASC, e.first_name ASC, e.id ASC`,
      [companyId]
    );

    // add formatted display field (does not change DB)
    const employees = rows.map(r => ({
      ...r,
      employee_no_display: formatEmployeeNo(r.employee_no)
    }));

    res.json({ ok: true, employees });
  } catch (err) {
    console.error('employees list error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// API: Employees - CREATE
// ✅ employee_no + employee_code are AUTO
// =========================================================
app.post('/api/employees', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = req.auth.user.company_id;
    if (!companyId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const first_name = normalizeUpper(req.body?.first_name || '');
    const last_name = normalizeUpper(req.body?.last_name || '');
    const email = safeText(req.body?.email) ? normalizeLower(req.body?.email) : null;
    const phone = safeText(req.body?.phone) ? safeText(req.body?.phone) : null;

    // start_date is NOT NULL in your DB
    const start_date = safeText(req.body?.start_date) || null;

    // DB constraint expects lowercase values
    const statusRaw = safeText(req.body?.status) || 'active';
    const status = normalizeLower(statusRaw);

    if (!first_name || !last_name) {
      return res.status(400).json({ ok: false, error: 'Missing required fields.' });
    }

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status. Use 'active' or 'inactive'." });
    }

    // start_date fallback: today
    const startDateValue = start_date ? start_date : new Date().toISOString().slice(0, 10);

    await client.query('BEGIN');

    const { employeeNo, employeeCode } = await createEmployeeAutoIdentifiers(client, companyId);

    const { rows } = await client.query(
      `INSERT INTO employees (
         company_id,
         employee_no,
         employee_code,
         first_name,
         last_name,
         email,
         phone,
         start_date,
         end_date,
         status,
         created_at,
         updated_at
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,NOW(),NOW()
       )
       RETURNING
         id,
         company_id,
         employee_no,
         employee_code,
         first_name,
         last_name,
         email,
         phone,
         start_date,
         end_date,
         status,
         created_at,
         updated_at`,
      [companyId, employeeNo, employeeCode, first_name, last_name, email, phone, startDateValue, status]
    );

    await client.query('COMMIT');

    const employee = rows[0];
    res.status(201).json({
      ok: true,
      employee: {
        ...employee,
        employee_no_display: formatEmployeeNo(employee.employee_no)
      }
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('employee create error:', err);

    if (String(err?.message) === 'EMPLOYEE_LIMIT_REACHED') {
      return res.status(409).json({ ok: false, error: 'Employee limit reached (9999).' });
    }

    res.status(500).json({ ok: false, error: 'Server error.' });
  } finally {
    client.release();
  }
});

// =========================================================
// API: Employees - STATUS (Set inactive / reactivate)
// =========================================================
app.patch('/api/employees/:id/status', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    const employeeId = Number(req.params.id);

    if (!Number.isFinite(employeeId)) {
      return res.status(400).json({ ok: false, error: 'Invalid employee id.' });
    }

    if (!companyId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // IMPORTANT: DB constraint expects 'active'/'inactive' (lowercase)
    const nextStatus = normalizeLower(req.body?.status || '');
    if (!['active', 'inactive'].includes(nextStatus)) {
      return res.status(400).json({ ok: false, error: "Invalid status. Use 'active' or 'inactive'." });
    }

    const { rows } = await pool.query(
      `UPDATE employees
         SET status = $1,
             updated_at = NOW()
       WHERE id = $2
         AND company_id = $3
       RETURNING
         id,
         company_id,
         employee_no,
         employee_code,
         first_name,
         last_name,
         email,
         phone,
         start_date,
         end_date,
         status,
         created_at,
         updated_at`,
      [nextStatus, employeeId, companyId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Employee not found.' });
    }

    const employee = rows[0];

    res.json({
      ok: true,
      employee: {
        ...employee,
        employee_no_display: formatEmployeeNo(employee.employee_no)
      }
    });
  } catch (err) {
    console.error('employee status update error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// API: Employees - DELETE (allowed only if no punches exist)
// =========================================================
app.delete('/api/employees/:id', requireAuth, async (req, res) => {
  const employeeId = Number(req.params.id);
  const companyId = req.auth?.user?.company_id;

  if (!Number.isFinite(employeeId)) {
    return res.status(400).json({ ok: false, error: 'Invalid employee id.' });
  }

  if (!companyId) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure employee exists in this company (lock the row for race-safety)
    const emp = await client.query(
      `SELECT id
       FROM employees
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [employeeId, companyId]
    );

    if (!emp.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Employee not found.' });
    }

    // Block deletion if at least one punch exists
    const hasPunch = await client.query(
      `SELECT 1
       FROM punches
       WHERE employee_id = $1 AND company_id = $2
       LIMIT 1`,
      [employeeId, companyId]
    );

    if (hasPunch.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        ok: false,
        error: 'Employee cannot be deleted after the first scan. Set employee to INACTIVE and create a new employee if needed.'
      });
    }

    // Safe to delete (0 punches)
    await client.query(
      `DELETE FROM employees
       WHERE id = $1 AND company_id = $2`,
      [employeeId, companyId]
    );

    await client.query('COMMIT');
    return res.status(204).send();
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('employee delete error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  } finally {
    client.release();
  }
});

// =========================================================
// API: Device bindings - LIST (Dashboard)
// =========================================================
app.get('/api/devices', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    if (!companyId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { rows } = await pool.query(
      `SELECT
         db.device_id,
         db.employee_id,
         db.created_at,
         db.last_seen_at,
         e.employee_no,
         e.employee_code,
         e.first_name,
         e.last_name
       FROM device_bindings db
       JOIN employees e
         ON e.id = db.employee_id
        AND e.company_id = db.company_id
       WHERE db.company_id = $1
       ORDER BY db.last_seen_at DESC, db.created_at DESC`,
      [companyId]
    );

    const devices = rows.map(r => ({
      ...r,
      employee_no_display: formatEmployeeNo(r.employee_no)
    }));

    res.json({ ok: true, devices });
  } catch (err) {
    console.error('devices list error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// API: Device bindings - UNLINK (Koppeling wissen)
// =========================================================
app.delete('/api/devices/:deviceId', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    if (!companyId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const deviceId = safeText(req.params.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Missing device id.' });

    const r = await pool.query(
      `DELETE FROM device_bindings
       WHERE company_id = $1
         AND device_id = $2`,
      [companyId, deviceId]
    );

    res.json({ ok: true, deleted: r.rowCount });
  } catch (err) {
    console.error('device unlink error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// API: Stats (Dashboard)
// =========================================================
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    if (!companyId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int
            FROM employees e
           WHERE e.company_id = $1) AS employees_total,
         (SELECT COUNT(*)::int
            FROM employees e
           WHERE e.company_id = $1
             AND e.status = 'active') AS employees_active,
         (SELECT COUNT(*)::int
            FROM punches p
           WHERE p.company_id = $1
             AND p.punched_at::date = CURRENT_DATE) AS checkins_today`,
      [companyId]
    );

    const r = rows[0] || {};
    return res.json({
      ok: true,
      stats: {
        employeesTotal: r.employees_total ?? 0,
        employeesActive: r.employees_active ?? 0,
        checkinsToday: r.checkins_today ?? 0
      }
    });
  } catch (err) {
    console.error('stats error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
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

// =========================================================
// Startup
// =========================================================
(async () => {
  try {
    await ensureEmployeeCounterTable();
  } catch (err) {
    console.error('Startup ensureEmployeeCounterTable error:', err);
  } finally {
    app.listen(PORT, () => {
      console.log(`MyPunctoo backend listening on port ${PORT}`);
    });
  }
})();
