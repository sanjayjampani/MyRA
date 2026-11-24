import { logger } from "../../utils/logger.js";
export class GmailNormalizer {
  /**
   * Normalize batch of Gmail messages
   */
  normalizeBatch(rawMessages, userId) {
    return rawMessages
      .map((msg) => this.normalize(msg, userId))
      .filter((doc) => doc !== null);
  }

  /**
   * Normalize single Gmail message to unified document format
   */
  normalize(rawMessage, userId) {
    try {
      const headers = this.extractHeaders(rawMessage.payload.headers);
      const attachments = this.attachmentLines(rawMessage.payload?.parts);
      const body = this.extractContent(rawMessage.payload);
      const content = [body, ...attachments].filter((part) => part && part.trim()).join("\n\n");

      // Skip emails with no content
      if (!content || content.trim().length === 0) {
        logger.warn(`Empty content for message ${rawMessage.id}, skipping`);
        return null;
      }

      return {
        documentId: `gmail_${rawMessage.id}`,
        userId: userId,
        source: "gmail",
        type: "email",
        content: this.cleanContent(content),
        contentLength: content.length,
        title: headers.subject || "(No Subject)",
        timestamp: new Date(parseInt(rawMessage.internalDate)),
        author: headers.from,
        metadata: {
          gmail: {
            messageId: rawMessage.id,
            threadId: rawMessage.threadId,
            labelIds: rawMessage.labelIds || [],
            snippet: rawMessage.snippet,
            from: headers.from,
            to: headers.to,
            subject: headers.subject,
            date: headers.date,
            ...(attachments.length
              ? { attachments: attachments.map((line) => line.split("\n")[0].replace(/^Attachment:\s*/, "")) }
              : {}),
          },
        },
        indexed: false,
        embeddingId: null,
        syncAttempts: 0,
        lastSyncError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    } catch (error) {
      logger.error(
        `Failed to normalize message ${rawMessage.id}: ${error.message}`
      );
      return null;
    }
  }

  /**
   * Extract email headers
   */
  extractHeaders(headers) {
    const extracted = {
      from: null,
      to: null,
      subject: null,
      date: null,
    };

    headers.forEach((header) => {
      const name = header.name.toLowerCase();
      if (name === "from") extracted.from = header.value;
      if (name === "to") extracted.to = header.value;
      if (name === "subject") extracted.subject = header.value;
      if (name === "date") extracted.date = header.value;
    });

    return extracted;
  }

  /**
   * Extract email body content
   */
  extractContent(payload) {
    // Plain text body
    if (payload.mimeType === "text/plain" && payload.body.data) {
      return this.decodeBase64(payload.body.data);
    }

    // HTML body
    if (payload.mimeType === "text/html" && payload.body.data) {
      const html = this.decodeBase64(payload.body.data);
      return this.stripHtml(html);
    }

    // Multipart email
    if (payload.parts) {
      return this.extractContentFromParts(payload.parts);
    }

    return "";
  }

  /**
   * Extract content from multipart email
   */
  attachmentLines(parts, lines = []) {
    for (const part of parts || []) {
      if (part.filename) {
        const text = part.body?.text
          || (part.mimeType?.startsWith("text/") && part.body?.data
            ? this.decodeBase64(part.body.data).slice(0, 8000)
            : "");
        lines.push(text ? `Attachment: ${part.filename}\n${text}` : `Attachment: ${part.filename}`);
      }
      if (part.parts) this.attachmentLines(part.parts, lines);
    }
    return lines;
  }

  extractContentFromParts(parts) {
    let plainText = "";
    let htmlText = "";

    parts.forEach((part) => {
      if (part.filename) return;
      if (part.mimeType === "text/plain" && part.body.data) {
        plainText += this.decodeBase64(part.body.data);
      } else if (part.mimeType === "text/html" && part.body.data) {
        htmlText += this.decodeBase64(part.body.data);
      } else if (part.parts) {
        // Nested parts (recursive)
        const nestedContent = this.extractContentFromParts(part.parts);
        plainText += nestedContent;
      }
    });

    // Prefer plain text over HTML
    if (plainText) {
      return plainText;
    } else if (htmlText) {
      return this.stripHtml(htmlText);
    }

    return "";
  }

  /**
   * Decode base64 email content
   */
  decodeBase64(data) {
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64").toString("utf-8");
  }

  /**
   * Strip HTML tags and convert to plain text
   */
  stripHtml(html) {
    let text = html.replace(
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      ""
    );
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
    text = text.replace(/<[^>]+>/g, " ");
    text = text.replace(/&nbsp;/g, " ");
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/\s+/g, " ").trim();
    return text;
  }

  /**
   * Clean and truncate content
   */
  cleanContent(content) {
    let cleaned = content.replace(/\n{3,}/g, "\n\n");
    const lines = cleaned.split("\n");
    const signatureAt = lines.findIndex((line) => line === "-- " || line === "--");
    if (signatureAt >= 0) cleaned = lines.slice(0, signatureAt).join("\n");

    // Truncate very long emails
    if (cleaned.length > 32000) {
      cleaned = cleaned.substring(0, 32000) + "... [truncated]";
    }

    return cleaned.trim();
  }
}
