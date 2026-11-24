import crypto from "node:crypto";
import { getRedis, isRedisConnected } from "../../config/redisClient.js";
import { logger } from "../../utils/logger.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class OAuthStateError extends Error {
  constructor() {
    super("OAuth transaction is invalid or expired");
    this.name = "OAuthStateError";
  }
}

function hashBinding(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function bindingsMatch(expectedHash, browserBinding) {
  if (typeof browserBinding !== "string" || browserBinding.length === 0) {
    return false;
  }

  const actualHash = hashBinding(browserBinding);
  return actualHash.length === expectedHash.length &&
    crypto.timingSafeEqual(actualHash, expectedHash);
}

/**
 * One-time OAuth state and PKCE verifier store for the current backend
 * process. Pending transactions fail closed after restart; a shared store can
 * replace this class when MyRa is deployed with multiple backend instances.
 */
export class OAuthTransactionStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.transactions = new Map();
    this.loginCodes = new Map();
  }

  async begin() {
    this._deleteExpired();

    const state = crypto.randomBytes(32).toString("base64url");
    const codeVerifier = crypto.randomBytes(64).toString("base64url");
    const browserBinding = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const expiresAt = this.now() + this.ttlMs;

    const record = {
      codeVerifier,
      browserBindingHash: hashBinding(browserBinding),
      expiresAt,
    };
    this.transactions.set(state, record);
    await this._redisSet(`myra:oauth:${state}`, {
      codeVerifier,
      browserBindingHash: record.browserBindingHash.toString("base64"),
      expiresAt,
    }, this.ttlMs);

    return {
      state,
      codeVerifier,
      codeChallenge,
      browserBinding,
      expiresAt,
    };
  }

  async consume(state, browserBinding) {
    if (typeof state !== "string" || state.length === 0) {
      throw new OAuthStateError();
    }

    const remote = await this._redisTake(`myra:oauth:${state}`);
    if (remote) {
      this.transactions.delete(state);
      if (typeof remote.browserBindingHash !== "string") throw new OAuthStateError();
      const hash = Buffer.from(remote.browserBindingHash, "base64");
      if (
        remote.expiresAt <= this.now() ||
        !bindingsMatch(hash, browserBinding)
      ) {
        throw new OAuthStateError();
      }
      return { codeVerifier: remote.codeVerifier };
    }

    const transaction = this.transactions.get(state);
    // Delete before validation so every callback attempt is one-time, even if
    // it supplies a wrong browser binding.
    this.transactions.delete(state);

    if (
      !transaction ||
      transaction.expiresAt <= this.now() ||
      !bindingsMatch(transaction.browserBindingHash, browserBinding)
    ) {
      throw new OAuthStateError();
    }

    return { codeVerifier: transaction.codeVerifier };
  }

  async issueLoginCode(token) {
    const code = crypto.randomBytes(32).toString("base64url");
    const expiresAt = this.now() + 60_000;
    this.loginCodes.set(code, { token, expiresAt });
    await this._redisSet(`myra:login:${code}`, { token, expiresAt }, 60_000);
    return code;
  }

  async consumeLoginCode(code) {
    if (typeof code !== "string" || code.length === 0) return null;

    const remote = await this._redisTake(`myra:login:${code}`);
    const local = this.loginCodes.get(code);
    this.loginCodes.delete(code);
    const record = remote || local;
    if (!record || record.expiresAt <= this.now() || typeof record.token !== "string") {
      return null;
    }
    return record.token;
  }

  async _redisSet(key, value, ttlMs) {
    if (!isRedisConnected()) return;
    try {
      await getRedis().set(key, JSON.stringify(value), { PX: ttlMs });
    } catch (error) {
      logger.warn("OAuth state was not written to Redis", { error: error.message });
    }
  }

  async _redisTake(key) {
    if (!isRedisConnected()) return null;
    try {
      const raw = await getRedis().getDel(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      logger.warn("OAuth state was not read from Redis", { error: error.message });
      return null;
    }
  }

  _deleteExpired() {
    const currentTime = this.now();
    for (const [state, transaction] of this.transactions.entries()) {
      if (transaction.expiresAt <= currentTime) {
        this.transactions.delete(state);
      }
    }
  }
}

export const oauthTransactionStore = new OAuthTransactionStore();
