// server.js
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

/* =========================================================
   HTML requests afvangen VOOR express.static

   - Publieke .html → redirect naar clean routes
   - /views/*.html → TOEGELATEN (interne app views)
========================================================= */
app.use((req, res, next) => {
  if (!req.path.endsWith('.html')) return next();

  // ✅ interne SPA views mogen
  if (req.path.startsWith('/views/')) return next();

  // ✅ legacy publieke pages netjes redirecten
  if (req.path === '/login.html') return res.redirect(301, '/login');
  if (req.path === '/signup.html') return res.redirect(301, '/signup');
  if (req.path === '/index.html') return res.redirect(301, '/app');

  // ❌ alles anders met .html blokkeren
  return res.status(404).send('Not found');
});

// =========================================================
// Statische files
// =========================================================
app.use(express.static(path.join(rootDir, 'public')));

// =========================================================
// Mooie publieke routes (geen .html zichtbaar)
// =========================================================
app.get('/', (req, res) => {
  res.redirect('/login');
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(rootDir, 'public', 'signup.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(rootDir, 'public', 'login.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(rootDir, 'public', 'index.html'));
});

// =========================================================
// In-memory storage (demo)
// =========================================================
const usersByEmail = new Map();
const signupTokens = new Map();
const companiesById = new Map();
const sessionsByToken = new Map();

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// =========================================================
// API: Signup step 1
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
    return res.status(400).json({ ok: false, error: 'Please provide a valid e-mail address.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters long.' });
  }

  if (password !== password_confirm) {
    return res.status(400).json({ ok: false, error: 'Passwords do not match.' });
  }

  if (!terms) {
    return res.status(400).json({ ok: false, error: 'You must accept the Terms & Conditions.' });
  }

  const key = email.toLowerCase();
  if (usersByEmail.has(key)) {
    return res.status(400).json({ ok: false, error: 'This e-mail address is already registered.' });
  }

  const user = {
    id: uuidv4(),
    firstName: first_name,
    lastName: last_name,
    email: key,
    passwordPlain: password, // DEMO
    status: 'pending_step2',
    companyId: null
  };

  usersByEmail.set(key, user);

  const token = uuidv4();
  signupTokens.set(token, { email: key });

  console.log('STEP1 OK:', key, 'token:', token);

  res.json({
    ok: true,
    signupToken: token
  });
});

// =========================================================
// API: Signup step 2
// =========================================================
app.post('/api/signup/step2', (req, res) => {
  const {
    signup_token,
    email,
    password,
    company_name,
    vat_number,
    employee_count,
    street,
    postal_code,
    city,
    country,
    billing_reference
  } = req.body || {};

  if (!signup_token || !signupTokens.has(signup_token)) {
    return res.status(400).json({ ok: false, error: 'Signup session expired.' });
  }

  const { email: tokenEmail } = signupTokens.get(signup_token);
  const user = usersByEmail.get(tokenEmail);

  if (!user || user.passwordPlain !== password) {
    return res.status(400).json({ ok: false, error: 'Invalid signup data.' });
  }

  const companyId = uuidv4();
  companiesById.set(companyId, {
    id: companyId,
    name: company_name,
    vatNumber: vat_number,
    employeeCount: employee_count,
    street,
    postalCode: postal_code,
    city,
    country,
    billingReference: billing_reference || null
  });

  user.status = 'active';
  user.companyId = companyId;
  signupTokens.delete(signup_token);

  console.log('STEP2 OK:', user.email, 'company:', company_name);

  res.json({
    ok: true,
    redirectUrl: '/login'
  });
});

// =========================================================
// API: Login
// =========================================================
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = usersByEmail.get((email || '').toLowerCase());

  if (!user || user.passwordPlain !== password || user.status !== 'active') {
    return res.status(401).json({ ok: false, error: 'Invalid e-mail or password.' });
  }

  const token = uuidv4();
  sessionsByToken.set(token, { email: user.email });

  console.log('LOGIN OK:', user.email);

  res.json({
    ok: true,
    token,
    redirectUrl: '/app'
  });
});

// =========================================================
// API: Current user
// =========================================================
app.get('/api/me', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');

  if (!sessionsByToken.has(token)) {
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
// Health
// =========================================================
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`MyPunctoo backend listening on port ${PORT}`);
});
