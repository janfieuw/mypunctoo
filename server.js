'use strict';

const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// ✅ pas dit enkel aan als jouw db module anders staat
const { pool } = require('./db/db');

const app = express();
const PORT = process.env.PORT || 3000;
const rootDir = __dirname;
const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));

// ---------------- helpers ----------------
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

// ✅ samengestelde string (voor registered_address) op basis van bestaande DB-velden
function buildRegisteredAddress(street, box, postal, city) {
  const parts = [];
  const st = safeText(street);
  const bx = safeText(box);
  const pc = safeText(postal);
  const ct = safeText(city);

  if (st) parts.push(st);
  if (bx) parts.push(bx);

  const pcCity = [pc, ct].filter(Boolean).join(' ').trim();
  if (pcCity) parts.push(pcCity);

  return parts.length ? parts.join(', ') : null;
}

function errorResponse(res, e, fallbackMsg = 'Serverfout.') {
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

// ---------------- schema guards (dev-proof) ----------------
// Let op: we forceren hier GEEN companies-kolommen meer die jij geschrapt hebt.
// We houden enkel customer_number defaults + draft velden voor signup flow.
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Monotone teller: customer_number_seq + default + unique index
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

    // signup_drafts (wizard data). Mag breder zijn dan companies.
    await client.query(`
      ALTER TABLE IF EXISTS signup_drafts
        ADD COLUMN IF NOT EXISTS email text,
        ADD COLUMN IF NOT EXISTS password_hash text,

        ADD COLUMN IF NOT EXISTS company_name text,
        ADD COLUMN IF NOT EXISTS vat_number text,

        ADD COLUMN IF NOT EXISTS registered_contact_person text,
        ADD COLUMN IF NOT EXISTS registered_street text,
        ADD COLUMN IF NOT EXISTS registered_box text,
        ADD COLUMN IF NOT EXISTS registered_postal_code text,
        ADD COLUMN IF NOT EXISTS registered_city text,
        ADD COLUMN IF NOT EXISTS registered_address text,

        ADD COLUMN IF NOT EXISTS billing_email text,
        ADD COLUMN IF NOT EXISTS billing_reference text,

        ADD COLUMN IF NOT EXISTS delivery_is_different boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS delivery_contact_person text,
        ADD COLUMN IF NOT EXISTS delivery_street text,
        ADD COLUMN IF NOT EXISTS delivery_box text,
        ADD COLUMN IF NOT EXISTS delivery_postal_code text,
        ADD COLUMN IF NOT EXISTS delivery_city text,

        ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
        ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
    `);

    await client.query('COMMIT');
    console.log('✅ Schema gecontroleerd.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ Schema guard faalde:', e);
  } finally {
    client.release();
  }
}

ensureSchema().catch((e) => console.error(e));

// ---------------- pages ----------------
app.get('/', (req, res) => res.sendFile(path.join(rootDir, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(rootDir, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(rootDir, 'public', 'signup.html')));

// ✅ compat: als ergens nog /app gebruikt wordt, stuur naar dashboard
app.get('/app', (req, res) => res.redirect('/'));

// ---------------- auth helpers ----------------
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
      if (!user) return res.status(401).json({ ok: false, error: 'Niet aangemeld.' });
      if (role && user.role !== role) return res.status(403).json({ ok: false, error: 'Geen toegang.' });
      req.user = user;
      next();
    } catch (e) {
      return errorResponse(res, e);
    }
  };
}

// ✅ app.js verwacht /api/me om sessie te valideren
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

// ✅ app.js verwacht /api/logout
app.post('/api/logout', requireAuth(), async (req, res) => {
  try {
    await pool.query(
      `UPDATE client_portal_users
       SET auth_token = NULL, updated_at = NOW()
       WHERE id = $1`,
      [req.user.id]
    );
  } catch (e) {
    console.warn('logout update failed:', e?.message || e);
  }
  return res.json({ ok: true });
});

// ---------------- login ----------------
app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) return res.status(400).json({ ok: false, error: 'E-mail en wachtwoord zijn verplicht.' });
    if (!isEmail(email)) return res.status(400).json({ ok: false, error: 'Ongeldig e-mailadres.' });

    const { rows } = await pool.query(
      `SELECT id, email, password_hash, role, is_active, company_id
       FROM client_portal_users
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [email]
    );

    if (!rows.length) return res.status(401).json({ ok: false, error: 'Onjuiste login.' });
    const user = rows[0];
    if (!user.is_active) return res.status(401).json({ ok: false, error: 'Account is inactief.' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Onjuiste login.' });

    const token = genToken(24);
    await pool.query(
      `UPDATE client_portal_users
       SET auth_token = $1, updated_at = NOW()
       WHERE id = $2`,
      [token, user.id]
    );

    return res.json({ ok: true, token, redirectUrl: '/' });
  } catch (e) {
    return errorResponse(res, e);
  }
});

// ---------------- signup ----------------
app.post('/api/signup/step1', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) return res.status(400).json({ ok: false, error: 'E-mail en wachtwoord zijn verplicht.' });
    if (!isEmail(email)) return res.status(400).json({ ok: false, error: 'Ongeldig e-mailadres.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Wachtwoord moet minstens 8 tekens bevatten.' });

    const exists = await pool.query(
      `SELECT 1 FROM client_portal_users WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );
    if (exists.rows.length) return res.status(400).json({ ok: false, error: 'Er bestaat al een account met dit e-mailadres.' });

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
    if (!signup_token) return res.status(400).json({ ok: false, error: 'Interne fout: signup token ontbreekt.' });

    const payload = req.body || {};

    const company_name = safeText(payload.company_name);

    // ✅ Ondernemingsnummer: 0###.###.### (geen spaties)
    const ondernemingsnr_raw = safeText(payload.vat_number);
    if (!ondernemingsnr_raw) return res.status(400).json({ ok: false, error: 'Ondernemingsnummer is verplicht.' });

    const pattern = /^0\d{3}\.\d{3}\.\d{3}$/;
    if (!pattern.test(ondernemingsnr_raw)) {
      return res.status(400).json({ ok: false, error: 'Ondernemingsnummer: verplicht formaat 0123.456.789' });
    }

    const vat_number = ondernemingsnr_raw;

    const registered_contact_person = safeText(payload.registered_contact_person);
    const registered_street = safeText(payload.registered_street);
    const registered_box = safeText(payload.registered_box);
    const registered_postal_code = safeText(payload.registered_postal_code);
    const registered_city = safeText(payload.registered_city);

    const billing_email = safeText(payload.billing_email);
    const billing_reference = safeText(payload.billing_reference);

    const deliveryDifferent = !!payload.delivery_is_different;

    const delivery_contact_person = deliveryDifferent ? safeText(payload.delivery_contact_person) : null;
    const delivery_street = deliveryDifferent ? safeText(payload.delivery_street) : null;
    const delivery_box = deliveryDifferent ? safeText(payload.delivery_box) : null;
    const delivery_postal_code = deliveryDifferent ? safeText(payload.delivery_postal_code) : null;
    const delivery_city = deliveryDifferent ? safeText(payload.delivery_city) : null;

    if (!company_name) return res.status(400).json({ ok: false, error: 'Bedrijfsnaam is verplicht.' });
    if (!registered_contact_person) return res.status(400).json({ ok: false, error: 'Contactpersoon is verplicht.' });
    if (!registered_street) return res.status(400).json({ ok: false, error: 'Straat + nummer is verplicht.' });
    if (!registered_postal_code) return res.status(400).json({ ok: false, error: 'Postcode is verplicht.' });
    if (!registered_city) return res.status(400).json({ ok: false, error: 'Gemeente is verplicht.' });
    if (!billing_email || !isEmail(billing_email)) return res.status(400).json({ ok: false, error: 'Geldig facturatie e-mailadres is verplicht.' });

    if (deliveryDifferent) {
      if (!delivery_contact_person) return res.status(400).json({ ok: false, error: 'Levering contactpersoon is verplicht.' });
      if (!delivery_street) return res.status(400).json({ ok: false, error: 'Levering straat + nummer is verplicht.' });
      if (!delivery_postal_code) return res.status(400).json({ ok: false, error: 'Levering postcode is verplicht.' });
      if (!delivery_city) return res.status(400).json({ ok: false, error: 'Levering gemeente is verplicht.' });
    }

    // ✅ Dit bestaat als kolom in companies: registered_address
    const registered_address = buildRegisteredAddress(
      registered_street,
      registered_box,
      registered_postal_code,
      registered_city
    );

    await pool.query(
      `UPDATE signup_drafts SET
         company_name = $2,
         vat_number = $3,

         registered_contact_person = $4,
         registered_street = $5,
         registered_box = $6,
         registered_postal_code = $7,
         registered_city = $8,
         registered_address = $9,

         billing_email = $10,
         billing_reference = $11,

         delivery_is_different = $12,
         delivery_contact_person = $13,
         delivery_street = $14,
         delivery_box = $15,
         delivery_postal_code = $16,
         delivery_city = $17,

         updated_at = NOW()
       WHERE signup_token = $1`,
      [
        signup_token,
        company_name,
        vat_number,

        registered_contact_person,
        registered_street,
        registered_box,
        registered_postal_code,
        registered_city,
        registered_address,

        billing_email,
        billing_reference,

        deliveryDifferent,
        delivery_contact_person,
        delivery_street,
        delivery_box,
        delivery_postal_code,
        delivery_city
      ]
    );

    return res.json({ ok: true });
  } catch (e) {
    return errorResponse(res, e, 'Kon bedrijfsgegevens niet opslaan.');
  }
});

app.post('/api/signup/step3', async (req, res) => {
  const client = await pool.connect();
  try {
    const signup_token = String(req.body.signup_token || '').trim();
    if (!signup_token) return res.status(400).json({ ok: false, error: 'Interne fout: signup token ontbreekt.' });

    const { rows } = await client.query(
      `SELECT * FROM signup_drafts WHERE signup_token = $1 LIMIT 1`,
      [signup_token]
    );
    if (!rows.length) return res.status(400).json({ ok: false, error: 'Ongeldige signup sessie. Herlaad de pagina.' });

    const draft = rows[0];

    if (!draft.company_name || !draft.vat_number || !draft.registered_contact_person || !draft.billing_email) {
      return res.status(400).json({ ok: false, error: 'Onvolledige gegevens. Vul stap 2 volledig in.' });
    }

    const companyName = draft.company_name;
    const ondernemingsNr = draft.vat_number;

    const regContact = draft.registered_contact_person;
    const regStreet = draft.registered_street;
    const regBox = draft.registered_box;
    const regPostal = draft.registered_postal_code;
    const regCity = draft.registered_city;

    const registeredAddress = draft.registered_address || buildRegisteredAddress(regStreet, regBox, regPostal, regCity);

    const deliveryDifferent = !!draft.delivery_is_different;

    const delContact = deliveryDifferent ? draft.delivery_contact_person : null;
    const delStreet = deliveryDifferent ? draft.delivery_street : null;
    const delBox = deliveryDifferent ? draft.delivery_box : null;
    const delPostal = deliveryDifferent ? draft.delivery_postal_code : null;
    const delCity = deliveryDifferent ? draft.delivery_city : null;

    const billingEmail = draft.billing_email;
    const billingReference = draft.billing_reference;

    await client.query('BEGIN');

    // ✅ INSERT enkel bestaande kolommen in companies (ZONDER website)
    const companyIns = await client.query(
      `INSERT INTO companies (
         name,
         vat_number,
         registered_address,
         billing_email,
         billing_reference,
         registered_contact_person,
         delivery_contact_person,
         registered_street,
         registered_box,
         registered_postal_code,
         registered_city,
         delivery_street,
         delivery_box,
         delivery_postal_code,
         delivery_city
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,
         $8,$9,$10,$11,$12,$13,$14,$15
       )
       RETURNING id, created_at, customer_number`,
      [
        companyName,
        ondernemingsNr || null,
        registeredAddress || null,
        billingEmail || null,
        billingReference || null,
        regContact || null,
        delContact || null,
        regStreet || null,
        regBox || null,
        regPostal || null,
        regCity || null,
        delStreet || null,
        delBox || null,
        delPostal || null,
        delCity || null
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
    return errorResponse(res, e, 'Kon account niet aanmaken.');
  } finally {
    client.release();
  }
});

// ---------------- dashboard stats (basic) ----------------
// (laat dit staan zoals je had; app.js verwacht /api/stats)
app.get('/api/stats', requireAuth(), async (req, res) => {
  return res.json({
    ok: true,
    stats: {
      employeesTotal: 0,
      employeesActive: 0,
      checkinsToday: 0
    }
  });
});

// ---------------- client record API ----------------
app.get('/api/company', requireAuth(), async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const { rows } = await pool.query(`SELECT * FROM companies WHERE id = $1 LIMIT 1`, [companyId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Bedrijf niet gevonden.' });

    return res.json({ ok: true, company: rows[0] });
  } catch (e) {
    return errorResponse(res, e);
  }
});

app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
