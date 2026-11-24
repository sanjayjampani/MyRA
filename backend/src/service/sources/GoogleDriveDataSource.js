import { google } from "googleapis";
import { GoogleAuthService } from "../oauth/googleOAuthService.js";
import { logger } from "../../utils/logger.js";
import { extractPdfText } from "../../utils/extractPdfText.js";

const FOLDER = "application/vnd.google-apps.folder";
const EXPORTABLE = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

async function driveClient(userId) {
  const accessToken = await new GoogleAuthService().getValidAccessToken(userId, "google_drive");
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth });
}

export default class GoogleDriveDataSource {
  constructor(userId) {
    this.userId = userId;
    this.source = "google_drive";
    this.reconcileMissing = false;
    this.drive = null;
  }

  async fetchAll() {
    this.drive = await driveClient(this.userId);
    const files = [];
    let pageToken;
    do {
      const response = await this.drive.files.list({
        pageSize: 100,
        pageToken,
        q: "trashed = false",
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime, description)",
        corpora: "user",
      });
      for (const file of response.data.files || []) {
        if (!file.id || file.mimeType === FOLDER) continue;
        files.push(await this.withText(file));
      }
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    this.reconcileMissing = true;
    logger.info(`Fetched ${files.length} Drive files for user ${this.userId}`);
    return files;
  }

  async fetchNew() {
    return this.fetchAll();
  }

  async withText(file) {
    const exportMime = EXPORTABLE[file.mimeType];
    if (exportMime) {
      try {
        const response = await this.drive.files.export(
          { fileId: file.id, mimeType: exportMime },
          { responseType: "text" },
        );
        return { ...file, text: String(response.data || "").slice(0, 32000) };
      } catch (error) {
        logger.warn(`Drive export skipped for ${file.id}: ${error.message}`);
        return file;
      }
    }

    const mime = file.mimeType || "";
    const downloadable = mime.startsWith("text/") || mime === "application/pdf" || mime === "application/json";
    if (!downloadable) return file;
    try {
      const response = await this.drive.files.get(
        { fileId: file.id, alt: "media" },
        { responseType: "arraybuffer" },
      );
      const bytes = Buffer.from(response.data);
      if (!bytes.length || bytes.length > 1_000_000) return file;
      const text = mime === "application/pdf" ? extractPdfText(bytes) : bytes.toString("utf8");
      return text ? { ...file, text: text.slice(0, 32000) } : file;
    } catch (error) {
      logger.warn(`Drive download skipped for ${file.id}: ${error.message}`);
      return file;
    }
  }
}
