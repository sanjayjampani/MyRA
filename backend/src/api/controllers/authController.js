import jwt from "jsonwebtoken";
import { google } from "googleapis";
import { GoogleAuthService } from "../../service/oauth/googleOAuthService.js";
import { oauthTransactionStore } from "../../service/oauth/oauthTransactionStore.js";
import { logger } from "../../utils/logger.js";
import { userRepository, credentialRepository, documentRepository } from "../../database/index.js";
import { getAuthenticatedUserId } from "../middleware/requireAuth.js";
import { cleanDeviceId, deviceNeedsReauth, patchPreferenceKey, readPreferences, rememberDevice, requestDeviceId } from "../../service/sources/syncCursors.js";

const OAUTH_BINDING_COOKIE = "myra_oauth_binding";
const SETTINGS_KEYS = [
  "defaultModel",
  "density",
  "theme",
  "sessionTimeoutHours",
  "reauth",
  "dailySummary",
  "weeklyReview",
  "indexData",
  "telemetry",
  "syncAlerts",
];

function singleQueryValue(value) {
  return typeof value === "string" ? value : null;
}

function readCookie(cookieHeader, name) {
  if (typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function oauthCookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/auth/google",
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

function frontendRedirect(errorCode) {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  return `${frontendUrl}/login?error=${encodeURIComponent(errorCode)}`;
}

export class AuthController {
  constructor({
    oauthService = new GoogleAuthService(),
    oauthTransactions = oauthTransactionStore,
    userRepo = userRepository,
    credentialRepo = credentialRepository,
  } = {}) {
    this.oauthService = oauthService;
    this.oauthTransactions = oauthTransactions;
    this.userRepo = userRepo;
    this.credentialRepo = credentialRepo;
  }

  /**
   * GET /api/auth/google/login
   * Initiate Google OAuth login flow
   */
  async initiateGoogleLogin(req, res, next) {
    try {
      const transaction = await this.oauthTransactions.begin();

      const scopes = [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
      ];

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: scopes,
        state: transaction.state,
        code_challenge: transaction.codeChallenge,
        code_challenge_method: "S256",
        prompt: "consent",
      });

      res.cookie(
        OAUTH_BINDING_COOKIE,
        transaction.browserBinding,
        oauthCookieOptions(Math.max(0, transaction.expiresAt - Date.now())),
      );

      logger.info("Generated Google login URL");

      res.json({
        success: true,
        data: { authUrl },
      });
    } catch (error) {
      logger.error(`Failed to initiate Google login: ${error.message}`);
      next(error);
    }
  }

  /**
   * GET /api/auth/google/callback
   * Handle OAuth callback from Google
   */
  async handleGoogleCallback(req, res, next) {
    try {
      const code = singleQueryValue(req.query.code);
      const error = singleQueryValue(req.query.error);
      const state = singleQueryValue(req.query.state);
      const browserBinding = readCookie(
        req.headers.cookie,
        OAUTH_BINDING_COOKIE,
      );

      let codeVerifier;
      try {
        ({ codeVerifier } = await this.oauthTransactions.consume(
          state,
          browserBinding,
        ));
      } catch {
        logger.warn("Rejected invalid, expired, or replayed OAuth callback state");
        res.clearCookie(OAUTH_BINDING_COOKIE, oauthCookieOptions());
        return res.redirect(frontendRedirect("invalid_oauth_state"));
      }

      res.clearCookie(OAUTH_BINDING_COOKIE, oauthCookieOptions());

      if (error) {
        logger.warn("OAuth authorization was denied by the user");
        return res.redirect(frontendRedirect("access_denied"));
      }

      if (!code) {
        return res.redirect(frontendRedirect("missing_code"));
      }

      logger.info("Processing Google OAuth callback");

      // Exchange code for tokens
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );

      const { tokens } = await oauth2Client.getToken({
        code,
        codeVerifier,
      });
      oauth2Client.setCredentials(tokens);

      // Get user info from Google
      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const userInfoResponse = await oauth2.userinfo.get();
      const googleUserInfo = userInfoResponse.data;

      logger.info("Google user profile retrieved");

      // Create or update user
      const user = await this.createOrUpdateUser(googleUserInfo, tokens);

      const authToken = this.generateAuthToken(user);
      const loginCode = await this.oauthTransactions.issueLoginCode(authToken);

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      res.redirect(`${frontendUrl}/auth/callback?code=${encodeURIComponent(loginCode)}`);
    } catch (error) {
      logger.error(`OAuth callback failed: ${error.message}`);
      res.redirect(frontendRedirect("auth_failed"));
    }
  }

  /**
   * Create or update user in database
   */
  async createOrUpdateUser(googleUserInfo, tokens) {
    // Check if user exists by Google ID or email
    const existingUser = await this.userRepo.findByGoogleIdOrEmail(
      googleUserInfo.id,
      googleUserInfo.email
    );

    let user;

    if (existingUser) {
      // Update existing user
      user = await this.userRepo.updateOnLogin(existingUser.id, {
        googleId: googleUserInfo.id,
        name: googleUserInfo.name,
        picture: googleUserInfo.picture,
        emailVerified: googleUserInfo.verified_email,
        locale: googleUserInfo.locale,
      });
      logger.info("Updated existing user account");
    } else {
      // Create new user
      user = await this.userRepo.create({
        googleId: googleUserInfo.id,
        email: googleUserInfo.email,
        name: googleUserInfo.name,
        picture: googleUserInfo.picture,
        emailVerified: googleUserInfo.verified_email,
        locale: googleUserInfo.locale || "en",
      });
      logger.info("Created new user account");
    }

    // Store OAuth tokens for Gmail
    await this.storeOAuthTokens(user.id, tokens);

    return user;
  }

  /**
   * Store OAuth tokens in credentials table
   */
  async storeOAuthTokens(userId, tokens) {
    const expiryDate = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000);

    const encryptedAccessToken = this.oauthService.encrypt(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token
      ? this.oauthService.encrypt(tokens.refresh_token)
      : null;

    const scopes = tokens.scope ? tokens.scope.split(" ") : [];

    await this.credentialRepo.storeOAuthTokens(userId, "gmail", {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      expiryDate: expiryDate,
      scopes: scopes,
    });

    await this.credentialRepo.storeOAuthTokens(userId, "google_calendar", {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      expiryDate: expiryDate,
      scopes: scopes,
    });

    await this.credentialRepo.storeOAuthTokens(userId, "google_drive", {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      expiryDate: expiryDate,
      scopes: scopes,
    });

    logger.info("Stored Gmail, Calendar, and Drive credentials");
  }

  /**
   * Generate JWT token for authentication
   */
  generateAuthToken(user) {
    const payload = {
      userId: user.id,
    };
    let preferences = user?.preferences;
    if (typeof preferences === "string") {
      try {
        preferences = JSON.parse(preferences);
      } catch {
        preferences = {};
      }
    }
    const hours = Number(preferences?.settings?.sessionTimeoutHours);
    const expiresIn = [1, 8, 24].includes(hours) ? `${hours}h` : "7d";

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      algorithm: "HS256",
      expiresIn,
    });

    return token;
  }

  /**
   * POST /auth/exchange
   * Trade the one-time login code from the OAuth redirect for the access token.
   * The JWT never travels in the URL.
   */
  async exchangeLoginCode(req, res) {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const token = await this.oauthTransactions.consumeLoginCode(code);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Login code is invalid or expired",
      });
    }

    const deviceId = cleanDeviceId(req.body?.deviceId);
    if (deviceId && process.env.JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
        await rememberDevice(decoded.userId, deviceId, this.userRepo);
      } catch (error) {
        logger.warn(`Could not record this device: ${error.message}`);
      }
    }

    return res.json({
      success: true,
      data: { token },
    });
  }

  /**
   * GET /api/auth/me
   * Get current user info
   */
  async getCurrentUser(req, res, next) {
    try {
      const userId = getAuthenticatedUserId(req);
      if (await deviceNeedsReauth(userId, requestDeviceId(req), this.userRepo)) {
        return res.status(401).json({
          success: false,
          error: "This device needs to sign in again.",
        });
      }
      const user = await this.userRepo.findById(userId);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: "User not found",
        });
      }

      // Also get connected sources
      const connectedSources = await this.credentialRepo.getConnectedSources(
        user.id
      );

      res.json({
        success: true,
        data: {
          user: {
            ...user,
            connectedSources,
          },
        },
      });
    } catch (error) {
      logger.error(`Failed to get current user: ${error.message}`);

      if (error.name === "JsonWebTokenError") {
        return res.status(401).json({
          success: false,
          error: "Invalid token",
        });
      }

      next(error);
    }
  }

  /**
   * PATCH /api/auth/user/name
   * Update the app-level display name (user_name) for the authenticated user.
   * Does NOT touch the google `name` field.
   */
  async updateUserName(req, res, next) {
    try {
      const userId = getAuthenticatedUserId(req);

      const { userName } = req.body;
      if (!userName || typeof userName !== "string" || !userName.trim()) {
        return res.status(400).json({ success: false, error: "userName is required" });
      }

      const updatedUser = await this.userRepo.updateUserName(userId, userName);

      logger.info("Updated user display name");

      res.json({
        success: true,
        data: { user: updatedUser },
      });
    } catch (error) {
      logger.error(`Failed to update user name: ${error.message}`);
      if (error.name === "JsonWebTokenError") {
        return res.status(401).json({ success: false, error: "Invalid token" });
      }
      next(error);
    }
  }

  /**
   * POST /api/auth/logout
   * Logout user
   */
  async getSettings(req, res) {
    const userId = getAuthenticatedUserId(req);
    const preferences = await readPreferences(userId, this.userRepo);
    const settings = preferences.settings && typeof preferences.settings === "object"
      ? { ...preferences.settings }
      : {};
    settings.knownDevices = Array.isArray(preferences.knownDevices) ? preferences.knownDevices : [];
    return res.json({ success: true, data: settings });
  }

  async updateSettings(req, res) {
    const userId = getAuthenticatedUserId(req);
    const preferences = await readPreferences(userId, this.userRepo);
    const current = preferences.settings && typeof preferences.settings === "object"
      ? preferences.settings
      : {};
    const patch = {};
    for (const key of SETTINGS_KEYS) {
      if (req.body?.[key] !== undefined) patch[key] = req.body[key];
    }
    const settings = { ...current, ...patch };
    await patchPreferenceKey(userId, "settings", settings, this.userRepo);
    if (settings.reauth === true) {
      await rememberDevice(userId, requestDeviceId(req), this.userRepo);
    }
    if (patch.indexData === true && current.indexData === false) {
      import("../../RAG/ingestion/embeddingPipeline.js")
        .then(({ default: EmbeddingPipeline }) => new EmbeddingPipeline().runEmbedding(userId, { maxBatches: 2 }))
        .catch((error) => logger.warn(`Indexing resume failed: ${error.message}`));
    }
    return res.json({ success: true, data: settings });
  }

  async getProviders(req, res) {
    return res.json({
      success: true,
      data: {
        openai: Boolean(process.env.OPENAI_API_KEY),
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      },
    });
  }

  async reportTelemetry(req, res) {
    const userId = getAuthenticatedUserId(req);
    const preferences = await readPreferences(userId, this.userRepo);
    if (preferences.settings?.telemetry === true) {
      const message = typeof req.body?.message === "string" ? req.body.message.slice(0, 200) : "";
      if (message) logger.info("Client telemetry", { userId, message });
    }
    return res.status(204).end();
  }

  async exportAccount(req, res) {
    const userId = getAuthenticatedUserId(req);
    const [preferences, documents] = await Promise.all([
      readPreferences(userId, this.userRepo),
      documentRepository.listForExport(userId),
    ]);
    return res.json({
      success: true,
      data: {
        settings: preferences.settings || {},
        reminders: preferences.reminders || [],
        documents,
      },
    });
  }

  async deleteAccount(req, res) {
    const userId = getAuthenticatedUserId(req);
    try {
      await this.userRepo.deleteOwnedData(userId);
      return res.json({ success: true });
    } catch (error) {
      logger.error(`Account delete failed: ${error.message}`);
      return res.status(409).json({
        success: false,
        error: "Account could not be deleted because related data is still referenced",
      });
    }
  }

  async logout(req, res, next) {
    try {
      res.json({
        success: true,
        message: "Logged out successfully",
      });
    } catch (error) {
      logger.error(`Logout failed: ${error.message}`);
      next(error);
    }
  }
}
