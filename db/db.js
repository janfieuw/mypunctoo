// db/db.js
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is missing in runtime. Refusing to start DB pool.');
  // hard crash: zo merk je meteen dat Railway geen env injecteert
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = { pool };
