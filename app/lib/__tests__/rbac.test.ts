import { describe, expect, it } from "vitest";
import { can, roleRequiredFor } from "~/lib/rbac.server";
import type { AuthUser } from "~/lib/auth.server";

function user(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u1",
    email: "x@y.z",
    name: "X",
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: "MEMBER",
    initials: null,
    isActive: true,
    ...over,
  } as AuthUser;
}

describe("RBAC permission matrix", () => {
  it("admins can do everything", () => {
    const admin = user({ role: "ADMIN" });
    expect(can(admin, "user.invite")).toBe(true);
    expect(can(admin, "user.manage")).toBe(true);
    expect(can(admin, "room.edit")).toBe(true);
    expect(can(admin, "event.edit")).toBe(true);
  });

  it("members can do day-to-day work but not manage accounts", () => {
    const member = user({ role: "MEMBER" });
    expect(can(member, "user.invite")).toBe(false);
    expect(can(member, "user.manage")).toBe(false);
    expect(can(member, "room.edit")).toBe(true);
    expect(can(member, "ticket.edit")).toBe(true);
    expect(can(member, "equipment.edit")).toBe(true);
    expect(can(member, "event.edit")).toBe(true);
  });

  it("deactivated users are denied regardless of role", () => {
    const inactive = user({ role: "ADMIN", isActive: false });
    expect(can(inactive, "room.edit")).toBe(false);
    expect(can(inactive, "user.manage")).toBe(false);
  });

  it("roleRequiredFor reflects the admin-only split", () => {
    expect(roleRequiredFor("user.invite")).toBe("ADMIN");
    expect(roleRequiredFor("room.edit")).toBe("MEMBER");
  });
});
