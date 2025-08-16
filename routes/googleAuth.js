import { Router } from 'express';
import passport from 'passport';
import pool from '../utils/db.js';
import jwt from 'jsonwebtoken';
import '../utils/passport.js'; // initializes Google strategy

const router = Router();

// 1) Kick off Google login
router.get(
  '/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);

// 2) Callback
router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/auth/failure' }),
  async (req, res) => {
    try {
      const profile = req.user; // set by passport strategy
      const { email, name, picture, provider, provider_id } = profile;

      // upsert user
      const existing = await pool.query(
        'SELECT id, email, name FROM users WHERE provider=$1 AND provider_id=$2',
        [provider, provider_id]
      );

      let user;
      if (existing.rows.length) {
        user = existing.rows[0];
      } else {
        // merge by email if already registered via password
        const byEmail = await pool.query('SELECT id, email, name FROM users WHERE email=$1', [email]);
        if (byEmail.rows.length) {
          await pool.query(
            'UPDATE users SET provider=$1, provider_id=$2, avatar_url=$3 WHERE id=$4',
            [provider, provider_id, picture, byEmail.rows[0].id]
          );
          user = byEmail.rows[0];
        } else {
          const inserted = await pool.query(
            `INSERT INTO users (email, name, password, provider, provider_id, avatar_url)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, name,provider,avatar_url`,
            [email, name, null, provider, provider_id, picture]
          );
          user = inserted.rows[0];
        }
      }

      const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

      // Redirect to frontend with token (choose your front-end route)
      const redirectURL = new URL('/oauth/callback', process.env.CORS_ORIGIN);
      redirectURL.searchParams.set('token', token);
      return res.redirect(redirectURL.toString());
    } catch (e) {
      console.error(e);
      res.redirect('/auth/failure');
    }
  }
);

// Optional failure route
router.get('/failure', (req, res) => res.status(401).send('Google auth failed'));

export default router;
