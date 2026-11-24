import { google } from "googleapis";
import BaseDataSource from "./BaseDataSource.js";
import { GoogleAuthService } from "../oauth/googleOAuthService.js";
import { logger } from "../../utils/logger.js";
import { patchSyncCursors, readSyncCursors } from "./syncCursors.js";

const FULL_SYNC_TIME_MIN = "1970-01-01T00:00:00Z";

async function getGoogleCalendarClient(userId) {
  const oauthService = new GoogleAuthService();
  const accessToken = await oauthService.getValidAccessToken(
    userId,
    "google_calendar"
  );
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.calendar({ version: "v3", auth: oauth2Client });
}

function statusCode(error) {
  return error?.code || error?.status || error?.response?.status;
}

export default class GoogleCalendarDataSource extends BaseDataSource {
  constructor(userId) {
    super("google_calendar");
    this.userId = userId;
    this.oauthService = new GoogleAuthService();
    this.calendar = null;
    this.pendingCursor = null;
  }

  getName() {
    return "Google Calendar";
  }

  getSource() {
    return this.source;
  }

  async initializeClient() {
    this.calendar = await getGoogleCalendarClient(this.userId);
    logger.info(`Google Calendar client initialized for user ${this.userId}`);
  }

  async validateConnection() {
    try {
      await this.initializeClient();
      await this.calendar.calendarList.list({ maxResults: 1 });
      this.setConnectionStatus(true);
      return true;
    } catch (error) {
      logger.error(`Calendar connection validation failed: ${error.message}`);
      this.setConnectionStatus(false);
      return false;
    }
  }

  async listCalendarIds() {
    const ids = [];
    let pageToken;
    do {
      const response = await this.calendar.calendarList.list({
        maxResults: 250,
        pageToken,
      });
      for (const calendar of response.data.items || []) {
        if (calendar.id && calendar.selected !== false) ids.push(calendar.id);
      }
      pageToken = response.data.nextPageToken;
    } while (pageToken);
    return ids.length > 0 ? ids : ["primary"];
  }

  async collectEvents(calendarId, params) {
    const events = [];
    let pageToken;
    let nextSyncToken = null;
    do {
      const response = await this.calendar.events.list({
        calendarId,
        maxResults: 250,
        singleEvents: true,
        showDeleted: true,
        pageToken,
        ...params,
      });
      for (const event of response.data.items || []) {
        events.push({ ...event, calendarId });
      }
      pageToken = response.data.nextPageToken;
      nextSyncToken = response.data.nextSyncToken || nextSyncToken;
      await this.sleep(100);
    } while (pageToken);
    return { events, nextSyncToken };
  }

  /**
   * Every selected calendar, from the start of the calendar, not a 2026 floor
   * and not only primary. Sync tokens are stored for the next incremental run.
   */
  async fetchAll() {
    await this.initializeClient();
    logger.info(`Fetching calendar events for user ${this.userId}`);

    const calendarIds = await this.listCalendarIds();
    const allEvents = [];
    const calendarTokens = {};

    try {
      for (const calendarId of calendarIds) {
        const page = await this.collectEvents(calendarId, {
          timeMin: FULL_SYNC_TIME_MIN,
        });
        allEvents.push(...page.events);
        if (page.nextSyncToken) calendarTokens[calendarId] = page.nextSyncToken;
        logger.info(`Fetched ${allEvents.length} calendar events so far...`);
      }

      this.pendingCursor = { calendarTokens };
      logger.info(`Completed Calendar sync: ${allEvents.length} events fetched`);
      return allEvents;
    } catch (error) {
      logger.error(`Calendar fetchAll failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Incremental sync uses the per-calendar sync token, which returns edits and
   * cancellations of events that already ended. `timeMin` does not.
   */
  async fetchNew(since) {
    await this.initializeClient();
    logger.info(
      `Fetching new calendar events for user ${this.userId} since ${since.toISOString()}`
    );

    const cursors = await readSyncCursors(this.userId);
    const storedTokens = cursors.calendarTokens || {};
    if (Object.keys(storedTokens).length === 0) {
      return this.fetchAll();
    }

    try {
      const calendarIds = await this.listCalendarIds();
      const allEvents = [];
      const calendarTokens = { ...storedTokens };

      for (const calendarId of calendarIds) {
        const token = storedTokens[calendarId];
        if (!token) {
          const page = await this.collectEvents(calendarId, {
            timeMin: FULL_SYNC_TIME_MIN,
          });
          allEvents.push(...page.events);
          if (page.nextSyncToken) calendarTokens[calendarId] = page.nextSyncToken;
          continue;
        }

        try {
          const page = await this.collectEvents(calendarId, { syncToken: token });
          allEvents.push(...page.events);
          if (page.nextSyncToken) calendarTokens[calendarId] = page.nextSyncToken;
        } catch (error) {
          if (statusCode(error) !== 410) throw error;
          const page = await this.collectEvents(calendarId, {
            timeMin: FULL_SYNC_TIME_MIN,
          });
          allEvents.push(...page.events);
          if (page.nextSyncToken) calendarTokens[calendarId] = page.nextSyncToken;
        }
      }

      this.pendingCursor = { calendarTokens };
      return allEvents;
    } catch (error) {
      logger.error(`Calendar incremental sync failed: ${error.message}`);
      throw error;
    }
  }

  async commitCursor() {
    if (!this.pendingCursor) return;
    await patchSyncCursors(this.userId, this.pendingCursor);
    this.pendingCursor = null;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
