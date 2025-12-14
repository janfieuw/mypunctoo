// db/db.js
const { Pool } = require('pg');

function safeParse(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || '(default)',
      db: (u.pathname || '').replace('/', '') || '(none)',
      sslmode: u.searchParams.get('sslmode') || '(none)',
    };
  } catch {
    return null;
  }
}

const hasDbUrl = !!process.env.DATABASE_URL;

const pg = {
  PGHOST: process.env.PGHOST,
  PGPORT: process.env.PGPORT,
  PGUSER: process.env.PGUSER,
  PGDATABASE: process.env.PGDATABASE,
  HAS_PASSWORD: !!process.env.PGPASSWORD,
};

console.log('DB ENV CHECK:', {
  HAS_DATABASE_URL: hasDbUrl,
  DATABASE_URL_PARSED: hasDbUrl ? safeParse(process.env.DATABASE_URL) : null,
  PG_VARS_PRESENT: {
    PGHOST: !!pg.PGHOST,
    PGPORT: !!pg.PGPORT,
    PGUSER: !!pg.PGUSER,
    PGDATABASE: !!pg.PGDATABASE,
    HAS_PASSWORD: pg.HAS_PASSWORD,
  }
});

// Kies connectie: voorkeur DATABASE_URL, anders PG*.
const pool = hasDbUrl
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl: { rejectUnauthorized: false },
    });

module.exports = { pool };
