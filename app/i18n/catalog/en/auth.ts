import type { authDe } from "../de/auth";

export const authEn = {
  "auth.login.title": "Sign in · Jiangtang",
  "auth.login.subtitle": "Sign in to your AV workspace.",
  "auth.login.tagline":
    "Rooms, equipment, events, tickets, tasks and notes — one workspace for your AV team.",
  "auth.login.deactivated": "This account has been deactivated.",
  "auth.login.invalidCredentials": "Invalid email or password.",
  "auth.login.throttled": "Too many failed sign-in attempts. Try again in {minutes} min.",
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
