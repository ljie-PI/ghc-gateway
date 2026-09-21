import { describe, expect, it } from "vitest";
import { AccountRevisionObserver } from "../../web/src/account_revisions.js";
import type { AdminAccounts } from "../../src/admin/api.js";

const initial: AdminAccounts = {
  defaultRevision: 1,
  defaultAccountId: "github:1",
  items: [{
    accountId: "github:1",
    host: "github.com",
    numericUserId: "1",
    login: "octo",
    displayName: "Octo Admin",
    state: "active",
    revision: 1,
    authenticatedAt: "2026-09-03T12:00:00.000Z",
    preferredModel: null,
  }],
};

describe("AccountRevisionObserver", () => {
  it("does not have a baseline until the first account snapshot is observed", () => {
    const observer = new AccountRevisionObserver();
    expect(observer.hasBaseline()).toBe(false);
    observer.observe(initial);
    expect(observer.hasBaseline()).toBe(true);
    observer.reset();
    expect(observer.hasBaseline()).toBe(false);
  });

  it("retains account revisions across view lifetimes and reports each real revision once", () => {
    const observer = new AccountRevisionObserver();
    expect(observer.observe(initial)).toBe(false);
    expect(observer.observe(structuredClone(initial))).toBe(false);

    const credentialChanged = {
      ...initial,
      items: initial.items.map((account) => ({ ...account, revision: 2 })),
    };
    expect(observer.observe(credentialChanged)).toBe(true);
    expect(observer.observe(structuredClone(credentialChanged))).toBe(false);

    const defaultChanged = { ...credentialChanged, defaultRevision: 2, defaultAccountId: null };
    expect(observer.observe(defaultChanged)).toBe(true);
    expect(observer.observe(structuredClone(defaultChanged))).toBe(false);

    const removed = {
      ...defaultChanged,
      defaultRevision: 3,
      items: defaultChanged.items.map((account) => ({ ...account, state: "removed" as const, revision: 3 })),
    };
    expect(observer.observe(removed)).toBe(true);
    expect(observer.observe(structuredClone(removed))).toBe(false);
  });

  it("forgets the previous account baseline when reset", () => {
    const observer = new AccountRevisionObserver();
    observer.observe(initial);
    observer.reset();
    expect(observer.observe({ ...initial, defaultRevision: 9 })).toBe(false);
  });
});
