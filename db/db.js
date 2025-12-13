// db/db.js
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL is missing. Set it in Railway Variables.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres vereist meestal SSL
  ssl: process.env.DATABASE_SSL === 'false'
    ? false
    : { rejectUnauthorized: false }
});

module.exports = { pool };
