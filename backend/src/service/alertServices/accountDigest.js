import cron from "node-cron";
import Mailer from "../../utils/mailSender.js";
import { logger } from "../../utils/logger.js";
import { userRepository } from "../../database/index.js";
import { StatsRepository } from "../../database/statsRepository.js";
import { countDue } from "../reminders.js";

const stats = new StatsRepository();
const mailer = new Mailer();
let tasks = [];

export function wantsDailyDigest(settings = {}) {
  return settings.dailySummary !== false;
}

export function wantsWeeklyReview(settings = {}) {
  return settings.weeklyReview === true;
}

export function wantsSyncAlert(settings = {}) {
  return settings.syncAlerts !== false;
}

function preferenceObject(preferences) {
  if (!preferences) return {};
  if (typeof preferences === "string") {
    try {
      const parsed = JSON.parse(preferences);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof preferences === "object" ? preferences : {};
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]
  ));
}

export async function notifySyncFailure(userId, source, message) {
  try {
    if (!process.env.MAIL_USER) return;
    const user = await userRepository.findById(userId);
    if (!user?.email || !wantsSyncAlert(preferenceObject(user.preferences).settings)) return;
    await mailer.sendMail({
      to: user.email,
      subject: `MyRa sync failed: ${source}`,
      html: `<p>The ${escapeHtml(source)} sync did not finish.</p><p>${escapeHtml(message || "Unknown error")}</p>`,
    });
  } catch (error) {
    logger.warn(`Sync alert was not sent: ${error.message}`);
  }
}

export async function runAccountDigests(kind, now = new Date()) {
  if (!process.env.MAIL_USER) {
    logger.info("Account digest skipped; mail is not configured");
    return;
  }
  const accounts = await userRepository.listActiveAccounts();
  for (const account of accounts) {
    try {
      const preferences = preferenceObject(account.preferences);
      const settings = preferences.settings || {};
      const wanted = kind === "weekly" ? wantsWeeklyReview(settings) : wantsDailyDigest(settings);
      if (!wanted) continue;
      const [unread, meetings] = await Promise.all([
        stats.countUnreadEmails(account.id),
        stats.countMeetingsToday(account.id),
      ]);
      const due = countDue(Array.isArray(preferences.reminders) ? preferences.reminders : [], now);
      const intro = kind === "weekly" ? "<p>This is the Sunday review.</p>" : "";
      await mailer.sendMail({
        to: account.email,
        subject: kind === "weekly" ? "MyRa weekly review" : "MyRa daily summary",
        html: `${intro}<p>Unread email: ${unread}</p><p>Meetings today: ${meetings}</p><p>Reminders due: ${due}</p>`,
      });
    } catch (error) {
      logger.warn(`Digest skipped for user ${account.id}: ${error.message}`);
    }
  }
}

export function startAccountDigest() {
  if (tasks.length || process.env.ENABLE_ACCOUNT_DIGEST_CRON === "false") return;
  const timezone = process.env.CRON_TIMEZONE || "Asia/Kolkata";
  const daily = process.env.ACCOUNT_DIGEST_CRON || "0 8 * * *";
  const weekly = process.env.ACCOUNT_WEEKLY_CRON || "0 8 * * 0";
  if (!cron.validate(daily) || !cron.validate(weekly)) {
    logger.error("Invalid account digest cron schedule");
    return;
  }
  const run = (kind) => {
    runAccountDigests(kind).catch((error) => {
      logger.error(`${kind} digest failed: ${error.message}`);
    });
  };
  tasks = [
    cron.schedule(daily, () => run("daily"), { timezone }),
    cron.schedule(weekly, () => run("weekly"), { timezone }),
  ];
  logger.info("Account digest scheduled", { daily, weekly, timezone });
}

export function stopAccountDigest() {
  tasks.forEach((task) => task.stop());
  tasks = [];
}
