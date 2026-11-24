import { randomBytes } from "node:crypto";
import { documentRepository } from "../../database/index.js";
import EmbeddingPipeline from "../../RAG/ingestion/embeddingPipeline.js";
import { getAuthenticatedUserId } from "../middleware/requireAuth.js";
import { logger } from "../../utils/logger.js";
import {
  indexingEnabled,
  patchPreferenceKey,
  readPreferences,
} from "../../service/sources/syncCursors.js";
import { countDue, dueReminders, reminderSeries } from "../../service/reminders.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function remindersFrom(preferences) {
  return Array.isArray(preferences.reminders) ? preferences.reminders : [];
}

export default class LibraryController {
  constructor({ documents = documentRepository, embeddings = new EmbeddingPipeline() } = {}) {
    this.documents = documents;
    this.embeddings = embeddings;
  }

  async saveNote(req, res) {
    const userId = getAuthenticatedUserId(req);
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    const title = typeof req.body?.title === "string" && req.body.title.trim()
      ? req.body.title.trim().slice(0, 120)
      : content.slice(0, 80);
    if (!content) {
      return res.status(400).json({ success: false, error: "Note content is required" });
    }

    const documentId = `notes_${randomBytes(16).toString("hex")}`;
    try {
      await this.documents.create({
        user_id: userId,
        document_id: documentId,
        source: "notes",
        type: "note",
        content,
        title: title || "Note",
        timestamp: new Date(),
        author: null,
        metadata: { notes: { documentId } },
      });
      if (await indexingEnabled(userId)) {
        this.embeddings.runEmbedding(userId, { maxBatches: 1 }).catch((error) => {
          logger.warn(`Note saved but indexing is still catching up: ${error.message}`);
        });
      }
      return res.status(201).json({ success: true, data: { documentId, title } });
    } catch (error) {
      logger.error(`Failed to save note: ${error.message}`);
      return res.status(500).json({ success: false, error: "Failed to save note" });
    }
  }

  async listReminders(req, res) {
    const userId = getAuthenticatedUserId(req);
    const preferences = await readPreferences(userId);
    const reminders = remindersFrom(preferences);
    return res.json({
      success: true,
      data: {
        reminders,
        remindersDue: countDue(reminders),
        dueReminders: dueReminders(reminders),
      },
    });
  }

  async addReminder(req, res) {
    const userId = getAuthenticatedUserId(req);
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const due = typeof req.body?.due === "string" ? req.body.due : "";
    if (!title || !DAY.test(due)) {
      return res.status(400).json({ success: false, error: "A title and YYYY-MM-DD due date are required" });
    }

    const preferences = await readPreferences(userId);
    const reminders = remindersFrom(preferences);
    const reminder = {
      id: randomBytes(8).toString("hex"),
      title: title.slice(0, 160),
      due,
      createdAt: new Date().toISOString(),
      doneAt: null,
    };
    await patchPreferenceKey(userId, "reminders", [...reminders, reminder]);
    return res.status(201).json({ success: true, data: reminder });
  }

  async completeReminder(req, res) {
    const userId = getAuthenticatedUserId(req);
    const preferences = await readPreferences(userId);
    const reminders = remindersFrom(preferences);
    const reminder = reminders.find((item) => item.id === req.params.id);
    if (!reminder) {
      return res.status(404).json({ success: false, error: "Reminder not found" });
    }
    reminder.doneAt = req.body?.done === false ? null : new Date().toISOString();
    await patchPreferenceKey(userId, "reminders", reminders);
    return res.json({ success: true, data: reminder });
  }

  series(reminders, days) {
    return reminderSeries(reminders, days);
  }
}
