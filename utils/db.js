import dotenv from 'dotenv';
dotenv.config();

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Supabase requires SSL in most plans
});

console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('PGHOST:', process.env.PGHOST);
console.log('DB_HOST:', process.env.DB_HOST);


export const connectDB = async () => {
  console.log('DATABASE_URL being used:', process.env.DATABASE_URL);

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
