import { Router } from "express";
import { AuthController } from "../controllers/authController.js";
import { requireAuth } from "../middleware/requireAuth.js";
const authController = new AuthController();

const router = Router();

// Initiate Google OAuth login
router.get("/google/login", (req, res, next) => {
  authController.initiateGoogleLogin(req, res, next);
});

// Handle Google OAuth callback
router.get("/google/callback", (req, res, next) => {
  authController.handleGoogleCallback(req, res, next);
});

router.post("/exchange", (req, res) => authController.exchangeLoginCode(req, res));

router.get("/preferences", requireAuth, (req, res) => authController.getSettings(req, res));
router.put("/preferences", requireAuth, (req, res) => authController.updateSettings(req, res));
router.get("/providers", requireAuth, (req, res) => authController.getProviders(req, res));
router.post("/telemetry", requireAuth, (req, res) => authController.reportTelemetry(req, res));
router.get("/export", requireAuth, (req, res) => authController.exportAccount(req, res));
router.delete("/account", requireAuth, (req, res) => authController.deleteAccount(req, res));

// Get current user
router.get("/me", requireAuth, (req, res, next) => {
  authController.getCurrentUser(req, res, next);
});

// Update app-level display name (user_name)
router.patch("/user/name", requireAuth, (req, res, next) => {
  authController.updateUserName(req, res, next);
});

// Logout
router.post("/logout", requireAuth, (req, res, next) => {
  authController.logout(req, res, next);
});

export default router;
