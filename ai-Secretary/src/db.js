// src/db.js
const { Pool } = require('pg');

// This uses the DATABASE_URL from your .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Supabase connections
  }
});

module.exports = pool;