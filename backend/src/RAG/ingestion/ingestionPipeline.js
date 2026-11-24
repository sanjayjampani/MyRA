import GmailDataSource from '../../service/sources/GmailDataSource.js';
import GoogleCalendarDataSource from '../../service/sources/GoogleCalendarDataSource.js';
import GoogleDriveDataSource from '../../service/sources/GoogleDriveDataSource.js';
import { GmailNormalizer } from '../../service/normalizers/GmailNormalizer.js';
import { GoogleCalendarNormalizer } from '../../service/normalizers/GoogleCalendarNormalizer.js';
import { GoogleDriveNormalizer } from '../../service/normalizers/GoogleDriveNormalizer.js';
import { logger } from '../../utils/logger.js';
import { documentRepository } from '../../database/index.js';
import { SyncLogRepository } from '../../database/syncLogsRepository.js';
import RetrievalIndexWriter from './retrievalIndexWriter.js';

const SOURCES = {
    gmail: {
        source: GmailDataSource,
        normalizer: GmailNormalizer
    },
    calendar: {
        source: GoogleCalendarDataSource,
        normalizer: GoogleCalendarNormalizer
    },
    drive: {
        source: GoogleDriveDataSource,
        normalizer: GoogleDriveNormalizer
    }
}

const SYNC_LOG_SOURCE_BY_INGESTION_SOURCE = {
    gmail: 'gmail',
    calendar: 'google_calendar',
    drive: 'google_drive'
};

function canonicalValue(value) {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalValue(value[key])])
        );
    }
    return value === undefined ? undefined : value;
}

function documentsMatch(existing, normalized) {
    const existingDocument = {
        source: existing.source,
        type: existing.type,
        content: existing.content,
        title: existing.title,
        timestamp: existing.timestamp,
        author: existing.author,
        metadata: existing.metadata,
    };
    const normalizedDocument = {
        source: normalized.source,
        type: normalized.type,
        content: normalized.content,
        title: normalized.title,
        timestamp: normalized.timestamp,
        author: normalized.author,
        metadata: normalized.metadata,
    };

    return JSON.stringify(canonicalValue(existingDocument)) ===
        JSON.stringify(canonicalValue(normalizedDocument));
}

export default class IngestionPipeline {
    /**
     * Collaborators are injectable so the FND-06 sync-boundary baseline can run
     * the fetch → normalize → persist accounting without Google or PostgreSQL.
     * The defaults are exactly what production has always used.
     */
    constructor({
        syncRepo = new SyncLogRepository(),
        documentRepo = documentRepository,
        sources = SOURCES,
    } = {}) {
        this.syncRepo = syncRepo;
        this.documentRepo = documentRepo;
        this.sources = sources;
    }

    async runIngestion(sourceName, isFullSync, userId) {
        if (!userId) {
            throw new Error('User ID is required for ingestion');
        }

        if (!sourceName || !this.sources[sourceName]) {
            throw new Error(`Invalid source: ${sourceName}. Valid sources are ${Object.keys(this.sources).join(', ')}`);
        }

        const { source: SourceClass, normalizer: NormalizerClass } = this.sources[sourceName];
        const source = new SourceClass(userId);
        const normalizer = new NormalizerClass();
        const response = {};
        let data;
        if (isFullSync) {
            data = await source.fetchAll();
            response.fetched = data.length;
        } else {
            const syncLogSource = SYNC_LOG_SOURCE_BY_INGESTION_SOURCE[sourceName] || sourceName;
            const lastSyncLog = await this.syncRepo.getLastSuccessfulSync(syncLogSource, userId);
            // No successful watermark yet: a 7-day window would permanently hide older mail.
            if (!lastSyncLog?.sync_completed_at) {
                data = await source.fetchAll();
            } else {
                data = await source.fetchNew(lastSyncLog.sync_completed_at);
            }
            response.fetched = data.length;
        }

        logger.info(`Fetched ${data.length} messages from ${sourceName}`);
        response.inserted = 0;
        response.updated = 0;
        response.skipped = 0;
        response.deleted = 0;
        response.failed = 0;

        for (const item of data) {
            try {
                if (item?.deleted && item.id) {
                    await this.forgetDocument(`${sourceName}_${item.id}`, userId, response);
                    continue;
                }

                const doc = normalizer.normalize(item, userId);

                if (doc?.deleted && doc.documentId) {
                    await this.forgetDocument(doc.documentId, userId, response);
                    continue;
                }

                // Normalizer returns null for items it chooses to skip (e.g. empty content)
                if (!doc) {
                    response.skipped++;
                    continue;
                }

                const isExisting = await this.documentRepo.findByDocumentId(doc.documentId, userId);
                if (isExisting) {
                    if (documentsMatch(isExisting, doc)) {
                        response.skipped++;
                    } else {
                        await this.documentRepo.updateForReindex(
                            doc.documentId,
                            userId,
                            doc
                        );
                        response.updated++;
                    }
                    continue;
                }

                // Map camelCase normalizer output to snake_case DB columns
                await this.documentRepo.create({
                    user_id: userId,
                    document_id: doc.documentId,
                    source: doc.source,
                    type: doc.type,
                    content: doc.content,
                    title: doc.title,
                    timestamp: doc.timestamp,
                    author: doc.author,
                    metadata: doc.metadata,
                });
                response.inserted++;
            } catch (error) {
                logger.error(`Failed to process item ${item.id}:`, error);
                response.failed++;
            }
        }

        if (source.reconcileMissing && response.failed === 0) {
            try {
                await this.dropMissing(sourceName, data, userId, response);
            } catch (error) {
                logger.error(`Failed to drop documents missing from ${sourceName}: ${error.message}`);
                response.failed++;
            }
        }

        if (response.failed === 0 && typeof source.commitCursor === "function") {
            await source.commitCursor();
        }

        return response;
    }

    async dropMissing(sourceName, data, userId, response) {
        if (typeof this.documentRepo.listDocumentIds !== "function") return;

        const present = new Set(
            data
                .filter((item) => item?.id && !item.deleted)
                .map((item) => `${sourceName}_${item.id}`),
        );
        const stored = await this.documentRepo.listDocumentIds(userId, sourceName);
        for (const documentId of stored) {
            if (!present.has(documentId)) {
                await this.forgetDocument(documentId, userId, response);
            }
        }
    }

    async forgetDocument(documentId, userId, response) {
        const existing = await this.documentRepo.findByDocumentId(documentId, userId);
        if (!existing) {
            response.skipped++;
            return;
        }

        const writer = this.indexWriter || new RetrievalIndexWriter();
        await writer.deleteStoredDocument(existing);
        await this.documentRepo.deleteByDocumentId(documentId, userId);
        response.deleted++;
    }
}
