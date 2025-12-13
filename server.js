const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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
// In-memory storage (DEMO)
// =========================================================
const usersByEmail = new Map();
const signupTokens = new Map();
const companiesById = new Map();
const sessionsByToken = new Map();
const employeesByCompanyId = new Map();

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

function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token || !sessionsByToken.has(token)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { email } = sessionsByToken.get(token);
  const user = usersByEmail.get(email);
  if (!user || user.status !== 'active') {
    sessionsByToken.delete(token);
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  req.auth = { token, user };
  next();
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

// =========================================================
// API: Signup step 1 (HR contact)
// =========================================================
app.post('/api/signup/step1', (req, res) => {
  const {
    first_name,
    last_name,
    email,
    password,
    password_confirm,
    terms
  } = req.body || {};

  if (!first_name || !last_name || !email || !password || !password_confirm) {
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

  if (!terms) {
    return res.status(400).json({ ok: false, error: 'Terms must be accepted.' });
  }

  const key = String(email).trim().toLowerCase();
  if (usersByEmail.has(key)) {
    return res.status(400).json({ ok: false, error: 'E-mail already registered.' });
  }

  usersByEmail.set(key, {
    id: uuidv4(),
    firstName: toTitleCase(first_name),
    lastName: toTitleCase(last_name),
    email: key,
    passwordPlain: password, // demo only
    status: 'pending_step2',
    companyId: null
  });

  const signupToken = uuidv4();
  signupTokens.set(signupToken, { email: key });

  res.json({ ok: true, signupToken });
});

// =========================================================
// API: Signup step 2 (Company + addresses + optional website)
// =========================================================
app.post('/api/signup/step2', (req, res) => {
  const {
    signup_token,
    email,
    password,

    company_name,
    enterprise_number,
    website,

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

  const { email: tokenEmail } = signupTokens.get(signup_token);
  const user = usersByEmail.get(tokenEmail);

  const emailKey = String(email || '').trim().toLowerCase();
  if (!user || user.email !== emailKey || user.passwordPlain !== password) {
    return res.status(400).json({ ok: false, error: 'Invalid signup data.' });
  }

  if (
    !company_name ||
    !enterprise_number ||
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
    if (!delivery_street || !delivery_postal_code || !delivery_city || !delivery_country_code) {
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

  const companyId = uuidv4();

  const websiteClean = safeText(website);
  const websiteNormalized = websiteClean
    ? (websiteClean.startsWith('http') ? websiteClean : `https://${websiteClean}`)
    : '';

  companiesById.set(companyId, {
    id: companyId,
    name: toTitleCase(company_name),
    enterpriseNumber: normalizeUpper(enterprise_number),
    website: websiteNormalized || null,

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
    } : null,

    subscription: {
      status: 'active',
      plan: 'Monthly – unlimited users – €19.99 / month (excl. VAT)'
    },

    contact: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: 'HR contact'
    }
  });

  employeesByCompanyId.set(companyId, []);

  user.status = 'active';
  user.companyId = companyId;
  signupTokens.delete(signup_token);

  res.json({ ok: true, redirectUrl: '/login' });
});

// =========================================================
// API: Login
// =========================================================
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = usersByEmail.get((email || '').trim().toLowerCase());

  if (!user || user.passwordPlain !== password || user.status !== 'active') {
    return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
  }

  const token = uuidv4();
  sessionsByToken.set(token, { email: user.email });

  res.json({ ok: true, token, redirectUrl: '/app' });
});

// =========================================================
// API: Current user
// =========================================================
app.get('/api/me', (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token || !sessionsByToken.has(token)) {
    return res.status(401).json({ ok: false });
  }

  const { email } = sessionsByToken.get(token);
  const user = usersByEmail.get(email);

  res.json({
    ok: true,
    user: {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      companyId: user.companyId
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
// API: Company
// =========================================================
app.get('/api/company', requireAuth, (req, res) => {
  const company = companiesById.get(req.auth.user.companyId);
  if (!company) return res.status(404).json({ ok: false });
  res.json({ ok: true, company });
});

// =========================================================
// Health
// =========================================================
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`MyPunctoo backend listening on port ${PORT}`);
});
