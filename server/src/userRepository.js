// Accounts, sessions and e-mail tokens. Times are ISO 8601 strings (UTC), so
// they compare correctly as text in SQL.

export function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

export function createUserRepository(db) {
  const q = {
    insertUser: db.prepare(`
      INSERT INTO users (email, display_name, password_hash, privacy_accepted_at, created_at)
      VALUES (@email, @displayName, @passwordHash, @now, @now)`),
    byEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    byId: db.prepare("SELECT * FROM users WHERE id = ?"),
    markVerified: db.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?"),
    setRole: db.prepare("UPDATE users SET role = ? WHERE id = ?"),
    setDisplayName: db.prepare("UPDATE users SET display_name = ? WHERE id = ?"),
    setPassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),

    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
    sessionUser: db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteSessionsOfUser: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    sessionsOfUser: db.prepare("SELECT expires_at FROM sessions WHERE user_id = ? ORDER BY expires_at"),

    insertToken: db.prepare("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)"),
    tokenRow: db.prepare("SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?"),
    deleteTokensOfUser: db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?"),
  };

  return {
    createUser: ({ email, displayName, passwordHash, now }) =>
      Number(q.insertUser.run({ email, displayName, passwordHash, now }).lastInsertRowid),
    /** Raw row (with password_hash): never send it to the client. */
    findByEmail: (email) => q.byEmail.get(email) ?? null,
    findById: (id) => q.byId.get(id) ?? null,
    markVerified: (id, now) => q.markVerified.run(now, id),
    setRole: (id, role) => q.setRole.run(role, id),
    setDisplayName: (id, displayName) => q.setDisplayName.run(displayName, id),
    setPassword: (id, passwordHash) => q.setPassword.run(passwordHash, id),
    /** Sessions, e-mail tokens and ratings go with it (ON DELETE CASCADE). */
    deleteUser: (id) => q.deleteUser.run(id).changes > 0,

    createSession: (tokenHash, userId, expiresAt) => q.insertSession.run(tokenHash, userId, expiresAt),
    findSessionUser: (tokenHash, now) => q.sessionUser.get(tokenHash, now) ?? null,
    deleteSession: (tokenHash) => q.deleteSession.run(tokenHash),
    deleteSessionsOfUser: (userId) => q.deleteSessionsOfUser.run(userId),
    listSessions: (userId) => q.sessionsOfUser.all(userId).map((row) => ({ expiresAt: row.expires_at })),

    createEmailToken: (tokenHash, userId, purpose, expiresAt) => q.insertToken.run(tokenHash, userId, purpose, expiresAt),
    deleteEmailTokens: (userId, purpose) => q.deleteTokensOfUser.run(userId, purpose),
    /** Returns the token's user id and deletes every token of that purpose for the user (single use). */
    consumeEmailToken: db.transaction((tokenHash, purpose, now) => {
      const row = q.tokenRow.get(tokenHash, purpose, now);
      if (!row) return null;
      q.deleteTokensOfUser.run(row.user_id, purpose);
      return row.user_id;
    }),
  };
}
