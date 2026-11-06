import type { accountDe } from "../de/account";

export const accountEn = {
  "account.meta": "My account · Jiangtang",
  "account.title": "My account",
  "account.subtitle": "Your details and your password.",
  "account.name": "Name",
  "account.email": "Email",
  "account.initials": "Initials",
  "account.role": "Role",
  "account.menu": "My account",
  "account.password.heading": "Change password",
  "account.password.intro":
    "You stay signed in on this browser; every other session is signed out.",
  "account.password.current": "Current password",
  "account.password.new": "New password",
  "account.password.confirm": "Confirm new password",
  "account.password.submit": "Change password",
  "account.password.changed": "Password changed. Your other sessions were signed out.",
  "account.password.err.currentRequired": "Enter your current password.",
  "account.password.err.currentWrong": "The current password is incorrect.",
} satisfies Record<keyof typeof accountDe, string>;
