export const MIN_PASSWORD = 10;

/** 0..4 rough strength score with a translation key for the hint. */
export function passwordStrength(pw = "") {
  if (!pw) return { score: 0, key: "password.strength.empty" };
  let score = 0;
  if (pw.length >= MIN_PASSWORD) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length < MIN_PASSWORD) score = Math.min(score, 1);
  const key = ["password.strength.weak", "password.strength.weak", "password.strength.fair", "password.strength.good", "password.strength.strong"][score];
  return { score, key };
}
