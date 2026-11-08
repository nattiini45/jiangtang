import type { authDe } from "../de/auth";

export const authEn = {
  "auth.login.title": "Sign in · Jiangtang",
  "auth.login.subtitle": "Sign in to your AV workspace.",
  "auth.login.tagline":
    "Rooms, equipment, events, tickets, tasks and notes — one workspace for your AV team.",
  "auth.login.about": "What is Jiangtang?",
  "auth.login.deactivated": "This account has been deactivated.",
  "auth.login.invalidCredentials": "Invalid email or password.",
  "auth.login.throttled": "Too many failed sign-in attempts. Try again in {minutes} min.",
  "auth.login.email": "Email",
  "auth.login.password": "Password",
  "auth.login.submit": "Sign in",
  "auth.login.submitting": "Signing in…",
  "auth.login.passwordReset": "Password changed. Sign in with your new password.",

  "auth.invite.title": "Accept invitation · Jiangtang",
  "auth.invite.heading": "Accept invitation",
  "auth.invite.intro": "Welcome to Jiangtang. Set a password to activate your account.",
  "auth.invite.notFound": "This invitation was not found or has expired.",
  "auth.invite.password": "Password",
  "auth.invite.confirm": "Confirm password",
  "auth.invite.submit": "Activate account",

  "auth.reset.title": "Reset password · Jiangtang",
  "auth.reset.heading": "New password",
  "auth.reset.intro":
    "Choose a new password for {email}. You are then signed out everywhere and sign in again.",
  "auth.reset.password": "New password",
  "auth.reset.confirm": "Confirm password",
  "auth.reset.submit": "Save password",
  "auth.login.twoFactorExpired": "The verification expired. Please sign in again.",
  "auth.twoFactor.title": "Verify sign-in · Jiangtang",
  "auth.twoFactor.heading": "Verify sign-in",
  "auth.twoFactor.intro": "Enter the 6-digit code from your authenticator app.",
  "auth.twoFactor.introBackup": "Enter one of your backup codes. Each code works only once.",
  "auth.twoFactor.code": "Code",
  "auth.twoFactor.backupCode": "Backup code",
  "auth.twoFactor.submit": "Verify",
  "auth.twoFactor.submitting": "Verifying…",
  "auth.twoFactor.useBackup": "Use a backup code",
  "auth.twoFactor.useApp": "Use your authenticator app",
  "auth.twoFactor.invalidCode": "That code is not valid.",
  "auth.twoFactor.locked":
    "Too many failed attempts. Verification is locked for a while; try again later.",
  "auth.twoFactor.back": "Back to sign-in",
} satisfies Record<keyof typeof authDe, string>;
