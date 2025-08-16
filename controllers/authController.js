import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../utils/db.js';
import { registerSchema, loginSchema } from '../validators/authSchemas.js';

const signToken = (user) =>
  jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

export const register = async (req, res) => {
  try {
    const data = registerSchema.parse(req.body);

    // check if email exists
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [data.email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(data.password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, name, password,provider,avatar_url) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name , provider, avatar_url',
      [data.email, data.name, hashed,'local','https://example.com/default-avatar.png']
    );

    const user = result.rows[0];
    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: 'Server error' });
  }
};

export const login = async (req, res) => {
  try {
    const data = loginSchema.parse(req.body);

    const result = await pool.query('SELECT * FROM users WHERE email=$1', [data.email]);
    const user = result.rows[0];
    if (!user || !user.password) return res.status(400).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(data.password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid credentials' });

    const token = signToken(user);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: 'Server error' });
  }
};

export const me = async (req, res) => {
  const result = await pool.query(
    'SELECT id, email, name, avatar_url, provider FROM users WHERE id=$1',
    [req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ user: result.rows[0] });
};

export const logout = (req, res) => {
  // In stateless JWT auth, logout is just a client-side token removal
  res.json({ message: 'Logged out successfully' });
};
