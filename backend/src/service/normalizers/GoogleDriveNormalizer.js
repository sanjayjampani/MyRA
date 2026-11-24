export class GoogleDriveNormalizer {
  normalize(file, userId) {
    if (!file?.id || !file.name) return null;
    const content = [file.name, file.description, file.text].filter(Boolean).join("\n\n");
    return {
      documentId: `drive_${file.id}`,
      userId,
      source: "drive",
      type: "file",
      content,
      title: file.name,
      timestamp: file.modifiedTime ? new Date(file.modifiedTime) : new Date(),
      author: null,
      metadata: {
        drive: {
          id: file.id,
          mimeType: file.mimeType || null,
        },
      },
    };
  }
}
