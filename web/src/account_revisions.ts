import type { AdminAccounts } from "../../src/admin/api.js";

export class AccountRevisionObserver {
  private signature: string | null = null;

  observe(accounts: AdminAccounts): boolean {
    const signature = JSON.stringify({
      defaultRevision: accounts.defaultRevision,
      defaultAccountId: accounts.defaultAccountId,
      accounts: accounts.items
        .map((account) => [account.accountId, account.revision, account.state])
        .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
    });
    const changed = this.signature !== null && this.signature !== signature;
    this.signature = signature;
    return changed;
  }

  reset(): void {
    this.signature = null;
  }
}
