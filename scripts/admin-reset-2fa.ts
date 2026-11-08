/**
 * Operator recovery: turn off two-factor authentication for an account, for
 * when its owner lost the authenticator and the backup codes and nobody who
 * could reset it from /admin/users can sign in.
 *
 *   pnpm admin:reset-2fa <email>
 *
 * Runs inside the app container (or a checkout with DATABASE_URL set). The
 * secret and backup codes are deleted in one audited transaction; the password
 * alone signs in afterwards, and the person can enrol again on /account.
 */

// Load .env before the database module reads the environment, as server.ts does;
// variables that are already set win.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const email = process.argv[2]?.trim();
if (!email || process.argv.length > 3) {
  console.error("Usage: pnpm admin:reset-2fa <email>");
  process.exit(2);
}

const { resetTwoFactorForEmail } = await import("../app/domains/auth/two-factor.server");
const { NotFoundError, ValidationError } = await import("../app/lib/errors.server");
const { db } = await import("../app/lib/db.server");

let exitCode = 0;
try {
  const accountEmail = await resetTwoFactorForEmail(email, {
    name: "Operator (admin:reset-2fa)",
  });
  console.log(`Two-factor authentication is off for ${accountEmail}; the password alone signs in.`);
} catch (error) {
  exitCode = 1;
  if (error instanceof NotFoundError) {
    console.error(`No active account with the email ${email}.`);
  } else if (error instanceof ValidationError) {
    console.error(`${email} has no two-factor authentication set up; nothing changed.`);
  } else {
    console.error("Could not reset two-factor authentication:", (error as Error).message);
  }
} finally {
  await db.$disconnect();
}
process.exit(exitCode);

// A module, so the top-level awaits above are allowed.
export {};
