import { Router } from "express";
import StatsController from "../controllers/statsController.js";
import { requireAuth } from "../middleware/requireAuth.js";

const statsController = new StatsController();
const router = Router();
router.get("/all", requireAuth, (req, res) => statsController.getAllStats(req, res));
router.get("/daily-summary", requireAuth, (req, res) => statsController.getDailySummary(req, res));

export default router;
