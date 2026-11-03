// Usage: npm run make-admin -- someone@example.com
// Promotes an existing account to the "admin" role.
import { loadEnvConfig, openConfiguredDatabase } from "../env.js";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: npm run make-admin -- someone@example.com");
  process.exit(1);
}

const db = openConfiguredDatabase(loadEnvConfig());
const { changes } = db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
db.close();

if (changes === 0) {
  console.error("No account uses that e-mail. Register first, then run this again.");
  process.exit(1);
}
console.log("Done: that account is now an admin (log out and in again if it is signed in).");
