import { getPool } from "../config/dbConfig.js";

/**
 * One refresh at a time for a stored OAuth credential.
 * Google replaces the refresh token, so two overlapping refreshes
 * leave the loser holding a token the provider has already invalidated.
 */
export async function withCredentialLock(userId, source, work) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `myra:${userId}:${source}`,
    ]);
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
