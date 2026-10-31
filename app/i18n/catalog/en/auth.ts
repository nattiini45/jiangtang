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

  "auth.invite.title": "Accept invitation · Jiangtang",
  "auth.invite.heading": "Accept invitation",
  "auth.invite.intro": "Welcome to Jiangtang. Set a password to activate your account.",
  "auth.invite.notFound": "This invitation was not found or has expired.",
  "auth.invite.password": "Password",
  "auth.invite.confirm": "Confirm password",
  "auth.invite.submit": "Activate account",
} satisfies Record<keyof typeof authDe, string>;
