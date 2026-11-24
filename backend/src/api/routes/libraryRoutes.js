import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import LibraryController from "../controllers/libraryController.js";

const router = Router();
const library = new LibraryController();

router.use(requireAuth);
router.post("/notes", (req, res) => library.saveNote(req, res));
router.get("/reminders", (req, res) => library.listReminders(req, res));
router.post("/reminders", (req, res) => library.addReminder(req, res));
router.patch("/reminders/:id", (req, res) => library.completeReminder(req, res));

export default router;
