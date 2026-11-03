import { burnPasswordCheck, hashPassword, hashToken, needsRehash, newToken, verifyPassword } from "./crypto.js";
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
// `beforeDeleteUser(userId)` runs in the same transaction as an account deletion
// (app.js uses it to take the user's ratings out of the trending counts).
export function createAuthService({ db, config, mailer, now = () => new Date(), beforeDeleteUser = () => {} }) {
  const users = createUserRepository(db);
  const iso = (offsetMs = 0) => new Date(now().getTime() + offsetMs).toISOString();
  const link = (page, token) => `${config.appUrl}/${page}?token=${encodeURIComponent(token)}`;

  /**
   * Fire-and-forget: requests never wait for SMTP, so an existing account does
   * not answer slower than an unknown e-mail (no timing enumeration), and mail
   * problems never fail a request. Errors are logged by code only: SMTP error
   * messages can contain the recipient address.
   */
  function send(to, kind, data) {
    let message;
    try {
      message = { to, ...renderEmail(kind, data) };
    } catch (error) {
      console.error(`[mail] could not build a "${kind}" e-mail (${error.name})`);
      return;
    }
    Promise.resolve()
      .then(() => mailer.send(message))
      .catch((error) => console.error(`[mail] could not send a "${kind}" e-mail (${error?.code ?? "unknown error"})`));
  }

  /** A new token replaces every older one of the same purpose: only the newest link works. */
  const issueEmailToken = db.transaction((userId, purpose, ttl) => {
    users.deleteEmailTokens(userId, purpose);
    const token = newToken();
    users.createEmailToken(hashToken(token), userId, purpose, iso(ttl));
    return token;
  });

  function sendVerification(row, locale) {
    const token = issueEmailToken(row.id, "verify", VERIFY_TTL_MS);
    send(row.email, "verify", { locale, displayName: row.display_name, url: link("verify-email", token) });
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
      if (existing?.email_verified_at) {
        send(existing.email, "registerAttempt", { locale, displayName: existing.display_name, url: `${config.appUrl}/login` });
        return;
      }
      if (existing) {
        // Still unverified: the newest sign-up wins. Its password replaces the
        // pending one and older verification links stop working, so someone who
        // pre-registered this e-mail cannot get their password verified by the
        // real owner clicking a link.
        if (users.replaceRegistration(existing.id, { displayName, passwordHash, now: iso() })) {
          sendVerification(users.findById(existing.id), locale);
        }
        return;
      }
      let id;
      try {
        id = users.createUser({ email, displayName, passwordHash, now: iso() });
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return; // registered concurrently
        throw error;
      }
      sendVerification(users.findById(id), locale);
    },

    async resendVerification({ email, locale }) {
      const row = users.findByEmail(email);
      if (row && !row.email_verified_at) sendVerification(row, locale);
    },

    /**
     * Returns the verified user row. The password chosen at sign-up must be
     * typed again: whoever clicks the link can only activate their own
     * password, never one set by someone who signed up with this e-mail first.
     * A wrong password leaves the token valid.
     */
    async verifyEmail(token, password) {
      const tokenHash = hashToken(token);
      // Token first: no scrypt work for a bad token.
      const pendingUserId = users.peekEmailToken(tokenHash, "verify", iso());
      if (!pendingUserId) throw invalidToken();
      const pending = users.findById(pendingUserId);
      if (!(await verifyPassword(password, pending.password_hash))) throw invalidCredentials();
      // Consume only now; fails if a newer sign-up replaced the link meanwhile.
      const userId = users.consumeEmailToken(tokenHash, "verify", iso());
      if (userId !== pendingUserId) throw invalidToken();
      const before = users.findById(userId);
      if (before.password_hash !== pending.password_hash) throw invalidToken();
      users.markVerified(userId, iso());
      const row = applyAdminRole(users.findById(userId));
      if (!before.email_verified_at) {
        send(row.email, "welcome", { displayName: row.display_name, url: config.appUrl });
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
      // Hashes made with older (weaker) scrypt parameters are upgraded now that we know the password.
      if (needsRehash(row.password_hash)) users.setPassword(row.id, await hashPassword(password));
      return applyAdminRole(row);
    },

    async forgotPassword({ email, locale }) {
      const row = users.findByEmail(email);
      if (!row) return;
      const token = issueEmailToken(row.id, "reset", RESET_TTL_MS);
      send(row.email, "reset", { locale, displayName: row.display_name, url: link("reset-password", token) });
    },

    /** Sets the new password, verifies the e-mail and signs out every session. Returns the user row. */
    async resetPassword({ token, password, locale }) {
      // Check the token before spending scrypt time on the password (no unauthenticated CPU burn).
      const tokenHash = hashToken(token);
      if (!users.peekEmailToken(tokenHash, "reset", iso())) throw invalidToken();
      const passwordHash = await hashPassword(password);
      const userId = users.consumeEmailToken(tokenHash, "reset", iso()); // single use, even if raced
      if (!userId) throw invalidToken();
      users.setPassword(userId, passwordHash);
      users.markVerified(userId, iso());
      users.deleteEmailTokens(userId, "verify");
      users.deleteSessionsOfUser(userId);
      const row = applyAdminRole(users.findById(userId));
      send(row.email, "passwordChanged", { locale, displayName: row.display_name, url: `${config.appUrl}/forgot-password` });
      return row;
    },

    /** Checks the current password, stores the new one and signs out every session. */
    async changePassword(userId, { currentPassword, newPassword, locale }) {
      const row = users.findById(userId);
      if (!row || !(await verifyPassword(currentPassword, row.password_hash))) throw invalidCredentials();
      const passwordHash = await hashPassword(newPassword);
      db.transaction(() => {
        users.setPassword(userId, passwordHash);
        users.deleteSessionsOfUser(userId);
        // A reset link requested earlier must not undo this change.
        users.deleteEmailTokens(userId, "reset");
        users.deleteEmailTokens(userId, "verify");
      })();
      send(row.email, "passwordChanged", { locale, displayName: row.display_name, url: `${config.appUrl}/forgot-password` });
      return users.findById(userId);
    },

    async deleteAccount(userId, password) {
      const row = users.findById(userId);
      if (!row || !(await verifyPassword(password, row.password_hash))) throw invalidCredentials();
      db.transaction(() => {
        beforeDeleteUser(userId);
        users.deleteUser(userId);
      })();
    },

    updateDisplayName(userId, displayName) {
      users.setDisplayName(userId, displayName);
      return users.findById(userId);
    },

    toUser,
  };
}
