import type { authDe } from "../de/auth";

export const authEn = {
  "auth.forgot.link": "Forgot password?",
  "auth.forgot.title": "Reset your password · Jiangtang",
  "auth.forgot.heading": "Reset your password",
  "auth.forgot.intro": "Enter the email address you use to sign in.",
  "auth.forgot.submit": "Send reset link",
  "auth.forgot.sent":
    "If the address is eligible for a password reset, you’ll receive a link by email.",
  "auth.forgot.invalid": "Enter a valid email address.",
  "auth.forgot.back": "Back to sign in",
  "auth.mail.inviteSubject": "Your Jiangtang invitation",
  "auth.mail.inviteText":
    "You’ve been invited to join Jiangtang. Open this link to verify your email address and set your password:\n\n{link}\n\nThe link is valid for seven days.",
  "auth.mail.resetSubject": "Reset your Jiangtang password",
  "auth.mail.resetText":
    "Open this link within one hour to reset your password:\n\n{link}\n\nIf you didn’t request a reset, you can ignore this message.",
  "auth.mail.verifySubject": "Verify your Jiangtang email address",
  "auth.mail.verifyText":
    "Open this link within one hour to verify your email address:\n\n{link}\n\nIf you didn’t request verification, you can ignore this message.",
  "auth.mail.accountUnverified": "Verify this email address to use it for password recovery.",
  "auth.mail.verifyAction": "Send verification email",
  "auth.mail.verifyQueued": "Check your inbox for a verification link.",
  "auth.mail.verifyUnavailable": "Couldn’t queue a verification email. Try again later.",
  "auth.mail.adminSubject": "New Jiangtang administrator",
  "auth.mail.adminText":
    "The account {email} now has administrator access in Jiangtang. If you didn’t expect this, check the account and the audit log.",
  "auth.mail.twoFactorSubject": "Jiangtang two-factor authentication reset",
  "auth.mail.twoFactorText":
    "Two-factor authentication was reset for {email}. If you didn’t expect this, check the account and the audit log.",
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
