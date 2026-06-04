// src/db.js
const { Pool } = require('pg');

const poolConfig = {
  connectionString: process.env.DATABASE_URL
};

// Dynamic SSL matching: Supabase pooler (port 6543) and local servers don't support/need SSL.
const isPooler = process.env.DATABASE_URL && process.env.DATABASE_URL.includes(':6543');
const isLocal = process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1'));

if (!isPooler && !isLocal) {
  poolConfig.ssl = {
    rejectUnauthorized: false
  };
}

const pool = new Pool(poolConfig);

// The pg driver's TIMESTAMP parser uses Node.js local timezone (Asia/Kolkata).
// Stored values must be in IST representation for correct round-trip.
// Set session timezone to IST so INSERT converts UTC input to IST.
pool.on('connect', async (client) => {
  try {
    await client.query("SET TIMEZONE TO 'Asia/Kolkata'");
  } catch (err) {
    console.error("[DB] Timezone init error:", err.message);
  }
});

module.exports = pool;