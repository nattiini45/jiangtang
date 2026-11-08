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
  "account.twoFactor.heading": "Two-factor authentication",
  "account.twoFactor.intro":
    "When you sign in, Jiangtang also asks for a code from an authenticator app.",
  "account.twoFactor.statusOn": "On.",
  "account.twoFactor.statusOff": "Not set up.",
  "account.twoFactor.required":
    "Two-factor authentication is required for admins. Set it up to continue.",
  "account.twoFactor.password": "Password",
  "account.twoFactor.start": "Set up",
  "account.twoFactor.scan":
    "Scan the QR code with your authenticator app, or enter the setup key by hand.",
  "account.twoFactor.qrLabel": "QR code for your authenticator app",
  "account.twoFactor.secret": "Setup key",
  "account.twoFactor.backupCodes": "Backup codes",
  "account.twoFactor.backupHint":
    "Each code works once if you can't use your app. Keep them somewhere safe; they are shown only now.",
  "account.twoFactor.code": "Code from the app",
  "account.twoFactor.confirm": "Confirm and turn on",
  "account.twoFactor.enabled":
    "Two-factor authentication is on. Keep your backup codes somewhere safe.",
  "account.twoFactor.manageIntro": "Enter your password to turn it off or to get new backup codes.",
  "account.twoFactor.disable": "Turn off",
  "account.twoFactor.disabled": "Two-factor authentication is off.",
  "account.twoFactor.regenerate": "Create new backup codes",
  "account.twoFactor.regenerated": "New backup codes created. The old ones no longer work.",
  "account.twoFactor.err.codeRequired": "Enter the code.",
  "account.twoFactor.err.codeInvalid": "That code is not valid.",
  "account.twoFactor.err.alreadyEnabled": "Two-factor authentication is already on.",
  "account.twoFactor.err.enrolmentExpired": "The setup has expired. Please start again.",
} satisfies Record<keyof typeof accountDe, string>;
