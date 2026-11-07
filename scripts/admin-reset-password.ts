/**
 * Operator recovery: print a one-time password reset link for an account, for
 * when nobody who could issue one from /admin/users can sign in.
 *
 *   pnpm admin:reset-password <email>
 *
 * Runs inside the app container (or a checkout with DATABASE_URL and
 * BETTER_AUTH_URL set). The link is valid for one day and for one use; opening
 * it lets the person choose a new password and signs out all their sessions.
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
  console.error("Usage: pnpm admin:reset-password <email>");
  process.exit(2);
}

const baseUrl = process.env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "");
if (!baseUrl) {
  console.error("BETTER_AUTH_URL is not set; it is the address people open the link at.");
  process.exit(2);
}

const { createPasswordResetForEmail, passwordResetPath } =
  await import("../app/domains/auth/password-reset.server");
const { NotFoundError } = await import("../app/lib/errors.server");
const { db } = await import("../app/lib/db.server");

let exitCode = 0;
try {
  const { token, email: accountEmail } = await createPasswordResetForEmail(email, {
    name: "Operator (admin:reset-password)",
  });
  console.log(`Password reset link for ${accountEmail} (valid for 1 day, one use):`);
  console.log(`${baseUrl}${passwordResetPath(token)}`);
} catch (error) {
  exitCode = 1;
  if (error instanceof NotFoundError) {
    console.error(`No active account with the email ${email}.`);
  } else {
    console.error("Could not create a reset link:", (error as Error).message);
  }
} finally {
  await db.$disconnect();
}
process.exit(exitCode);

// A module, so the top-level awaits above are allowed.
export {};
