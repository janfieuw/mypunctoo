// server.js
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Zorg dat __dirname werkt in Node
const rootDir = __dirname;

// ===== Middleware =====
app.use(express.json());

// Statische files (frontend) uit /public
app.use(express.static(path.join(rootDir, 'public')));

/* =========================================================
   Mooie, professionele routes (geen .html zichtbaar)
========================================================= */

app.get('/', (req, res) => {
  // Kies zelf: ofwel naar /login of naar later je commerciële site.
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

/* =========================================================
   Backwards compatibility: oude .html URLs doorsturen
   (zodat je niks “breekt” bij oude bookmarks)
========================================================= */
app.get('/signup.html', (req, res) => res.redirect(301, '/signup'));
app.get('/login.html', (req, res) => res.redirect(301, '/login'));
app.get('/index.html', (req, res) => res.redirect(301, '/app'));

// (optioneel) alles wat nog .html is: 404 of redirect.
// Hier doen we 404 om het echt “clean” te houden.
app.get('/*.html', (req, res) => {
  res.status(404).send('Not found');
});

/* =========================================================
   In-memory storage (demo)
========================================================= */
const usersByEmail = new Map();
const signupTokens = new Map();
const companiesById = new Map();
const sessionsByToken = new Map();

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* =========================================================
   API: Step 1 – contactpersoon + wachtwoord
========================================================= */
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
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields.'
    });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({
      ok: false,
      error: 'Please provide a valid e-mail address.'
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      ok: false,
      error: 'Password must be at least 8 characters long.'
    });
  }

  if (password !== password_confirm) {
    return res.status(400).json({
      ok: false,
      error: 'Passwords do not match.'
    });
  }

  if (!terms) {
    return res.status(400).json({
      ok: false,
      error: 'You must accept the Terms & Conditions to continue.'
    });
  }

  const key = email.toLowerCase();

  if (usersByEmail.has(key)) {
    return res.status(400).json({
      ok: false,
      error: 'This e-mail address is already registered.'
    });
  }

  const now = new Date().toISOString();
  const user = {
    id: uuidv4(),
    firstName: first_name,
    lastName: last_name,
    email: key,
    passwordPlain: password, // ⚠️ DEMO: in productie hashen!
    status: 'pending_step2',
    createdAt: now,
    companyId: null
  };

  usersByEmail.set(key, user);

  const token = uuidv4();
  signupTokens.set(token, { email: key, createdAt: now });

  console.log('STEP1 OK:', user.email, 'token:', token);

  return res.json({
    ok: true,
    signupToken: token,
    message: 'Admin account created. Continue to Step 2 to complete your company profile.'
  });
});

/* =========================================================
   API: Step 2 – bedrijfsdetails + account activeren
========================================================= */
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

  // Token check
  if (!signup_token || !signupTokens.has(signup_token)) {
    return res.status(400).json({
      ok: false,
      error: 'Your signup session has expired. Please restart the registration.'
    });
  }

  const tokenData = signupTokens.get(signup_token);
  const emailFromToken = tokenData.email;

  const user = usersByEmail.get(emailFromToken);
  if (!user) {
    return res.status(400).json({
      ok: false,
      error: 'User not found for this signup token.'
    });
  }

  if (user.status !== 'pending_step2') {
    return res.status(400).json({
      ok: false,
      error: 'This signup is already completed.'
    });
  }

  // (optioneel) veldvergelijking met stap 1
  if (email && email.toLowerCase() !== user.email) {
    return res.status(400).json({
      ok: false,
      error: 'E-mail address does not match the one from Step 1.'
    });
  }

  if (password && password !== user.passwordPlain) {
    return res.status(400).json({
      ok: false,
      error: 'Password does not match the one from Step 1.'
    });
  }

  // Validatie bedrijfsvelden
  if (!company_name || !vat_number || !employee_count || !street || !postal_code || !city || !country) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required company information.'
    });
  }

  const employeeCountNum = Number(employee_count);
  if (!Number.isFinite(employeeCountNum) || employeeCountNum <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'Number of employees must be at least 1.'
    });
  }

  if (String(vat_number).length < 4) {
    return res.status(400).json({
      ok: false,
      error: 'The VAT number you provided is not valid.'
    });
  }

  // Company aanmaken
  const companyId = uuidv4();
  const company = {
    id: companyId,
    name: company_name,
    vatNumber: vat_number,
    employeeCount: employeeCountNum,
    street,
    postalCode: postal_code,
    city,
    country,
    billingReference: billing_reference || null,
    createdAt: new Date().toISOString(),
    adminEmail: user.email
  };

  companiesById.set(companyId, company);

  // User activeren
  user.status = 'active';
  user.companyId = companyId;

  // Token ongeldig maken
  signupTokens.delete(signup_token);

  console.log('STEP2 OK:', user.email, 'company:', company.name);

  return res.json({
    ok: true,
    message: 'Your account and company profile have been created successfully.',
    // ✅ professionele URL
    redirectUrl: '/login'
  });
});

/* =========================================================
   API: Login
========================================================= */
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      error: 'Missing e-mail or password.'
    });
  }

  const user = usersByEmail.get(email.toLowerCase());
  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid e-mail or password.'
    });
  }

  if (user.status !== 'active') {
    return res.status(403).json({
      ok: false,
      error: 'Your account is not active yet.'
    });
  }

  if (user.passwordPlain !== password) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid e-mail or password.'
    });
  }

  console.log('LOGIN OK:', user.email);

  const sessionToken = uuidv4();
  sessionsByToken.set(sessionToken, {
    email: user.email,
    companyId: user.companyId,
    createdAt: new Date().toISOString()
  });

  return res.json({
    ok: true,
    token: sessionToken,
    // ✅ professionele URL
    redirectUrl: '/app',
    user: {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      companyId: user.companyId
    }
  });
});

/* =========================================================
   API: Session check / current user
========================================================= */
app.get('/api/me', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const parts = authHeader.split(' ');

  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      ok: false,
      error: 'No valid Authorization header.'
    });
  }

  const token = parts[1];
  if (!token || !sessionsByToken.has(token)) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid or expired session.'
    });
  }

  const session = sessionsByToken.get(token);
  const user = usersByEmail.get(session.email);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'User not found for this session.'
    });
  }

  return res.json({
    ok: true,
    user: {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      companyId: user.companyId
    }
  });
});

/* =========================================================
   Healthcheck
========================================================= */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'up', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`MyPunctoo backend listening on port ${PORT}`);
});
