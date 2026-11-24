import { StatsRepository } from "../../database/statsRepository.js";
import { logger } from "../../utils/logger.js";
import { getAuthenticatedUserId } from "../middleware/requireAuth.js";
import { readPreferences } from "../../service/sources/syncCursors.js";
import { countDue, dueReminders, reminderSeries } from "../../service/reminders.js";

const RANGE_TO_DAYS = { "7d": 7, "14d": 14, "30d": 30, "90d": 90 };

const MODEL_COLORS = {
  "claude-haiku-4-5": "#7A4A2E",
  "claude-haiku-4-5-20251001": "#7A4A2E",
  "claude-3-5-sonnet-20241022": "#C9845A",
  "gpt-4.1-nano": "#3A6A9A",
  "gpt-5.4-nano": "#5C8A4A",
  "gpt-5.4-mini": "#C96A2E",
  "text-embedding-3-small": "#D4A96A",
  "text-embedding-3-large": "#B4895A",
  "gemini-embedding-001": "#D4A96A",
};

const DEFAULT_COLOR = "#8C6A4A";

export default class StatsController {
  constructor() {
    this.statsRepo = new StatsRepository();
  }

  async getAllStats(req, res) {
    const rangeParam = req.query.range || "14d";
    const days = RANGE_TO_DAYS[rangeParam] ?? 14;
    const userId = getAuthenticatedUserId(req);

    try {
      const [tokensData, sessionData, emailsData, calData] = await Promise.all([
        this.statsRepo.getCostAndTokensConsumed(days, userId),
        this.statsRepo.getConversationSessions(days, userId),
        this.statsRepo.getEmails(days, userId),
        this.statsRepo.getCalendarEvents(days, userId),
      ]);

      // tokens: one entry per model with total token count + color
      const tokens = tokensData.map((row) => ({
        name: row.model,
        value:
          parseInt(row.totalinputtokens || 0) +
          parseInt(row.totaloutputtokens || 0),
        color: MODEL_COLORS[row.model] || DEFAULT_COLOR,
      }));

      // cost: aggregate spend by provider (multiple models can share a provider)
      const costMap = {};
      for (const row of tokensData) {
        const spend =
          parseFloat(row.totalinputcost || 0) +
          parseFloat(row.totaloutputcost || 0);
        costMap[row.provider] = (costMap[row.provider] || 0) + spend;
      }
      const cost = Object.entries(costMap).map(([provider, spend]) => ({
        provider,
        spend: parseFloat(spend.toFixed(2)),
        currency: "INR",
      }));

      const sessions = sessionData.map((row) => parseInt(row.totalsessions || 0));
      const emails = emailsData.map((row) => parseInt(row.count || 0));
      const calEvents = calData.map((row) => parseInt(row.count || 0));
      const preferences = await readPreferences(userId);
      const reminders = reminderSeries(
        Array.isArray(preferences.reminders) ? preferences.reminders : [],
        days,
      );

      return res.status(200).json({
        success: true,
        data: {
          currency: "INR",
          emails,
          tokens,
          reminders,
          cost,
          sessions,
          calEvents,
        },
      });
    } catch (error) {
      logger.error("Error fetching stats", { error: error.message });
      return res
        .status(500)
        .json({ success: false, error: "Failed to fetch stats" });
    }
  }

  async getDailySummary(req, res) {
    const userId = getAuthenticatedUserId(req);
    try {
      const [unreadEmails, meetings, preferences] = await Promise.all([
        this.statsRepo.countUnreadEmails(userId),
        this.statsRepo.countMeetingsToday(userId),
        readPreferences(userId),
      ]);
      const reminders = Array.isArray(preferences.reminders) ? preferences.reminders : [];
      return res.status(200).json({
        success: true,
        data: {
          unreadEmails: Number(unreadEmails) || 0,
          remindersDue: countDue(reminders),
          dueReminders: dueReminders(reminders),
          meetings: Number(meetings) || 0,
        },
      });
    } catch (error) {
      logger.error("Error fetching daily summary", { error: error.message });
      return res.status(500).json({ success: false, error: "Failed to fetch daily summary" });
    }
  }

  async getUpcomingEvents(req, res) {
    const userId = getAuthenticatedUserId(req);
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0
      ? Math.min(requested, 20)
      : 5;
    try {
      const rows = await this.statsRepo.listUpcomingEvents(userId, limit);
      const events = rows.map((row) => {
        let metadata = row.metadata || {};
        if (typeof metadata === "string") {
          try {
            metadata = JSON.parse(metadata);
          } catch {
            metadata = {};
          }
        }
        const calendar = metadata.calendar || {};
        const when = new Date(row.timestamp);
        const time = calendar.is_all_day
          ? "All day"
          : when.toLocaleTimeString("en-IN", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
          });
        return {
          time,
          title: row.title || calendar.summary || "Untitled event",
          where: calendar.location || "",
        };
      });
      return res.status(200).json({ success: true, data: events });
    } catch (error) {
      logger.error("Error fetching upcoming events", { error: error.message });
      return res.status(500).json({ success: false, error: "Failed to fetch upcoming events" });
    }
  }
}
