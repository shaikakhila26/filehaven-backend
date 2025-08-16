import dotenv from 'dotenv';
dotenv.config(); // must be before reading process.env

import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

// We’ll run sessionless, so only initialize strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        const name = profile.displayName;
        const picture = profile.photos?.[0]?.value;
        return done(null, {
          email,
          name,
          picture,
          provider: 'google',
          provider_id: profile.id
        });
      } catch (err) {
        done(err, null);
      }
    }
  )
);

export default passport;
