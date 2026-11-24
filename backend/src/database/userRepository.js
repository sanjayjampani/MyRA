// src/database/userRepository.js
import { getPool, pool } from "../config/dbConfig.js";

export class UserRepository {
  /**
   * Find user by Google ID or email
   * @param {string} googleId
   * @param {string} email
   * @returns {Promise<Object|null>}
   */
  async findByGoogleIdOrEmail(googleId, email) {
    const query = `
      SELECT * FROM users
      WHERE google_id = $1 OR email = $2`;

    const values = [googleId, email];
    const { rows } = await pool.query(query, values);

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Find user by ID
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async findById(id) {
    const query = `
      SELECT
        id,
        google_id,
        email,
        name,
        user_name,
        picture,
        email_verified,
        locale,
        preferences,
        status,
        last_login_at,
        login_count,
        created_at,
        updated_at
      FROM users
      WHERE id = $1`;

    const values = [id];
    const { rows } = await pool.query(query, values);

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Find user by email
   * @param {string} email
   * @returns {Promise<Object|null>}
   */
  async findByEmail(email) {
    const query = `
      SELECT * FROM users
      WHERE email = $1`;

    const values = [email];
    const { rows } = await pool.query(query, values);

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Find user by Google ID
   * @param {string} googleId
   * @returns {Promise<Object|null>}
   */
  async findByGoogleId(googleId) {
    const query = `
      SELECT * FROM users
      WHERE google_id = $1`;

    const values = [googleId];
    const { rows } = await pool.query(query, values);

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Create a new user
   * @param {Object} userData
   * @returns {Promise<Object>}
   */
  async create(userData) {
    const query = `
      INSERT INTO users (
        google_id,
        email,
        name,
        user_name,
        picture,
        email_verified,
        locale,
        preferences,
        status,
        last_login_at,
        login_count,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), 1, NOW(), NOW())
      RETURNING *`;

    const values = [
      userData.googleId,
      userData.email,
      userData.name,
      userData.name,           // user_name defaults to google name on first sign-up
      userData.picture,
      userData.emailVerified,
      userData.locale || "en",
      JSON.stringify(userData.preferences || {
        theme: "light",
        syncFrequency: "6h",
        enabledSources: [],
      }),
      userData.status || "active",
    ];

    const { rows } = await pool.query(query, values);

    if (rows.length === 0) {
      throw new Error("Failed to create user");
    }

    return rows[0];
  }

  /**
   * Update user on login
   * @param {string} id
   * @param {Object} userData
   * @returns {Promise<Object>}
   */
  async updateOnLogin(id, userData) {
    const query = `
      UPDATE users
      SET
        google_id = $1,
        name = $2,
        picture = $3,
        email_verified = $4,
        locale = $5,
        last_login_at = NOW(),
        login_count = login_count + 1,
        updated_at = NOW()
      WHERE id = $6
      RETURNING *`;

    const values = [
      userData.googleId,
      userData.name,
      userData.picture,
      userData.emailVerified,
      userData.locale,
      id,
    ];

    const { rows } = await pool.query(query, values);

    if (rows.length === 0) {
      throw new Error(`User with id ${id} not found`);
    }

    return rows[0];
  }

  /**
   * Update user preferences
   * @param {string} id
   * @param {Object} preferences
   * @returns {Promise<Object>}
   */
  async updatePreferences(id, preferences) {
    const query = `
      UPDATE users
      SET
        preferences = $1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *`;

    const values = [JSON.stringify(preferences), id];
    const { rows } = await pool.query(query, values);

    if (rows.length === 0) {
      throw new Error(`User with id ${id} not found`);
    }

    return rows[0];
  }

  /**
   * Read and replace preferences while holding a row lock, so two saves
   * cannot drop each other's keys.
   */
  async modifyPreferences(id, mutate) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT preferences FROM users WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (current.rows.length === 0) {
        throw new Error(`User with id ${id} not found`);
      }
      const stored = current.rows[0].preferences;
      const parsed = typeof stored === "string" ? JSON.parse(stored) : (stored || {});
      const next = await mutate(parsed && typeof parsed === "object" ? { ...parsed } : {});
      const updated = await client.query(
        `UPDATE users
         SET preferences = $1::jsonb, updated_at = NOW()
         WHERE id = $2
         RETURNING preferences`,
        [JSON.stringify(next), id],
      );
      await client.query("COMMIT");
      return updated.rows[0].preferences;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listActiveAccounts() {
    const { rows } = await getPool().query(
      `SELECT id, email, preferences
       FROM users
       WHERE status = 'active' AND email IS NOT NULL`,
    );
    return rows;
  }

  /**
   * Update user status
   * @param {string} id
   * @param {string} status
   * @returns {Promise<Object>}
   */
  async updateStatus(id, status) {
    const query = `
      UPDATE users
      SET
        status = $1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *`;

    const values = [status, id];
    const { rows } = await pool.query(query, values);

    if (rows.length === 0) {
      throw new Error(`User with id ${id} not found`);
    }

    return rows[0];
  }

  /**
   * Update user_name (the app-level display name, independent of Google name)
   * @param {string} id
   * @param {string} userName
   * @returns {Promise<Object>}
   */
  async updateUserName(id, userName) {
    const query = `
      UPDATE users
      SET
        user_name = $1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING id, email, name, user_name, picture, preferences, status, updated_at`;

    const values = [userName.trim(), id];
    const { rows } = await pool.query(query, values);

    if (rows.length === 0) {
      throw new Error(`User with id ${id} not found`);
    }

    return rows[0];
  }

  /**
   * Delete user by ID
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    const query = `
      DELETE FROM users
      WHERE id = $1
      RETURNING *`;

    const values = [id];
    const { rows } = await pool.query(query, values);

    return rows.length > 0;
  }

  /**
   * Get all users (admin function)
   * @param {number} limit
   * @param {number} offset
   * @returns {Promise<Array>}
   */
  async findAll(limit = 50, offset = 0) {
    const query = `
      SELECT
        id,
        google_id,
        email,
        name,
        picture,
        status,
        last_login_at,
        login_count,
        created_at,
        updated_at
      FROM users
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`;

    const values = [limit, offset];
    const { rows } = await pool.query(query, values);

    return rows;
  }

  /**
   * Remove the account and the rows that belong to it.
   * A missing table is skipped. Any other failure rolls the whole delete back.
   */
  async deleteOwnedData(userId) {
    const client = await pool.connect();
    const statements = [
      "DELETE FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE user_id = $1)",
      "DELETE FROM documents WHERE user_id = $1",
      "DELETE FROM api_credentials WHERE user_id = $1",
      "DELETE FROM sync_logs WHERE user_id = $1",
      "DELETE FROM llm_usage_logs WHERE user_id = $1",
      "DELETE FROM api_budget_alerts WHERE user_id = $1",
      "DELETE FROM api_budgets WHERE user_id = $1",
      "DELETE FROM action_receipts WHERE user_id = $1",
      "DELETE FROM action_approvals WHERE user_id = $1",
      "DELETE FROM idempotency_records WHERE user_id = $1",
      "DELETE FROM action_proposals WHERE user_id = $1",
      "DELETE FROM evidence_items WHERE user_id = $1",
      "DELETE FROM tool_calls WHERE user_id = $1",
      "DELETE FROM agent_steps WHERE user_id = $1",
      "DELETE FROM audit_events WHERE user_id = $1",
      "DELETE FROM agent_runs WHERE user_id = $1",
      "DELETE FROM connector_installations WHERE user_id = $1",
      "DELETE FROM conversations WHERE user_id = $1",
      "DELETE FROM users WHERE id = $1",
    ];

    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query("SAVEPOINT step");
        try {
          await client.query(statement, [userId]);
          await client.query("RELEASE SAVEPOINT step");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT step");
          if (error.code !== "42P01" && error.code !== "42703") throw error;
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
