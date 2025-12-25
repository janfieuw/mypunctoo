'use strict';

const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Pas dit pad enkel aan als jouw db module elders zit
const { pool } = require('./db/db');

const app = express();
const PORT = process.env.PORT || 3000;
const rootDir = __dirname;
const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));

// ---------- helpers ----------
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

function errorResponse(res, e, fallbackMsg = 'Server error.') {
  console.error(e);
  if (!IS_PROD) {
    return res.status(500).json({
      ok: false,
      error: fallbackMsg,
      detail: String(e?.message || e),
      code: e?.code || null
    });
  }
  return res.status(500).json({ ok: false, error: fallbackMsg });
}

// ---------- startup schema guards ----------
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Monotone teller (sequence + default + unique index)
    await client.query(`CREATE SEQUENCE IF NOT EXISTS customer_number_seq START 1;`);
    await client.query(`
      ALTER TABLE IF EXISTS companies
      ALTER COLUMN created_at SET DEFAULT now();
    `);
    await client.query(`
      ALTER TABLE IF EXISTS companies
      ALTER COLUMN customer_number SET DEFAULT nextval('customer_number_seq');
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS companies_customer_number_ux
      ON companies(customer_number);
    `);

    // signup_drafts columns used by step2/step3
    await client.query(`
      ALTER TABLE IF EXISTS signup_drafts
        ADD COLUMN IF NOT EXISTS email text,
        ADD COLUMN IF NOT EXISTS password_hash text,
        ADD COLUMN IF NOT EXISTS company_name text,
        ADD COLUMN IF NOT EXISTS country_code text,
        ADD COLUMN IF NOT EXISTS vat_number text,
        ADD COLUMN IF NOT EXISTS website text,

        ADD COLUMN IF NOT EXISTS registered_contact_person text,
        ADD COLUMN IF NOT EXISTS registered_street text,
        ADD COLUMN IF NOT EXISTS registered_box text,
        ADD COLUMN IF NOT EXISTS registered_postal_code text,
        ADD COLUMN IF NOT EXISTS registered_city text,
        ADD COLUMN IF NOT EXISTS registered_country_code text,
        ADD COLUMN IF NOT EXISTS registered_address text,

        ADD COLUMN IF NOT EXISTS billing_email text,
        ADD COLUMN IF NOT EXISTS billing_reference text,
        ADD COLUMN IF NOT EXISTS billing_address text,

        ADD COLUMN IF NOT EXISTS delivery_is_different boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS delivery_contact_person text,
        ADD COLUMN IF NOT EXISTS delivery_street text,
        ADD COLUMN IF NOT EXISTS delivery_box text,
        ADD COLUMN IF NOT EXISTS delivery_postal_code text,
        ADD COLUMN IF NOT EXISTS delivery_city text,
        ADD COLUMN IF NOT EXISTS delivery_country_code text,

        ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
        ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
    `);

    await client.query('COMMIT');
    console.log('✅ Schema ensured.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ Schema ensure failed:', e);
  } finally {
    client.release();
  }
}

ensureSchema().catch((e) => console.error(e));

// ---------- pages ----------
app.get('/', (req, res) => res.sendFile(path.join(rootDir, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(rootDir, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(rootDir, 'public', 'signup.html')));

// ---------- auth ----------
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
      if (role && user.role !== role) return res.status(403).json({ ok: false, error: 'Forbidden' });
      req.user = user;
      next();
    } catch (e) {
      return errorResponse(res, e);
    }
  };
}

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
    return errorResponse(res, e);
  }
});

// ---------- signup ----------
app.post('/api/signup/step1', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password are required.' });
    if (!isEmail(email)) return res.status(400).json({ ok: false, error: 'Invalid email.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });

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
    return errorResponse(res, e);
  }
});

app.post('/api/signup/step2', async (req, res) => {
  try {
    const signup_token = String(req.body.signup_token || '').trim();
    if (!signup_token) return res.status(400).json({ ok: false, error: 'Missing signup token.' });

    const chk = await pool.query(
      `SELECT signup_token FROM signup_drafts WHERE signup_token = $1 LIMIT 1`,
      [signup_token]
    );
    if (!chk.rows.length) return res.status(400).json({ ok: false, error: 'Invalid signup token.' });

    const payload = req.body || {};

    const company_name = safeText(payload.company_name);

    // ✅ Belgium-only strict VAT
    const country_code = 'BE';
    const vat_number_raw = safeText(payload.vat_number);
    if (!vat_number_raw) return res.status(400).json({ ok: false, error: 'Enterprise number is required.' });

    const beVatPattern = /^BE\s0\d{3}\.\s\d{3}\.\s\d{3}$/;
    if (!beVatPattern.test(vat_number_raw)) {
      return res.status(400).json({ ok: false, error: 'VAT format required: BE 0123. 456. 789' });
    }
    const vat_number = vat_number_raw;

    const website = safeText(payload.website);

    const registered_contact_person = safeText(payload.registered_contact_person);
    const registered_street = safeText(payload.registered_street);
    const registered_box = safeText(payload.registered_box);
    const registered_postal_code = safeText(payload.registered_postal_code);
    const registered_city = safeText(payload.registered_city);
    const registered_country_code = 'BE';

    const billing_email = safeText(payload.billing_email);
    const billing_reference = safeText(payload.billing_reference);

    const deliveryDifferent = !!payload.delivery_is_different;

    const delivery_contact_person = deliveryDifferent ? safeText(payload.delivery_contact_person) : null;
    const delivery_street = deliveryDifferent ? safeText(payload.delivery_street) : null;
    const delivery_box = deliveryDifferent ? safeText(payload.delivery_box) : null;
    const delivery_postal_code = deliveryDifferent ? safeText(payload.delivery_postal_code) : null;
    const delivery_city = deliveryDifferent ? safeText(payload.delivery_city) : null;
    const delivery_country_code = deliveryDifferent ? 'BE' : null;

    if (!company_name) return res.status(400).json({ ok: false, error: 'Company name is required.' });
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
      'BE'
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
    return errorResponse(res, e, 'Could not save company details.');
  }
});

app.post('/api/signup/step3', async (req, res) => {
  const client = await pool.connect();
  try {
    const signup_token = String(req.body.signup_token || '').trim();
    if (!signup_token) return res.status(400).json({ ok: false, error: 'Missing signup token.' });

    const { rows } = await client.query(
      `SELECT * FROM signup_drafts WHERE signup_token = $1 LIMIT 1`,
      [signup_token]
    );
    if (!rows.length) return res.status(400).json({ ok: false, error: 'Invalid signup token.' });

    const draft = rows[0];

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
    const regCountry = draft.registered_country_code || 'BE';

    const delContact = draft.delivery_contact_person;
    const deliveryDifferent = !!draft.delivery_is_different;

    const billingEmail = draft.billing_email;
    const billingReference = draft.billing_reference;

    // billing uses delivery if different (same logic as step2)
    const billingStreet = deliveryDifferent ? (draft.delivery_street || regStreet) : regStreet;
    const billingBox = deliveryDifferent ? (draft.delivery_box || regBox) : regBox;
    const billingPostal = deliveryDifferent ? (draft.delivery_postal_code || regPostal) : regPostal;
    const billingCity = deliveryDifferent ? (draft.delivery_city || regCity) : regCity;
    const billingCountry = 'BE';

    const registeredAddress = buildAddressLineFromFields(regStreet, regBox, regPostal, regCity, regCountry);
    const billingAddress = buildAddressLineFromFields(billingStreet, billingBox, billingPostal, billingCity, billingCountry);

    await client.query('BEGIN');

    // ✅ DB is source of truth:
    // - companies.created_at (DEFAULT now())
    // - companies.customer_number (DEFAULT nextval(...))
    // - no companies.updated_at
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
         $1,$2,$3,$4,$5,$6,$7,$8,
         $9,$10,$11,
         $12,$13,$14,$15,$16,
         $17,$18,$19,$20,$21
       )
       RETURNING id, created_at, customer_number`,
      [
        companyCode,
        companyName,
        vatNumber || null,
        registeredAddress || null,
        billingAddress || null,
        billingEmail || null,
        billingReference || null,
        0,
        regContact || null,
        (deliveryDifferent ? delContact : null) || null,
        website || null,

        regStreet || null,
        regBox || null,
        regPostal || null,
        regCity || null,
        regCountry || 'BE',

        billingStreet || null,
        billingBox || null,
        billingPostal || null,
        billingCity || null,
        billingCountry || 'BE'
      ]
    );

    const companyId = companyIns.rows[0].id;

    await client.query(
      `INSERT INTO client_portal_users (email, password_hash, role, is_active, company_id, created_at, updated_at)
       VALUES ($1,$2,'admin',true,$3,NOW(),NOW())`,
      [draft.email, draft.password_hash, companyId]
    );

    await client.query(`DELETE FROM signup_drafts WHERE signup_token = $1`, [signup_token]);

    await client.query('COMMIT');

    return res.json({ ok: true, redirectUrl: '/login' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    return errorResponse(res, e, 'Could not create account.');
  } finally {
    client.release();
  }
});

// client-record uses this (created_at + customer_number)
app.get('/api/company', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const { rows } = await pool.query(`SELECT * FROM companies WHERE id = $1 LIMIT 1`, [companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Company not found.' });

    const c = rows[0];
    return res.json({
      ok: true,
      company: {
        ...c,
        company_name: c.name,
        created_at: c.created_at,
        customer_number: c.customer_number ?? null
      }
    });
  } catch (e) {
    return errorResponse(res, e);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
