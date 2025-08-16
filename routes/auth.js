import { Router } from 'express';
import { register, login, me, logout } from '../controllers/authController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', authMiddleware, me);
router.post('/logout', authMiddleware, logout);

export default router;
