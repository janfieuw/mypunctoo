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
  // Allow punch page to be served as a static html file (QR opens this)
  if (req.path === '/punch.html') return next();
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

// Punch page (opened via QR on the plate)
app.get('/punch', (_, res) => res.sendFile(path.join(rootDir, 'public', 'punch.html')));

// =========================================================
// Public API: Punch
// =========================================================

async function ensurePunchTables() {
  // Minimal tables to support punches from the QR flow.
  // If your DB already has these tables/columns, these statements are no-ops.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS punches (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      punched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      device_id TEXT,
      qr_reference TEXT,
      meta JSONB
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_punches_company_employee_time ON punches(company_id, employee_id, punched_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_punches_punched_at ON punches(punched_at DESC)`);

  // QR mapping table (plate -> company)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qr_registry (
      qr_reference TEXT PRIMARY KEY,
      company_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function resolveCompanyIdByQr(qrRef) {
  const qr = safeText(qrRef);
  if (!qr) return null;

  // Strategy: try a few likely places (because schema differs per deployment).
  // We swallow "missing table/column" errors and move on.
  const attempts = [
    // 1) Explicit mapping table (recommended)
    { text: 'SELECT company_id AS id FROM qr_registry WHERE qr_reference = $1 LIMIT 1', values: [qr] },

    // 2) Match against existing company identifiers (your DB has company_code, name, vat_number)
    { text: 'SELECT id FROM companies WHERE company_code = $1 LIMIT 1', values: [qr] },
    { text: 'SELECT id FROM companies WHERE vat_number = $1 LIMIT 1', values: [qr] },

    // 3) Optional plate table (if you add it later)
    { text: 'SELECT company_id AS id FROM plates WHERE qr_reference = $1 OR plate_code = $1 LIMIT 1', values: [qr] },
  ];

  for (const a of attempts) {
    try {
      const r = await pool.query(a.text, a.values);
      if (r.rows && r.rows.length) {
        const id = r.rows[0].id;
        if (Number.isFinite(Number(id))) return Number(id);
      }
    } catch (e) {
      // 42P01 = undefined_table, 42703 = undefined_column
      if (e && (e.code === '42P01' || e.code === '42703')) continue;
      console.warn('resolveCompanyIdByQr query failed:', a.text, e.message);
      continue;
    }
  }
  return null;
}

async function resolveEmployeeId(companyId, employeeToken) {
  const tok = safeText(employeeToken);
  if (!tok) return null;

  // Try numeric ID first
  const asInt = Number(tok);
  if (Number.isFinite(asInt) && String(asInt) === tok) {
    try {
      const r = await pool.query(
        'SELECT id FROM employees WHERE id = $1 AND company_id = $2 LIMIT 1',
        [asInt, companyId]
      );
      if (r.rows.length) return r.rows[0].id;
    } catch (e) {
      if (!(e && (e.code === '42P01' || e.code === '42703'))) {
        console.warn('resolveEmployeeId numeric failed:', e.message);
      }
    }
  }

  // Then employee_code
  try {
    const r = await pool.query(
      'SELECT id FROM employees WHERE company_id = $1 AND employee_code = $2 LIMIT 1',
      [companyId, tok]
    );
    if (r.rows.length) return r.rows[0].id;
  } catch (e) {
    if (!(e && (e.code === '42P01' || e.code === '42703'))) {
      console.warn('resolveEmployeeId code failed:', e.message);
    }
  }

  // Finally: employee_no
  try {
    const r = await pool.query(
      'SELECT id FROM employees WHERE company_id = $1 AND employee_no = $2 LIMIT 1',
      [companyId, tok]
    );
    if (r.rows.length) return r.rows[0].id;
  } catch (e) {
    if (!(e && (e.code === '42P01' || e.code === '42703'))) {
      console.warn('resolveEmployeeId no failed:', e.message);
    }
  }

  return null;
}

app.post('/api/punch', async (req, res) => {
  try {
    await ensurePunchTables();

    const qr = safeText(req.body?.qr);
    const direction = (safeText(req.body?.direction) || 'in').toLowerCase() === 'out' ? 'out' : 'in';
    const employeeToken = safeText(req.body?.employeeToken || req.body?.employeeId || req.body?.employee_code);
    const deviceId = safeText(req.body?.deviceId);
    const patternOk = req.body?.patternOk === true; // client side check

    if (!qr) return res.status(400).json({ ok: false, error: 'Missing qr' });
    if (!employeeToken) return res.status(400).json({ ok: false, error: 'Missing employee' });
    if (!patternOk) return res.status(400).json({ ok: false, error: 'Plate verification failed' });

    const companyId = await resolveCompanyIdByQr(qr);
    if (!companyId) {
      // UX-truc server-side: toon Plate ID + contact
      return res.status(404).json({
        ok: false,
        error: `Unknown Plate ID: ${qr}. Please contact support@punctoo.be.`
      });
    }

    const employeeId = await resolveEmployeeId(companyId, employeeToken);
    if (!employeeId) {
      return res.status(404).json({ ok: false, error: 'Unknown employee for this company' });
    }

    const meta = {
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null
    };

    const ins = await pool.query(
      `INSERT INTO punches (company_id, employee_id, direction, device_id, qr_reference, meta)
       VALUES ($1, $2, $3, NULLIF($4,''), $5, $6)
       RETURNING id, punched_at`,
      [companyId, employeeId, direction, deviceId, qr, meta]
    );

    return res.json({
      ok: true,
      punchId: ins.rows[0].id,
      punchedAt: ins.rows[0].punched_at,
      direction
    });
  } catch (err) {
    console.error('POST /api/punch error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// Sessions (still in-memory; OK for now)
// =========================================================
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
// Employee identifiers (AUTO)
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
  await pool.query(
    `CREATE TABLE IF NOT EXISTS company_employee_counters (
      company_id INTEGER PRIMARY KEY,
      last_employee_no INTEGER NOT NULL DEFAULT 0
    )`
  );
}

async function allocateNextEmployeeNo(client, companyId) {
  await client.query(
    `INSERT INTO company_employee_counters (company_id, last_employee_no)
     VALUES ($1, 0)
     ON CONFLICT (company_id) DO NOTHING`,
    [companyId]
  );

  const counterRes = await client.query(
    `SELECT last_employee_no
       FROM company_employee_counters
      WHERE company_id = $1
      FOR UPDATE`,
    [companyId]
  );

  const last = counterRes.rows[0]?.last_employee_no ?? 0;
  const next = last + 1;
  if (next > 9999) throw new Error('Employee limit reached for company');

  await client.query(
    `UPDATE company_employee_counters
        SET last_employee_no = $2
      WHERE company_id = $1`,
    [companyId, next]
  );

  return next;
}

// =========================================================
// Expected Schedule table (minutes)
// =========================================================
async function ensureExpectedScheduleTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_expected_schedule (
      id BIGSERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
      expected_minutes INTEGER NOT NULL DEFAULT 0,
      break_minutes INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, day_of_week)
    )
  `);
}

async function upsertExpectedSchedule(client, employeeId, scheduleRows) {
  if (!Array.isArray(scheduleRows)) return;

  for (const row of scheduleRows) {
    const day = intSafe(row?.day_of_week, 0);
    const expected = intSafe(row?.expected_minutes, 0);
    const brk = intSafe(row?.break_minutes, 0);

    if (day < 1 || day > 7) continue;

    await client.query(
      `INSERT INTO employee_expected_schedule (employee_id, day_of_week, expected_minutes, break_minutes, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (employee_id, day_of_week)
       DO UPDATE SET expected_minutes = EXCLUDED.expected_minutes,
                     break_minutes = EXCLUDED.break_minutes,
                     updated_at = NOW()`,
      [employeeId, day, expected, brk]
    );
  }
}

// =========================================================
// Signup drafts (DB persisted)  ✅ fixes "Invalid signup token."
// =========================================================
async function ensureSignupDraftsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signup_drafts (
      signup_token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      draft_company JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_signup_drafts_expires ON signup_drafts(expires_at)`);
}

async function cleanupExpiredSignupDrafts() {
  // Best-effort cleanup; ignore errors
  try {
    await ensureSignupDraftsTable();
    await pool.query(`DELETE FROM signup_drafts WHERE expires_at < NOW()`);
  } catch {
    // ignore
  }
}

function hoursFromNow(h) {
  const d = new Date();
  d.setHours(d.getHours() + h);
  return d;
}

async function getDraftByToken(signupToken) {
  await ensureSignupDraftsTable();
  const { rows } = await pool.query(
    `SELECT signup_token, email, password_hash, draft_company
       FROM signup_drafts
      WHERE signup_token = $1
        AND expires_at >= NOW()
      LIMIT 1`,
    [signupToken]
  );
  return rows[0] || null;
}

// =========================================================
// Signup step 1: start signup draft (DB persisted)
// =========================================================
app.post('/api/signup/step1', async (req, res) => {
  try {
    await cleanupExpiredSignupDrafts();

    const email = normalizeLower(req.body.email);
    const password = String(req.body.password || '');

    if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'Invalid email.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });

    // Check existing user
    const existing = await pool.query(
      'SELECT id FROM client_portal_users WHERE email = $1 LIMIT 1',
      [email]
    );
    if (existing.rows.length) {
      return res.status(400).json({ ok: false, error: 'Email already registered.' });
    }

    await ensureSignupDraftsTable();

    const signupToken = uuidv4();
    const passHash = await bcrypt.hash(password, 10);
    const expiresAt = hoursFromNow(2); // 2 hours to finish signup

    await pool.query(
      `INSERT INTO signup_drafts (signup_token, email, password_hash, draft_company, expires_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
      [signupToken, email, passHash, expiresAt.toISOString()]
    );

    return res.json({ ok: true, signupToken });
  } catch (err) {
    console.error('signup step1 error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// Signup step 2: company details (DB persisted)
// =========================================================
app.post('/api/signup/step2', async (req, res) => {
  try {
    const signupToken = safeText(req.body.signupToken);
    const draft = await getDraftByToken(signupToken);
    if (!draft) {
      return res.status(400).json({ ok: false, error: 'Invalid signup token.' });
    }

    // Note: keep the payload fields as your frontend already sends them
    const companyName = safeText(req.body.company_name);
    const vatNumber = normalizeUpper(req.body.vat_number);
    const countryCode = normalizeUpper(req.body.country_code);
    const website = safeText(req.body.website);
    const employeesCount = intSafe(req.body.employees_count, 0);

    const contactFirst = safeText(req.body.contact_first_name);
    const contactLast = safeText(req.body.contact_last_name);
    const contactEmail = normalizeLower(req.body.contact_email);
    const contactPhone = safeText(req.body.contact_phone);

    if (!companyName) return res.status(400).json({ ok: false, error: 'Company name is required.' });
    if (!countryCode || !EU_COUNTRIES.has(countryCode)) return res.status(400).json({ ok: false, error: 'Invalid country code.' });
    if (!isValidWebsite(website)) return res.status(400).json({ ok: false, error: 'Invalid website.' });
    if (contactEmail && !isValidEmail(contactEmail)) return res.status(400).json({ ok: false, error: 'Invalid contact email.' });

    const merged = {
      ...(draft.draft_company || {}),
      company_name: companyName,
      vat_number: vatNumber,
      country_code: countryCode,
      website,
      employees_count: employeesCount,
      contact_first_name: contactFirst,
      contact_last_name: contactLast,
      contact_email: contactEmail,
      contact_phone: contactPhone
    };

    await pool.query(
      `UPDATE signup_drafts
          SET draft_company = $2::jsonb
        WHERE signup_token = $1`,
      [signupToken, JSON.stringify(merged)]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('signup step2 error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// Signup step 3: addresses + create records (DB persisted)
//   - Uses your actual companies schema: name, company_code, vat_number, registered_*, billing_*
// =========================================================
app.post('/api/signup/step3', async (req, res) => {
  const client = await pool.connect();
  try {
    const signupToken = safeText(req.body.signupToken);
    const draft = await getDraftByToken(signupToken);
    if (!draft) {
      return res.status(400).json({ ok: false, error: 'Invalid signup token.' });
    }

    const dc = draft.draft_company || {};

    // Registered fields (frontend names)
    const regContactPerson = safeText(req.body.registered_contact_person || req.body.contact_person);
    const regStreet = safeText(req.body.registered_street);
    const regBox = safeText(req.body.registered_box);
    const regPostal = safeText(req.body.registered_postal_code);
    const regCity = safeText(req.body.registered_city);
    const regCountry = normalizeUpper(req.body.registered_country_code) || normalizeUpper(dc.country_code);

    // "Delivery" fields from frontend; DB uses billing_* (as in your screenshot).
    const sameAsRegistered = req.body.same_as_registered === true;

    const delContactPerson = safeText(req.body.delivery_contact_person || req.body.billing_contact_person);
    const delStreet = safeText(req.body.delivery_street || req.body.billing_street);
    const delBox = safeText(req.body.delivery_box || req.body.billing_box);
    const delPostal = safeText(req.body.delivery_postal_code || req.body.billing_postal_code);
    const delCity = safeText(req.body.delivery_city || req.body.billing_city);
    const delCountry = normalizeUpper(req.body.delivery_country_code || req.body.billing_country_code) || regCountry;

    // Always a delivery/billing address: if missing, fallback to registered.
    const billingStreet = safeText(delStreet) || (sameAsRegistered ? regStreet : '') || regStreet;
    const billingBox = safeText(delBox) || (sameAsRegistered ? regBox : '') || regBox;
    const billingPostal = safeText(delPostal) || (sameAsRegistered ? regPostal : '') || regPostal;
    const billingCity = safeText(delCity) || (sameAsRegistered ? regCity : '') || regCity;
    const billingCountry = safeText(delCountry) || regCountry;

    const registeredAddress = buildAddressLineFromFields(regStreet, regBox, regPostal, regCity, regCountry);
    const billingAddress = buildAddressLineFromFields(billingStreet, billingBox, billingPostal, billingCity, billingCountry);

    const companyName = safeText(dc.company_name);
    const vatNumber = safeText(dc.vat_number);
    const website = safeText(dc.website);
    const estimatedUserCount = intSafe(dc.employees_count, 0);

    const billingEmail = safeText(dc.contact_email); // best mapping for now
    const billingReference = safeText(req.body.billing_reference); // optional
    const deliveryContact = safeText(delContactPerson) || safeText(`${dc.contact_first_name || ''} ${dc.contact_last_name || ''}`.trim()) || regContactPerson;
    const registeredContact = safeText(regContactPerson) || safeText(`${dc.contact_first_name || ''} ${dc.contact_last_name || ''}`.trim());

    if (!companyName) {
      return res.status(400).json({ ok: false, error: 'Company name missing (step2).' });
    }
    if (!regCountry) {
      return res.status(400).json({ ok: false, error: 'Registered country missing.' });
    }

    await client.query('BEGIN');

    const companyCode = makeCompanyCode(companyName);

    // Create company: match your current schema (from your screenshot)
    const companyIns = await client.query(
      `INSERT INTO companies (
         company_code,
         name,
         vat_number,
         registered_address,
         billing_address,
         billing_email,
         billing_reference,
         estimated_user_count,
         created_at,
         updated_at,
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
         billing_country_code
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW(),
         $9,$10,$11,
         $12,$13,$14,$15,$16,
         $17,$18,$19,$20,$21
       )
       RETURNING id`,
      [
        companyCode,
        companyName,
        vatNumber || null,
        registeredAddress || null,
        billingAddress || null,
        billingEmail || null,
        billingReference || null,
        estimatedUserCount || 0,
        registeredContact || null,
        deliveryContact || null,
        website || null,
        regStreet || null,
        regBox || null,
        regPostal || null,
        regCity || null,
        regCountry || null,
        billingStreet || null,
        billingBox || null,
        billingPostal || null,
        billingCity || null,
        billingCountry || null
      ]
    );

    const companyId = companyIns.rows[0].id;

    // Create admin portal user
    const userId = uuidv4();
    await client.query(
      `INSERT INTO client_portal_users (id, email, password_hash, role, is_active, company_id, created_at, updated_at)
       VALUES ($1,$2,$3,'admin',true,$4,NOW(),NOW())`,
      [userId, draft.email, draft.password_hash, companyId]
    );

    // Remove draft (completed)
    await client.query(`DELETE FROM signup_drafts WHERE signup_token = $1`, [signupToken]);

    await client.query('COMMIT');

    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('signup step3 error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  } finally {
    client.release();
  }
});

// =========================================================
// Login
// =========================================================
app.post('/api/login', async (req, res) => {
  try {
    const email = normalizeLower(req.body.email);
    const password = String(req.body.password || '');

    if (!isValidEmail(email) || !password) {
      return res.status(400).json({ ok: false, error: 'Invalid credentials.' });
    }

    const { rows } = await pool.query(
      'SELECT id, email, password_hash, role, is_active FROM client_portal_users WHERE email = $1 LIMIT 1',
      [email]
    );

    if (!rows.length || rows[0].is_active !== true) {
      return res.status(400).json({ ok: false, error: 'Invalid credentials.' });
    }

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ ok: false, error: 'Invalid credentials.' });

    const sessionToken = crypto.randomBytes(24).toString('hex');
    sessionsByToken.set(sessionToken, { userId: user.id });

    return res.json({
      ok: true,
      token: sessionToken
    });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  return res.json({ ok: true, user: req.auth.user });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = req.auth.token;
  sessionsByToken.delete(token);
  return res.json({ ok: true });
});

// =========================================================
// API: Company
//   - Adjusted SELECT to your schema: name, company_code, vat_number, registered_address, billing_address, ...
// =========================================================
app.get('/api/company', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    if (!companyId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

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
         created_at,
         updated_at
       FROM companies
       WHERE id = $1
       LIMIT 1`,
      [companyId]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: 'Company not found.' });
    return res.json({ ok: true, company: rows[0] });
  } catch (err) {
    console.error('company error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// API: Employees
// =========================================================
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    if (!companyId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

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
      ORDER BY e.employee_no ASC, e.created_at ASC`,
      [companyId]
    );

    return res.json({
      ok: true,
      employees: rows.map(r => ({
        ...r,
        employee_no_display: formatEmployeeNo(r.employee_no)
      }))
    });
  } catch (err) {
    console.error('employees list error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.post('/api/employees', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = req.auth.user.company_id;
    if (!companyId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const firstName = safeText(req.body.first_name);
    const lastName = safeText(req.body.last_name);
    const email = normalizeLower(req.body.email);
    const phone = safeText(req.body.phone);
    const startDate = safeText(req.body.start_date);
    const endDate = safeText(req.body.end_date);
    const status = safeText(req.body.status) || 'active';

    if (!firstName || !lastName || !startDate) {
      return res.status(400).json({ ok: false, error: 'Please fill in FIRST NAME, LAST NAME and START DATE.' });
    }
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email.' });
    }

    await ensureEmployeeCounterTable();
    await ensureExpectedScheduleTable();

    await client.query('BEGIN');

    const employeeNo = await allocateNextEmployeeNo(client, companyId);
    let employeeCode = genEmployeeCode(10);

    // Ensure uniqueness
    for (let i = 0; i < 5; i++) {
      const chk = await client.query(
        `SELECT 1 FROM employees WHERE company_id = $1 AND employee_code = $2 LIMIT 1`,
        [companyId, employeeCode]
      );
      if (!chk.rows.length) break;
      employeeCode = genEmployeeCode(10);
    }

    const ins = await client.query(
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
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),$10,NOW(),NOW())
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
      [
        companyId,
        employeeNo,
        employeeCode,
        firstName,
        lastName,
        email || null,
        phone || null,
        startDate,
        endDate || null,
        status
      ]
    );

    const employee = ins.rows[0];

    // Optional schedule rows (minutes)
    if (Array.isArray(req.body.expected_schedule)) {
      await upsertExpectedSchedule(client, employee.id, req.body.expected_schedule);
    }

    await client.query('COMMIT');

    return res.json({
      ok: true,
      employee: {
        ...employee,
        employee_no_display: formatEmployeeNo(employee.employee_no)
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('employee create error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  } finally {
    client.release();
  }
});

app.get('/api/employees/:id/expected-schedule', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    const employeeId = intSafe(req.params.id, 0);
    if (!companyId || !employeeId) return res.status(400).json({ ok: false, error: 'Invalid request.' });

    await ensureExpectedScheduleTable();

    // Make sure employee belongs to company
    const emp = await pool.query(
      `SELECT id FROM employees WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [employeeId, companyId]
    );
    if (!emp.rows.length) return res.status(404).json({ ok: false, error: 'Employee not found.' });

    const { rows } = await pool.query(
      `SELECT day_of_week, expected_minutes, break_minutes
         FROM employee_expected_schedule
        WHERE employee_id = $1
        ORDER BY day_of_week ASC`,
      [employeeId]
    );

    // Always return 7 rows (1..7)
    const byDay = new Map(rows.map(r => [r.day_of_week, r]));
    const out = [];
    for (let d = 1; d <= 7; d++) {
      const r = byDay.get(d) || { day_of_week: d, expected_minutes: 0, break_minutes: 0 };
      out.push(r);
    }

    return res.json({ ok: true, schedule: out });
  } catch (err) {
    console.error('expected schedule get error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.put('/api/employees/:id/expected-schedule', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = req.auth.user.company_id;
    const employeeId = intSafe(req.params.id, 0);
    if (!companyId || !employeeId) return res.status(400).json({ ok: false, error: 'Invalid request.' });

    await ensureExpectedScheduleTable();

    // Verify employee belongs to company
    const emp = await pool.query(
      `SELECT id FROM employees WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [employeeId, companyId]
    );
    if (!emp.rows.length) return res.status(404).json({ ok: false, error: 'Employee not found.' });

    const scheduleRows = Array.isArray(req.body.schedule) ? req.body.schedule : [];
    await client.query('BEGIN');
    await upsertExpectedSchedule(client, employeeId, scheduleRows);
    await client.query('COMMIT');

    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('expected schedule put error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  } finally {
    client.release();
  }
});

app.patch('/api/employees/:id/status', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    const employeeId = intSafe(req.params.id, 0);
    const nextStatus = safeText(req.body.status);

    if (!companyId || !employeeId) {
      return res.status(400).json({ ok: false, error: 'Invalid request.' });
    }

    if (!['active', 'inactive'].includes(nextStatus)) {
      return res.status(400).json({ ok: false, error: 'Invalid status.' });
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
  const client = await pool.connect();
  try {
    const companyId = req.auth.user.company_id;
    const employeeId = intSafe(req.params.id, 0);
    if (!companyId || !employeeId) return res.status(400).json({ ok: false, error: 'Invalid request.' });

    // Block delete if punches exist
    const hasPunches = await client.query(
      `SELECT 1
         FROM punches p
        WHERE p.company_id = $1
          AND p.employee_id = $2
        LIMIT 1`,
      [companyId, employeeId]
    );
    if (hasPunches.rows.length) {
      return res.status(400).json({ ok: false, error: 'Cannot delete employee: punches exist.' });
    }

    await client.query('BEGIN');
    await client.query('DELETE FROM employee_expected_schedule WHERE employee_id = $1', [employeeId]);
    const del = await client.query(
      `DELETE FROM employees
        WHERE id = $1
          AND company_id = $2
        RETURNING id`,
      [employeeId, companyId]
    );
    await client.query('COMMIT');

    if (!del.rows.length) return res.status(404).json({ ok: false, error: 'Employee not found.' });
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('employee delete error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  } finally {
    client.release();
  }
});

// =========================================================
// API: Devices (bindings)
// =========================================================
app.get('/api/devices', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    if (!companyId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { rows } = await pool.query(
      `SELECT
         device_id,
         employee_id,
         created_at
       FROM device_bindings
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [companyId]
    );

    return res.json({ ok: true, devices: rows });
  } catch (err) {
    console.error('devices list error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.delete('/api/devices/:deviceId', requireAuth, async (req, res) => {
  try {
    const companyId = req.auth.user.company_id;
    const deviceId = safeText(req.params.deviceId);
    if (!companyId || !deviceId) return res.status(400).json({ ok: false, error: 'Invalid request.' });

    await pool.query(
      `DELETE FROM device_bindings
        WHERE company_id = $1
          AND device_id = $2`,
      [companyId, deviceId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('device unlink error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// API: Stats
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
// Health
// =========================================================
app.get('/api/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ ok: true });
  } catch (err) {
    console.error('health error:', err);
    return res.status(500).json({ ok: false, error: 'DB error.' });
  }
});

// =========================================================
// Start server
// =========================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
