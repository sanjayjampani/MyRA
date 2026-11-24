import { google } from "googleapis";
import { GoogleAuthService } from "../oauth/googleOAuthService.js";
import { logger } from "../../utils/logger.js";
import { patchSyncCursors, readSyncCursors } from "./syncCursors.js";
import { extractPdfText } from "../../utils/extractPdfText.js";

/**
 * Gmail `after:` accepts epoch seconds. A calendar date is exclusive of that
 * whole day, so same-day mail never showed up until the date rolled over.
 */
export function gmailAfterQuery(since) {
  const instant = since instanceof Date ? since : new Date(since);
  const seconds = Math.floor(instant.getTime() / 1000) - 1;
  return `after:${Math.max(0, seconds)}`;
}

function statusCode(error) {
  return error?.code || error?.status || error?.response?.status;
}

export default class GmailDataSource {
  constructor(userId) {
    this.userId = userId;
    this.source = "gmail";
    this.oauthService = new GoogleAuthService();
    this.gmail = null;
    this.pendingCursor = null;
    this.reconcileMissing = false;
  }

  getName() {
    return "Gmail";
  }

  getSource() {
    return this.source;
  }

  async initializeClient() {
    const accessToken = await this.oauthService.getValidAccessToken(
      this.userId,
      this.source
    );
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    this.gmail = google.gmail({ version: "v1", auth: oauth2Client });

    logger.info(`Gmail Client initialized for user ${this.userId}`);
  }

  /**
   * Page the mailbox. `maxResults` caps the total when a caller passes it;
   * omitted means every page. There is no date floor.
   */
  async fetchAll(options = {}) {
    await this.initializeClient();

    const maxResults = options.maxResults ?? Number.POSITIVE_INFINITY;
    const query = options.query ?? "";
    this.reconcileMissing = false;
    logger.info(
      `Fetching emails for user ${this.userId} with maxResults=${maxResults} and query='${query}'`
    );

    const allMessages = [];
    let pageToken;
    try {
      do {
        const remaining = maxResults - allMessages.length;
        if (remaining <= 0) break;

        const messageListResponse = await this.gmail.users.messages.list({
          userId: "me",
          maxResults: Math.min(100, remaining),
          pageToken,
          ...(query ? { q: query } : {}),
        });
        const messages = messageListResponse.data.messages || [];
        if (messages.length === 0) break;

        const messageDetails = await this.fetchMessageBatch(
          messages.map((message) => message.id)
        );
        allMessages.push(...messageDetails);
        pageToken = messageListResponse.data.nextPageToken;
        logger.info(`Fetched ${allMessages.length} emails so far...`);

        await this.sleep(100);
      } while (pageToken);

      const historyId = await this.currentHistoryId();
      if (historyId) this.pendingCursor = { gmailHistoryId: historyId };

      logger.info(`Completed Gmail sync: ${allMessages.length} emails fetched`);
      // A query or a cap is a partial window. Only a complete mailbox can
      // name the messages that disappeared while a history id was expired.
      this.reconcileMissing = query === "" && !Number.isFinite(maxResults);
      return Number.isFinite(maxResults)
        ? allMessages.slice(0, maxResults)
        : allMessages;
    } catch (error) {
      logger.info(`GmailfetchAll failed : ${error.message}`);
      throw error;
    }
  }

  /**
   * Incremental sync follows Gmail history so additions and deletions are both
   * visible. The cursor is committed by ingestion only after the batch is stored.
   */
  async fetchNew(since) {
    await this.initializeClient();
    logger.info(
      `Fetching new emails for user ${this.userId} since ${since.toISOString()}`
    );

    const cursors = await readSyncCursors(this.userId);
    if (!cursors.gmailHistoryId) {
      return this.fetchAll({ query: gmailAfterQuery(since) });
    }

    try {
      const changes = await this.listHistory(cursors.gmailHistoryId);
      const messages = await this.fetchMessageBatch(changes.added);
      this.pendingCursor = { gmailHistoryId: changes.historyId };
      return [
        ...changes.deleted.map((id) => ({ id, deleted: true })),
        ...messages,
      ];
    } catch (error) {
      if (statusCode(error) !== 404) {
        logger.error(`Gmail incremental sync failed: ${error.message}`);
        throw error;
      }
      logger.warn(`Gmail history ${cursors.gmailHistoryId} expired; backfilling the mailbox`);
      return this.fetchAll();
    }
  }

  async commitCursor() {
    if (!this.pendingCursor) return;
    await patchSyncCursors(this.userId, this.pendingCursor);
    this.pendingCursor = null;
  }

  async currentHistoryId() {
    const profile = await this.gmail.users.getProfile({ userId: "me" });
    return profile.data.historyId || null;
  }

  async listHistory(startHistoryId) {
    const added = new Set();
    const deleted = new Set();
    let pageToken;
    let historyId = startHistoryId;

    do {
      const response = await this.gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded", "messageDeleted"],
        pageToken,
      });
      historyId = response.data.historyId || historyId;
      for (const record of response.data.history || []) {
        for (const item of record.messagesAdded || []) {
          if (item.message?.id) added.add(item.message.id);
        }
        for (const item of record.messagesDeleted || []) {
          if (item.message?.id) deleted.add(item.message.id);
        }
      }
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    for (const id of deleted) added.delete(id);
    return { added: [...added], deleted: [...deleted], historyId };
  }

  async fetchMessageBatch(messageIds) {
    const messages = [];
    const batchSize = 50;
    for (let itr = 0; itr < messageIds.length; itr += batchSize) {
      const batch = messageIds.slice(itr, itr + batchSize);
      const batchResults = await Promise.all(batch.map(async (id) => {
        try {
          const response = await this.gmail.users.messages.get({
            userId: "me",
            id,
            format: "full",
          });
          return response.data;
        } catch (error) {
          if (statusCode(error) === 404) return null;
          logger.info(`Failed to fetch message ${id}: ${error.message}`);
          throw error;
        }
      }));
      const fetched = batchResults.filter((message) => message != null);
      for (const message of fetched) {
        await this.hydrateAttachments(message);
      }
      messages.push(...fetched);
      await this.sleep(100);
    }
    return messages;
  }

  async hydrateAttachments(message) {
    if (!this.gmail || !message?.id) return;
    const parts = [];
    const walk = (part) => {
      if (!part) return;
      parts.push(part);
      for (const child of part.parts || []) walk(child);
    };
    walk(message.payload);
    let fetched = 0;
    for (const part of parts) {
      if (fetched >= 5 || !part.filename || !part.body?.attachmentId) continue;
      const mime = part.mimeType || "";
      const readable = mime.startsWith("text/") || mime === "application/pdf" || mime === "application/json";
      if (!readable) continue;
      try {
        const response = await this.gmail.users.messages.attachments.get({
          userId: "me",
          messageId: message.id,
          id: part.body.attachmentId,
        });
        const bytes = Buffer.from(response.data?.data || "", "base64url");
        if (!bytes.length || bytes.length > 1_000_000) continue;
        part.body.text = mime === "application/pdf"
          ? extractPdfText(bytes)
          : bytes.toString("utf8").slice(0, 8000);
        fetched += 1;
      } catch (error) {
        logger.info(`Attachment skipped for ${message.id}: ${error.message}`);
      }
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
