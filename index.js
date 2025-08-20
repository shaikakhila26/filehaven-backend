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

console.log("FRONTEND_BASE_URL =", process.env.FRONTEND_BASE_URL);



const allowedOrigins = process.env.CORS_ORIGIN.split(",").map(origin =>
  origin.trim().replace(/\/$/, "") // strip trailing slash
);
console.log("Allowed Origins:", allowedOrigins);




app.use(cors({
  origin: function(origin, callback){
    console.log("Incoming Origin:", origin);
    if(!origin) return callback(null, true); // allow non-browser requests
    const normalizedOrigin = origin?.trim().replace(/\/$/, "");
console.log("🔍 Normalized Origin:", normalizedOrigin);

if (!allowedOrigins.some(o => o === normalizedOrigin)) {
  console.error("❌ Blocked by CORS:", { normalizedOrigin, allowedOrigins });
  return callback(new Error("CORS not allowed"), false);
}

    return callback(null, true);
  },
  credentials: true,
}));



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



