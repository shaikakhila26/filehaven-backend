import dotenv from 'dotenv';
dotenv.config();

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Supabase requires SSL in most plans
});

export const connectDB = async () => {
  try {
    await pool.connect();
    console.log('✅ Connected to Supabase PostgreSQL');
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error(err);
    process.exit(1);
  }
};

export default pool;
