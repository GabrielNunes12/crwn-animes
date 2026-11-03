import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

// scrypt cost: N = 2^17, r = 8, p = 1 (128 MiB, a few hundred ms; OWASP's
// recommendation). The parameters are stored with each hash, so older hashes
// keep working and are upgraded on the next successful login (needsRehash).
// Node runs scrypt on the libuv thread pool (4 threads by default), which caps
// how many hashes, and so how much memory, can be in flight at once.
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const maxmem = (n, r) => 128 * n * r + 16 * 1024 * 1024;

/** -> "scrypt$N$r$p$<salt base64>$<hash base64>" */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(String(password), salt, KEY_LENGTH, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (![n, r, p].every(Number.isInteger) || expected.length === 0) return false;
  const actual = await scryptAsync(String(password), salt, expected.length, { N: n, r, p, maxmem: maxmem(n, r) });
  return timingSafeEqual(actual, expected);
}

/** True when `stored` was made with weaker parameters than today's. */
export function needsRehash(stored) {
  const [scheme, n, r, p] = String(stored ?? "").split("$");
  return scheme !== "scrypt" || Number(n) < N || Number(r) < R || Number(p) < P;
}

let dummyHash;
/** Spends the same time as a real check, so "no such user" is not faster than "wrong password". */
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword("not-a-real-password");
  await verifyPassword(password, dummyHash);
  return false;
}

/** 32 random bytes, base64url. Only its SHA-256 is ever stored. */
export const newToken = () => randomBytes(32).toString("base64url");

export const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");
