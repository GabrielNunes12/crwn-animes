import { burnPasswordCheck, hashPassword, hashToken, newToken, verifyPassword } from "./crypto.js";
import { HttpError } from "./errors.js";
import { renderEmail } from "./mail.js";
import { createUserRepository, toUser } from "./userRepository.js";

const HOUR = 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * HOUR;
const VERIFY_TTL_MS = 24 * HOUR;
const RESET_TTL_MS = 1 * HOUR;

const invalidToken = () =>
  new HttpError(400, "This link is invalid or has expired. Ask for a new one.", {}, "INVALID_TOKEN");
const invalidCredentials = () =>
  new HttpError(401, "Wrong e-mail or password.", {}, "INVALID_CREDENTIALS");

// Accounts: sign-up with e-mail verification, login, sessions, password
// reset/change and account deletion. Routes stay thin and call these.
export function createAuthService({ db, config, mailer, now = () => new Date() }) {
  const users = createUserRepository(db);
  const iso = (offsetMs = 0) => new Date(now().getTime() + offsetMs).toISOString();
  const link = (page, token) => `${config.appUrl}/${page}?token=${encodeURIComponent(token)}`;

  /** E-mail problems must not break the request (nor reveal anything); log without the address. */
  async function send(to, kind, data) {
    try {
      await mailer.send({ to, ...renderEmail(kind, data) });
    } catch (error) {
      console.error(`[mail] could not send a "${kind}" e-mail: ${error.message}`);
    }
  }

  function issueEmailToken(userId, purpose, ttl) {
    // A new token replaces older ones of the same purpose.
    users.deleteEmailTokens(userId, purpose);
    const token = newToken();
    users.createEmailToken(hashToken(token), userId, purpose, iso(ttl));
    return token;
  }

  async function sendVerification(row, locale) {
    const token = issueEmailToken(row.id, "verify", VERIFY_TTL_MS);
    await send(row.email, "verify", { locale, displayName: row.display_name, url: link("verify-email", token) });
  }

  /** ADMIN_EMAILS promotes on verify/login/reset (never demotes: make-admin may have promoted). */
  function applyAdminRole(row) {
    if (row.role !== "admin" && config.adminEmails.includes(row.email)) {
      users.setRole(row.id, "admin");
      return users.findById(row.id);
    }
    return row;
  }

  function startSession(userId) {
    const token = newToken();
    users.createSession(hashToken(token), userId, iso(SESSION_TTL_MS));
    return token;
  }

  return {
    users,

    /** The user behind a session cookie value, or null. */
    userForSession(token) {
      if (!token) return null;
      return users.findSessionUser(hashToken(token), iso());
    },

    /** Rotates the session: drops `oldToken` (if any) and returns a new token. */
    rotateSession(userId, oldToken) {
      if (oldToken) users.deleteSession(hashToken(oldToken));
      return startSession(userId);
    },

    endSession(token) {
      if (token) users.deleteSession(hashToken(token));
    },

    endAllSessions(userId) {
      users.deleteSessionsOfUser(userId);
    },

    async register({ email, password, displayName, locale }) {
      // Hash first in both branches so an existing e-mail does not answer faster.
      const passwordHash = await hashPassword(password);
      const existing = users.findByEmail(email);
      if (existing) {
        await send(existing.email, "registerAttempt", { locale, displayName: existing.display_name, url: `${config.appUrl}/login` });
        return;
      }
      let id;
      try {
        id = users.createUser({ email, displayName, passwordHash, now: iso() });
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return; // registered concurrently
        throw error;
      }
      await sendVerification(users.findById(id), locale);
    },

    async resendVerification({ email, locale }) {
      const row = users.findByEmail(email);
      if (row && !row.email_verified_at) await sendVerification(row, locale);
    },

    /** Returns the verified user row. */
    async verifyEmail(token) {
      const userId = users.consumeEmailToken(hashToken(token), "verify", iso());
      if (!userId) throw invalidToken();
      const before = users.findById(userId);
      users.markVerified(userId, iso());
      const row = applyAdminRole(users.findById(userId));
      if (!before.email_verified_at) {
        await send(row.email, "welcome", { displayName: row.display_name, url: config.appUrl });
      }
      return row;
    },

    async login({ email, password }) {
      const row = users.findByEmail(email);
      if (!row) {
        await burnPasswordCheck(password);
        throw invalidCredentials();
      }
      if (!(await verifyPassword(password, row.password_hash))) throw invalidCredentials();
      if (!row.email_verified_at) {
        throw new HttpError(403, "Confirm your e-mail before logging in. Check your inbox or ask for a new link.", {}, "EMAIL_NOT_VERIFIED");
      }
      return applyAdminRole(row);
    },

    async forgotPassword({ email, locale }) {
      const row = users.findByEmail(email);
      if (!row) return;
      const token = issueEmailToken(row.id, "reset", RESET_TTL_MS);
      await send(row.email, "reset", { locale, displayName: row.display_name, url: link("reset-password", token) });
    },

    /** Sets the new password, verifies the e-mail and signs out every session. Returns the user row. */
    async resetPassword({ token, password, locale }) {
      const passwordHash = await hashPassword(password);
      const userId = users.consumeEmailToken(hashToken(token), "reset", iso());
      if (!userId) throw invalidToken();
      users.setPassword(userId, passwordHash);
      users.markVerified(userId, iso());
      users.deleteEmailTokens(userId, "verify");
      users.deleteSessionsOfUser(userId);
      const row = applyAdminRole(users.findById(userId));
      await send(row.email, "passwordChanged", { locale, displayName: row.display_name, url: `${config.appUrl}/forgot-password` });
      return row;
    },

    /** Checks the current password, stores the new one and signs out every session. */
    async changePassword(userId, { currentPassword, newPassword, locale }) {
      const row = users.findById(userId);
      if (!row || !(await verifyPassword(currentPassword, row.password_hash))) throw invalidCredentials();
      users.setPassword(userId, await hashPassword(newPassword));
      users.deleteSessionsOfUser(userId);
      await send(row.email, "passwordChanged", { locale, displayName: row.display_name, url: `${config.appUrl}/forgot-password` });
      return users.findById(userId);
    },

    async deleteAccount(userId, password) {
      const row = users.findById(userId);
      if (!row || !(await verifyPassword(password, row.password_hash))) throw invalidCredentials();
      users.deleteUser(userId);
    },

    updateDisplayName(userId, displayName) {
      users.setDisplayName(userId, displayName);
      return users.findById(userId);
    },

    toUser,
  };
}
