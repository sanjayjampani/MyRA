import assert from "node:assert/strict";
import { test } from "node:test";

import IngestionPipeline from "../../src/RAG/ingestion/ingestionPipeline.js";
import { GmailNormalizer } from "../../src/service/normalizers/GmailNormalizer.js";
import { countDue, reminderSeries } from "../../src/service/reminders.js";
import { chatSourceFilter } from "../../src/api/controllers/chatController.js";
import { wantsDailyDigest, wantsSyncAlert, wantsWeeklyReview } from "../../src/service/alertServices/accountDigest.js";
import { extractPdfText } from "../../src/utils/extractPdfText.js";
import { GMAIL_PLAIN_MESSAGE, OWNER_USER_ID } from "../fixtures/fnd06-baseline-fixtures.js";

test("reminders due today are counted and the chart stays one point per day", () => {
  const now = new Date("2026-11-06T10:00:00.000Z");
  const reminders = [
    { id: "a", title: "Pay", due: "2026-11-06", createdAt: "2026-11-06T02:00:00.000Z", doneAt: null },
    { id: "b", title: "Old", due: "2026-11-01", createdAt: "2026-11-01T02:00:00.000Z", doneAt: "2026-11-05T02:00:00.000Z" },
    { id: "c", title: "Later", due: "2026-11-20", createdAt: "2026-11-06T02:00:00.000Z", doneAt: null },
  ];

  assert.equal(countDue(reminders, now), 1);
  const series = reminderSeries(reminders, 7, now);
  assert.equal(series.length, 7);
  assert.equal(series.reduce((sum, point) => sum + point.set, 0), 3);
  assert.equal(series.reduce((sum, point) => sum + point.done, 0), 1);
});

test("a named attachment is kept with the message", () => {
  const message = {
    ...GMAIL_PLAIN_MESSAGE,
    payload: {
      ...GMAIL_PLAIN_MESSAGE.payload,
      parts: [
        ...(GMAIL_PLAIN_MESSAGE.payload.parts || []),
        { filename: "agenda.txt", mimeType: "text/plain", body: { data: Buffer.from("Bring the notes").toString("base64url") } },
      ],
    },
  };
  const document = new GmailNormalizer().normalize(message, OWNER_USER_ID);
  assert.match(document.content, /Attachment: agenda\.txt/);
  assert.match(document.content, /Bring the notes/);
  assert.deepEqual(document.metadata.gmail.attachments, ["agenda.txt"]);
});

test("a complete mailbox drops stored mail that is no longer present", async () => {
  const deleted: string[] = [];
  const pipeline = new IngestionPipeline({
    documentRepo: {
      async findByDocumentId(documentId: string) {
        return documentId === "gmail_gone"
          ? { id: 9, document_id: documentId, user_id: OWNER_USER_ID }
          : null;
      },
      async listDocumentIds() {
        return ["gmail_18f0aa11bb22cc33", "gmail_gone"];
      },
      async deleteByDocumentId(documentId: string) {
        deleted.push(documentId);
        return { id: 9 };
      },
      async create() {},
      async updateForReindex() {},
    },
    sources: {
      gmail: {
        source: class {
          reconcileMissing = true;
          async fetchAll() {
            return [GMAIL_PLAIN_MESSAGE];
          }
          async fetchNew() {
            return [GMAIL_PLAIN_MESSAGE];
          }
        },
        normalizer: GmailNormalizer,
      },
    },
  });
  pipeline.indexWriter = { async deleteStoredDocument() {} };

  const response = await pipeline.runIngestion("gmail", true, OWNER_USER_ID);
  assert.deepEqual(deleted, ["gmail_gone"]);
  assert.equal(response.deleted, 1);
  assert.equal(response.failed, 0);
});

test("home source pills narrow search and a simple pdf still yields text", () => {
  assert.equal(chatSourceFilter(["gmail", "calendar", "notes", "drive"]), null);
  assert.equal(chatSourceFilter(["gmail", "notes"]), "gmail,notes");
  assert.equal(chatSourceFilter([]), null);
  assert.equal(extractPdfText(Buffer.from("BT (Hello world) Tj ET")), "Hello world");
  assert.equal(wantsDailyDigest({}), true);
  assert.equal(wantsDailyDigest({ dailySummary: false }), false);
  assert.equal(wantsWeeklyReview({}), false);
  assert.equal(wantsWeeklyReview({ weeklyReview: true }), true);
  assert.equal(wantsSyncAlert({}), true);
  assert.equal(wantsSyncAlert({ syncAlerts: false }), false);
});
