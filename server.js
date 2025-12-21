const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('./db/db');

leading = true;
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
  if (req.path === '/index.html') return next();
  if (req.path === '/login.html') return next();
  if (req.path === '/signup.html') return next();
  if (req.path === '/punch.html') return next();

  // default fallback: allow
  return next();
});

app.use(express.static(path.join(rootDir, 'public')));

// =========================================================
// Helpers
// =========================================================
function safeText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

function genToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function normalizeVatNumber(country, vatNumberRaw) {
  const cc = String(country || '').trim().toUpperCase();
  const raw = String(vatNumberRaw || '').trim().toUpperCase();

  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return null;

  if (cc === 'BE') {
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    return `BE${last10}`;
  }

  return raw;
}

function buildAddressLineFromFields(street, box, postal, city, countryCode) {
  const parts = [];

  const st = safeText(street);
  const bx = safeText(box);
  const pc = safeText(postal);
  const ct = safeText(city);
  const cc = safeText(countryCode);

  if (st) parts.push(st);
  if (bx) parts.push(bx);

  const pcCity = [pc, ct].filter(Boolean).join(' ').trim();
  if (pcCity) parts.push(pcCity);

  if (cc) parts.push(cc);

  return parts.length ? parts.join(', ') : null;
}

function makeCompanyCode(companyName) {
  const base = String(companyName || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 10);

  const suffix = String(Math.floor(1000 + Math.random() * 9000));
  return `${base || 'COMP'}-${suffix}`;
}

async function getAuthUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;

  const token = auth.slice('Bearer '.length).trim();
  if (!token) return null;

  const { rows } = await pool.query(
    `SELECT id, email, role, is_active, company_id
     FROM client_portal_users
     WHERE auth_token = $1
     LIMIT 1`,
    [token]
  );

  if (!rows.length) return null;
  if (!rows[0].is_active) return null;

  return rows[0];
}

function requireAuth(role = null) {
  return async (req, res, next) => {
    try {
      const user = await getAuthUser(req);
      if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      if (role && user.role !== role) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }

      req.user = user;
      next();
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Server error.' });
    }
  };
}

// =========================================================
// Pages
// =========================================================
app.get('/', (req, res) => res.sendFile(path.join(rootDir, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(rootDir, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(rootDir, 'public', 'signup.html')));
app.get('/punch', (req, res) => res.sendFile(path.join(rootDir, 'public', 'punch.html')));
app.get('/app', (req, res) => res.sendFile(path.join(rootDir, 'public', 'index.html')));

// =========================================================
// Auth endpoints
// =========================================================
app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) return res.status(400).json({ ok: false, error: 'Missing credentials.' });
    if (!isEmail(email)) return res.status(400).json({ ok: false, error: 'Invalid email.' });

    const { rows } = await pool.query(
      `SELECT id, email, password_hash, role, is_active, company_id
       FROM client_portal_users
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [email]
    );

    if (!rows.length) return res.status(401).json({ ok: false, error: 'Invalid credentials.' });

    const user = rows[0];
    if (!user.is_active) return res.status(401).json({ ok: false, error: 'Account inactive.' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid credentials.' });

    const token = genToken(24);

    await pool.query(
      `UPDATE client_portal_users
       SET auth_token = $1, updated_at = NOW()
       WHERE id = $2`,
      [token, user.id]
    );

    return res.json({ ok: true, token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.post('/api/logout', requireAuth(), async (req, res) => {
  try {
    await pool.query(`UPDATE client_portal_users SET auth_token = NULL, updated_at = NOW() WHERE id = $1`, [
      req.user.id
    ]);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.get('/api/me', requireAuth(), async (req, res) => {
  return res.json({
    ok: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      company_id: req.user.company_id
    }
  });
});

// =========================================================
// Signup flow (3 steps)
// =========================================================

app.post('/api/signup/step1', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password are required.' });
    if (!isEmail(email)) return res.status(400).json({ ok: false, error: 'Invalid email.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });

    // block if already exists
    const exists = await pool.query(
      `SELECT 1 FROM client_portal_users WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );
    if (exists.rows.length) return res.status(400).json({ ok: false, error: 'Account already exists.' });

    const password_hash = await bcrypt.hash(password, 10);
    const signup_token = uuidv4();

    await pool.query(
      `INSERT INTO signup_drafts (signup_token, email, password_hash, created_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW())`,
      [signup_token, email, password_hash]
    );

    return res.json({ ok: true, signup_token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.post('/api/signup/step2', async (req, res) => {
  try {
    const signup_token = String(req.body.signup_token || '').trim();
    if (!signup_token) return res.status(400).json({ ok: false, error: 'Missing signup token.' });

    const { rows } = await pool.query(`SELECT signup_token FROM signup_drafts WHERE signup_token = $1 LIMIT 1`, [
      signup_token
    ]);
    if (!rows.length) return res.status(400).json({ ok: false, error: 'Invalid signup token.' });

    const payload = req.body || {};

    const company_name = safeText(payload.company_name);
    const country_code = safeText(payload.country_code) || 'BE';
    const vat_number = normalizeVatNumber(country_code, payload.vat_number);

    const website = safeText(payload.website);

    const registered_contact_person = safeText(payload.registered_contact_person);
    const registered_street = safeText(payload.registered_street);
    const registered_box = safeText(payload.registered_box);
    const registered_postal_code = safeText(payload.registered_postal_code);
    const registered_city = safeText(payload.registered_city);
    const registered_country_code = safeText(payload.registered_country_code) || country_code;

    const billing_email = safeText(payload.billing_email);
    const billing_reference = safeText(payload.billing_reference);

    const deliveryDifferent = !!payload.delivery_is_different;

    const delivery_contact_person = deliveryDifferent ? safeText(payload.delivery_contact_person) : null;
    const delivery_street = deliveryDifferent ? safeText(payload.delivery_street) : null;
    const delivery_box = deliveryDifferent ? safeText(payload.delivery_box) : null;
    const delivery_postal_code = deliveryDifferent ? safeText(payload.delivery_postal_code) : null;
    const delivery_city = deliveryDifferent ? safeText(payload.delivery_city) : null;
    const delivery_country_code = deliveryDifferent ? safeText(payload.delivery_country_code) : null;

    if (!company_name) return res.status(400).json({ ok: false, error: 'Company name is required.' });
    if (!vat_number) return res.status(400).json({ ok: false, error: 'Enterprise/EU business number is required.' });
    if (!registered_contact_person) return res.status(400).json({ ok: false, error: 'Registered contact person is required.' });
    if (!registered_street) return res.status(400).json({ ok: false, error: 'Registered street + number is required.' });
    if (!registered_postal_code) return res.status(400).json({ ok: false, error: 'Registered postal code is required.' });
    if (!registered_city) return res.status(400).json({ ok: false, error: 'Registered city is required.' });
    if (!billing_email || !isEmail(billing_email)) return res.status(400).json({ ok: false, error: 'Valid billing email is required.' });

    const registered_address = buildAddressLineFromFields(
      registered_street,
      registered_box,
      registered_postal_code,
      registered_city,
      registered_country_code
    );

    const billing_address = buildAddressLineFromFields(
      deliveryDifferent ? (delivery_street || registered_street) : registered_street,
      deliveryDifferent ? (delivery_box || registered_box) : registered_box,
      deliveryDifferent ? (delivery_postal_code || registered_postal_code) : registered_postal_code,
      deliveryDifferent ? (delivery_city || registered_city) : registered_city,
      deliveryDifferent ? (delivery_country_code || registered_country_code) : registered_country_code
    );

    await pool.query(
      `UPDATE signup_drafts
       SET
         company_name = $2,
         country_code = $3,
         vat_number = $4,
         website = $5,

         registered_contact_person = $6,
         registered_street = $7,
         registered_box = $8,
         registered_postal_code = $9,
         registered_city = $10,
         registered_country_code = $11,
         registered_address = $12,

         billing_email = $13,
         billing_reference = $14,
         billing_address = $15,

         delivery_is_different = $16,
         delivery_contact_person = $17,
         delivery_street = $18,
         delivery_box = $19,
         delivery_postal_code = $20,
         delivery_city = $21,
         delivery_country_code = $22,

         updated_at = NOW()
       WHERE signup_token = $1`,
      [
        signup_token,
        company_name,
        country_code,
        vat_number,
        website,

        registered_contact_person,
        registered_street,
        registered_box,
        registered_postal_code,
        registered_city,
        registered_country_code,
        registered_address,

        billing_email,
        billing_reference,
        billing_address,

        deliveryDifferent,
        delivery_contact_person,
        delivery_street,
        delivery_box,
        delivery_postal_code,
        delivery_city,
        delivery_country_code
      ]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.post('/api/signup/step3', async (req, res) => {
  const client = await pool.connect();
  try {
    const signup_token = String(req.body.signup_token || '').trim();
    if (!signup_token) return res.status(400).json({ ok: false, error: 'Missing signup token.' });

    const { rows } = await client.query(`SELECT * FROM signup_drafts WHERE signup_token = $1 LIMIT 1`, [signup_token]);
    if (!rows.length) return res.status(400).json({ ok: false, error: 'Invalid signup token.' });

    const draft = rows[0];

    // Validate that step2 completed
    if (!draft.company_name || !draft.vat_number || !draft.registered_contact_person || !draft.billing_email) {
      return res.status(400).json({ ok: false, error: 'Signup draft incomplete. Please complete step 2.' });
    }

    const companyName = draft.company_name;
    const vatNumber = draft.vat_number;
    const website = draft.website;

    const regContact = draft.registered_contact_person;

    const regStreet = draft.registered_street;
    const regBox = draft.registered_box;
    const regPostal = draft.registered_postal_code;
    const regCity = draft.registered_city;
    const regCountry = draft.registered_country_code;

    const delContact = draft.delivery_contact_person;
    const delStreet = draft.delivery_street;
    const delBox = draft.delivery_box;
    const delPostal = draft.delivery_postal_code;
    const delCity = draft.delivery_city;
    const delCountry = draft.delivery_country_code;

    const deliveryDifferent = !!draft.delivery_is_different;

    const billingEmail = draft.billing_email;
    const billingReference = draft.billing_reference;

    // Billing address = delivery address if different, else registered
    const billingStreet = deliveryDifferent ? (delStreet || regStreet) : regStreet;
    const billingBox = deliveryDifferent ? (delBox || regBox) : regBox;
    const billingPostal = deliveryDifferent ? (delPostal || regPostal) : regPostal;
    const billingCity = deliveryDifferent ? (delCity || regCity) : regCity;
    const billingCountry = deliveryDifferent ? (delCountry || regCountry) : regCountry;

    const registeredAddress = buildAddressLineFromFields(regStreet, regBox, regPostal, regCity, regCountry);
    const billingAddress = buildAddressLineFromFields(billingStreet, billingBox, billingPostal, billingCity, billingCountry);

    await client.query('BEGIN');

    const companyCode = makeCompanyCode(companyName);
    const customerNumber = companyCode; // ✅ FIX: auto-generate customer number

    const companyIns = await client.query(
      `INSERT INTO companies (
         company_code,
         customer_number,
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
         $1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW(),
         $10,$11,$12,
         $13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22
       )
       RETURNING id`,
      [
        companyCode,
        customerNumber,
        companyName,
        vatNumber || null,
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

    // ✅ FIX: do NOT insert UUID into an integer id column.
    // Let Postgres create the integer id automatically.
    await client.query(
      `INSERT INTO client_portal_users (email, password_hash, role, is_active, company_id, created_at, updated_at)
       VALUES ($1,$2,'admin',true,$3,NOW(),NOW())`,
      [draft.email, draft.password_hash, companyId]
    );

    await client.query(`DELETE FROM signup_drafts WHERE signup_token = $1`, [signup_token]);

    await client.query('COMMIT');

    return res.json({ ok: true });
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  } finally {
    client.release();
  }
});

// =========================================================
// Company API
// =========================================================
app.get('/api/company', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;

    const { rows } = await pool.query(`SELECT * FROM companies WHERE id = $1 LIMIT 1`, [companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Company not found.' });

    const c = rows[0];

    const buildAddress = (street, box, pc, city, cc) =>
      [safeText(street), safeText(box), [safeText(pc), safeText(city)].filter(Boolean).join(' ').trim(), safeText(cc)]
        .filter(Boolean)
        .join(', ');

    const registeredAddress =
      safeText(c.registered_address) ||
      buildAddress(c.registered_street, c.registered_box, c.registered_postal_code, c.registered_city, c.registered_country_code) ||
      null;

    const rawDeliveryAddress =
      buildAddress(c.delivery_street, c.delivery_box, c.delivery_postal_code, c.delivery_city, c.delivery_country_code) ||
      null;

    // ✅ FIX: fallback to registered address if delivery is empty
    const deliveryAddress = rawDeliveryAddress || registeredAddress || null;

    // UI hard-coded mapping (client-record page)
    const company = {
  ...c,

  // UI-mapping (hard-coded keys)
  company_name: c.name,
  main_contact: c.registered_contact_person || null,
  invoices_sent_to: c.billing_email || null,
  delivery_contact: c.delivery_contact_person || null,

  registered_address: registeredAddress,
  delivery_address: deliveryAddress,

  customer_number: c.customer_number || null,
  billing_reference: c.billing_reference || null,

  // ✅ CONTRACT
  contract_start_date: c.created_at
};


    return res.json({ ok: true, company });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// Stats
// =========================================================
app.get('/api/stats', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;

    const employeesTotalQ = await pool.query(`SELECT COUNT(*)::int AS n FROM employees WHERE company_id = $1`, [companyId]);
    const employeesActiveQ = await pool.query(
      `SELECT COUNT(*)::int AS n FROM employees WHERE company_id = $1 AND lower(status) = 'active'`,
      [companyId]
    );

    const todayQ = await pool.query(
      `SELECT COUNT(*)::int AS n
       FROM raw_data
       WHERE company_id = $1 AND created_at::date = NOW()::date`,
      [companyId]
    );

    return res.json({
      ok: true,
      stats: {
        employeesTotal: employeesTotalQ.rows[0]?.n ?? 0,
        employeesActive: employeesActiveQ.rows[0]?.n ?? 0,
        checkinsToday: todayQ.rows[0]?.n ?? 0
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// Employees CRUD
// =========================================================
app.get('/api/employees', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;

    const { rows } = await pool.query(
      `SELECT
         e.*,
         EXISTS (SELECT 1 FROM raw_data rd WHERE rd.employee_id = e.id LIMIT 1) AS has_punches,
         EXISTS (SELECT 1 FROM employee_expected_schedule s WHERE s.employee_id = e.id AND (s.expected_minutes > 0 OR s.break_minutes > 0) LIMIT 1) AS has_working_schedule
       FROM employees e
       WHERE e.company_id = $1
       ORDER BY e.created_at DESC`,
      [companyId]
    );

    return res.json({ ok: true, employees: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.post('/api/employees', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;

    const first_name = safeText(req.body.first_name);
    const last_name = safeText(req.body.last_name);

    if (!first_name || !last_name) {
      return res.status(400).json({ ok: false, error: 'Please fill in FIRST NAME and LAST NAME.' });
    }

    // auto-generate employee_code
    const code = `${String(first_name).slice(0, 1)}${String(last_name).slice(0, 1)}-${Math.floor(1000 + Math.random() * 9000)}`.toUpperCase();

    const { rows } = await pool.query(
      `INSERT INTO employees (company_id, employee_code, first_name, last_name, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',NOW(),NOW())
       RETURNING *`,
      [companyId, code, first_name.toUpperCase(), last_name.toUpperCase()]
    );

    return res.json({ ok: true, employee: rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.patch('/api/employees/:id/status', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const id = Number(req.params.id);
    const status = safeText(req.body.status);

    if (!id) return res.status(400).json({ ok: false, error: 'Invalid employee id.' });
    if (!status || !['active', 'inactive'].includes(status.toLowerCase())) {
      return res.status(400).json({ ok: false, error: 'Invalid status.' });
    }

    const { rows } = await pool.query(
      `UPDATE employees
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [status.toLowerCase(), id, companyId]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: 'Employee not found.' });

    return res.json({ ok: true, employee: rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.delete('/api/employees/:id', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const id = Number(req.params.id);

    if (!id) return res.status(400).json({ ok: false, error: 'Invalid employee id.' });

    const hasPunches = await pool.query(`SELECT 1 FROM raw_data WHERE employee_id = $1 LIMIT 1`, [id]);
    if (hasPunches.rows.length) {
      return res.status(400).json({ ok: false, error: 'Cannot delete: raw data present for this employee.' });
    }

    const r = await pool.query(`DELETE FROM employees WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'Employee not found.' });

    return res.status(204).send();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// Expected schedule
// =========================================================
app.get('/api/employees/:id/expected-schedule', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const employeeId = Number(req.params.id);
    if (!employeeId) return res.status(400).json({ ok: false, error: 'Invalid employee id.' });

    const okEmp = await pool.query(`SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 LIMIT 1`, [employeeId, companyId]);
    if (!okEmp.rows.length) return res.status(404).json({ ok: false, error: 'Employee not found.' });

    const { rows } = await pool.query(
      `SELECT weekday, expected_minutes, break_minutes
       FROM employee_expected_schedule
       WHERE employee_id = $1
       ORDER BY weekday ASC`,
      [employeeId]
    );

    return res.json({ ok: true, schedule: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.put('/api/employees/:id/expected-schedule', requireAuth(), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    const employeeId = Number(req.params.id);
    if (!employeeId) return res.status(400).json({ ok: false, error: 'Invalid employee id.' });

    const okEmp = await client.query(`SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 LIMIT 1`, [employeeId, companyId]);
    if (!okEmp.rows.length) return res.status(404).json({ ok: false, error: 'Employee not found.' });

    const schedule = Array.isArray(req.body.schedule) ? req.body.schedule : [];
    await client.query('BEGIN');

    await client.query(`DELETE FROM employee_expected_schedule WHERE employee_id = $1`, [employeeId]);

    for (const row of schedule) {
      const weekday = Number(row.weekday);
      const expected_minutes = Number(row.expected_minutes || 0);
      const break_minutes = Number(row.break_minutes || 0);

      if (!Number.isFinite(weekday)) continue;
      if (weekday < 0 || weekday > 6) continue;

      if (!Number.isFinite(expected_minutes) || expected_minutes < 0) continue;
      if (!Number.isFinite(break_minutes) || break_minutes < 0) continue;

      await client.query(
        `INSERT INTO employee_expected_schedule (employee_id, weekday, expected_minutes, break_minutes)
         VALUES ($1,$2,$3,$4)`,
        [employeeId, weekday, expected_minutes, break_minutes]
      );
    }

    await client.query('COMMIT');

    const { rows } = await client.query(
      `SELECT weekday, expected_minutes, break_minutes
       FROM employee_expected_schedule
       WHERE employee_id = $1
       ORDER BY weekday ASC`,
      [employeeId]
    );

    return res.json({ ok: true, schedule: rows });
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  } finally {
    client.release();
  }
});

// =========================================================
// Devices (linked devices)
// =========================================================
app.get('/api/devices', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;

    const { rows } = await pool.query(
      `SELECT
         d.device_id,
         d.employee_id,
         d.last_seen_at,
         e.employee_code,
         e.first_name,
         e.last_name
       FROM device_links d
       JOIN employees e ON e.id = d.employee_id
       WHERE d.company_id = $1
       ORDER BY d.last_seen_at DESC NULLS LAST`,
      [companyId]
    );

    return res.json({ ok: true, devices: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.delete('/api/devices/:deviceId', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const deviceId = String(req.params.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ ok: false, error: 'Invalid device id.' });

    const r = await pool.query(`DELETE FROM device_links WHERE company_id = $1 AND device_id = $2`, [companyId, deviceId]);
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'Device link not found.' });

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// =========================================================
// Start server
// =========================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
