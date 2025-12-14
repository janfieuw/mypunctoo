const { Pool } = require('pg');

let pool = null;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing in runtime (will return db:false).');
} else {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

module.exports = { pool };
