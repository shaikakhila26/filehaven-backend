import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import passport from 'passport';
import { connectDB } from './utils/db.js';
import authRoutes from './routes/auth.js';
import googleAuthRoutes from './routes/googleAuth.js';
import './utils/passport.js';
import fileRoutes from './routes/files.js';

dotenv.config();
const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(passport.initialize());

app.get('/', (_req, res) => res.send('File Haven Backend is running...'));

app.use('/api/auth', authRoutes);
app.use('/api/auth', googleAuthRoutes);
app.use('/api', fileRoutes);


app.use((req, res) => {
  res.status(404).json({ error: `No endpoint: ${req.method} ${req.originalUrl}` });
});


connectDB();




app.listen(process.env.PORT, () => {
  console.log(`🚀 Server running on http://localhost:${process.env.PORT}`);
});



