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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS qr_registry (
      qr_reference TEXT PRIMARY KEY,
      company_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

const EU_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
  'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'
]);

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

async function resolveCompanyIdByQr(qrRef) {
  const qr = safeText(qrRef);
  if (!qr) return null;

  const attempts = [
    { text: 'SELECT company_id AS id FROM qr_registry WHERE qr_reference = $1 LIMIT 1', values: [qr] },
    { text: 'SELECT id FROM companies WHERE company_code = $1 LIMIT 1', values: [qr] },
    { text: 'SELECT id FROM companies WHERE vat_number = $1 LIMIT 1', values: [qr] },
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
    const patternOk = req.body?.patternOk === true;

    if (!qr) return res.status(400).json({ ok: false, error: 'Missing qr' });
    if (!employeeToken) return res.status(400).json({ ok: false, error: 'Missing employee' });
    if (!patternOk) return res.status(400).json({ ok: false, error: 'Plate verification failed' });

    const companyId = await resolveCompanyIdByQr(qr);
    if (!companyId) {
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

// =========================================================
// Signup drafts (DB persisted)
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

function getSignupTokenFromBody(req) {
  // ✅ accept both naming styles
  return safeText(req.body?.signup_token || req.body?.signupToken || req.body?.token);
}

// =========================================================
// Signup step 1
// =========================================================
app.post('/api/signup/step1', async (req, res) => {
  try {
    await cleanupExpiredSignupDrafts();

    const email = normalizeLower(req.body.email);
    const password = String(req.body.password || '');
    const passwordConfirm = String(req.body.password_confirm || '');

    if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'Invalid email.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
    if (password !== passwordConfirm) return res.status(400).json({ ok: false, error: 'Passwords do not match.' });

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
    const expiresAt = hoursFromNow(2);

    await pool.query(
      `INSERT INTO signup_drafts (signup_token, email, password_hash, draft_company, expires_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
      [signupToken, email, passHash, expiresAt.toISOString()]
    );

    // ✅ return both keys, so frontend never breaks again
    return res.json({ ok: true, signupToken, signup_token: signupToken });
  } catch (err) {
    console.error('signup step1 error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// Signup step 2: store EXACT fields your signup.html sends
// =========================================================
app.post('/api/signup/step2', async (req, res) => {
  try {
    const signupToken = getSignupTokenFromBody(req);
    const draft = await getDraftByToken(signupToken);
    if (!draft) {
      return res.status(400).json({ ok: false, error: 'Invalid signup token.' });
    }

    // Validate minimal requirements (match frontend fields)
    const companyName = safeText(req.body.company_name);
    const enterpriseNumber = normalizeUpper(req.body.enterprise_number);
    const regCountry = normalizeUpper(req.body.registered_country_code);
    const website = safeText(req.body.website);

    const regContactPerson = safeText(req.body.registered_contact_person);
    const regStreet = safeText(req.body.registered_street);
    const regPostal = safeText(req.body.registered_postal_code);
    const regCity = safeText(req.body.registered_city);

    const billingEmail = normalizeLower(req.body.billing_email);

    if (!companyName) return res.status(400).json({ ok: false, error: 'Company name is required.' });
    if (!enterpriseNumber) return res.status(400).json({ ok: false, error: 'Enterprise number is required.' });
    if (!regCountry || !EU_COUNTRIES.has(regCountry)) return res.status(400).json({ ok: false, error: 'Invalid country code.' });
    if (!regContactPerson) return res.status(400).json({ ok: false, error: 'Registered contact person is required.' });
    if (!regStreet) return res.status(400).json({ ok: false, error: 'Registered street is required.' });
    if (!regPostal) return res.status(400).json({ ok: false, error: 'Registered postal code is required.' });
    if (!regCity) return res.status(400).json({ ok: false, error: 'Registered city is required.' });
    if (!billingEmail || !isValidEmail(billingEmail)) return res.status(400).json({ ok: false, error: 'Valid billing email is required.' });
    if (!isValidWebsite(website)) return res.status(400).json({ ok: false, error: 'Invalid website.' });

    // Store exactly what frontend sends (minus password/email duplicates)
    const allowed = {
      company_name: companyName,
      enterprise_number: enterpriseNumber,
      website,

      registered_contact_person: regContactPerson,
      registered_street: safeText(req.body.registered_street),
      registered_box: safeText(req.body.registered_box),
      registered_postal_code: regPostal,
      registered_city: regCity,
      registered_country_code: regCountry,

      billing_email: billingEmail,
      billing_reference: safeText(req.body.billing_reference),

      delivery_is_different: req.body.delivery_is_different === true,
      delivery_contact_person: safeText(req.body.delivery_contact_person),
      delivery_street: safeText(req.body.delivery_street),
      delivery_box: safeText(req.body.delivery_box),
      delivery_postal_code: safeText(req.body.delivery_postal_code),
      delivery_city: safeText(req.body.delivery_city),
      delivery_country_code: normalizeUpper(req.body.delivery_country_code),
    };

    const merged = {
      ...(draft.draft_company || {}),
      ...allowed
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
// Signup step 3: create company + admin user
// =========================================================
app.post('/api/signup/step3', async (req, res) => {
  const client = await pool.connect();
  try {
    const signupToken = getSignupTokenFromBody(req);
    const draft = await getDraftByToken(signupToken);
    if (!draft) {
      return res.status(400).json({ ok: false, error: 'Invalid signup token.' });
    }

    const qty = intSafe(req.body.extra_plates, 0);
    const salesTerms = req.body.sales_terms === true;
    if (!salesTerms) return res.status(400).json({ ok: false, error: 'Sales terms must be accepted.' });
    if (qty < 0 || qty > 99) return res.status(400).json({ ok: false, error: 'Invalid extra plates quantity.' });

    const dc = draft.draft_company || {};

    // From step2 draft
    const companyName = safeText(dc.company_name);
    const enterpriseNumber = safeText(dc.enterprise_number); // map to vat_number in companies table
    const website = safeText(dc.website);

    const regContact = safeText(dc.registered_contact_person);
    const regStreet = safeText(dc.registered_street);
    const regBox = safeText(dc.registered_box);
    const regPostal = safeText(dc.registered_postal_code);
    const regCity = safeText(dc.registered_city);
    const regCountry = normalizeUpper(dc.registered_country_code);

    const billingEmail = safeText(dc.billing_email);
    const billingReference = safeText(dc.billing_reference);

    const deliveryDifferent = dc.delivery_is_different === true;
    const delContact = safeText(dc.delivery_contact_person);
    const delStreet = safeText(dc.delivery_street);
    const delBox = safeText(dc.delivery_box);
    const delPostal = safeText(dc.delivery_postal_code);
    const delCity = safeText(dc.delivery_city);
    const delCountry = normalizeUpper(dc.delivery_country_code) || regCountry;

    if (!companyName) return res.status(400).json({ ok: false, error: 'Company name missing (step2).' });
    if (!enterpriseNumber) return res.status(400).json({ ok: false, error: 'Enterprise number missing (step2).' });
    if (!regCountry) return res.status(400).json({ ok: false, error: 'Registered country missing (step2).' });

    // If delivery not different, fallback to registered
    const billingStreet = deliveryDifferent ? (delStreet || regStreet) : regStreet;
    const billingBox = deliveryDifferent ? (delBox || regBox) : regBox;
    const billingPostal = deliveryDifferent ? (delPostal || regPostal) : regPostal;
    const billingCity = deliveryDifferent ? (delCity || regCity) : regCity;
    const billingCountry = deliveryDifferent ? (delCountry || regCountry) : regCountry;

    const registeredAddress = buildAddressLineFromFields(regStreet, regBox, regPostal, regCity, regCountry);
    const billingAddress = buildAddressLineFromFields(billingStreet, billingBox, billingPostal, billingCity, billingCountry);

    await client.query('BEGIN');

    const companyCode = makeCompanyCode(companyName);

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
        enterpriseNumber || null,
        registeredAddress || null,
        billingAddress || null,
        billingEmail || null,
        billingReference || null,
        0,
        regContact || null,
        (deliveryDifferent ? delContact : '') || null,
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

    const userId = uuidv4();
    await client.query(
      `INSERT INTO client_portal_users (id, email, password_hash, role, is_active, company_id, created_at, updated_at)
       VALUES ($1,$2,$3,'admin',true,$4,NOW(),NOW())`,
      [userId, draft.email, draft.password_hash, companyId]
    );

    await client.query(`DELETE FROM signup_drafts WHERE signup_token = $1`, [signupToken]);

    await client.query('COMMIT');

    return res.json({ ok: true, redirectUrl: '/login' });
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
// The rest of your server.js continues unchanged in your project.
// (Employees, devices, stats, health, etc.)
// =========================================================

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
