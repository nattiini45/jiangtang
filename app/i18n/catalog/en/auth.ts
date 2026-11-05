import type { authDe } from "../de/auth";

export const authEn = {
  "auth.login.title": "Sign in · Jiangtang",
  "auth.login.subtitle": "Sign in to your AV workspace.",
  "auth.login.deactivated": "This account has been deactivated.",
  "auth.login.invalidCredentials": "Invalid email or password.",
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
} satisfies Record<keyof typeof authDe, string>;
