import { PreconditionError } from "@rotorsoft/act";
import { describe, expect } from "vitest";
import { Account, Copy, Member } from "./index.js";
import { at, events, rival_before_commit, test } from "./setup.js";

const move = (from: string, to: string, amount: number) => ({
  from,
  to,
  amount,
});

describe("money transfer", () => {
  test("debits and credits in one commit across three streams", async ({
    app,
  }) => {
    await app.do("Deposit", at("acc-a"), { amount: 80 });
    await app.do("TransferMoney", at("t-1"), move("acc-a", "acc-b", 50));
    expect((await app.load(Account, "acc-a")).state.balance).toBe(30);
    expect((await app.load(Account, "acc-b")).state.balance).toBe(50);
    expect(await events("t-1")).toEqual(["Transferred"]);
  });

  test("without enough funds, neither account moves", async ({ app }) => {
    await app.do("Deposit", at("acc-a"), { amount: 10 });
    await expect(
      app.do("TransferMoney", at("t-1"), move("acc-a", "acc-b", 50))
    ).rejects.toThrow("enough funds");
    expect(await events("acc-a")).toEqual(["Deposited"]);
    expect(await events("acc-b")).toEqual([]);
  });

  test("to the same account is a refusal, not a crash", async ({ app }) => {
    await app.do("Deposit", at("acc-a"), { amount: 80 });
    await expect(
      app.do("TransferMoney", at("t-1"), move("acc-a", "acc-a", 50))
    ).rejects.toBeInstanceOf(PreconditionError);
    expect(await events("t-1")).toEqual([]);
  });

  test("a rival spending the money first: the retry sees it, and refuses", async ({
    app,
  }) => {
    await app.do("Deposit", at("acc-a"), { amount: 80 });
    rival_before_commit(() =>
      app.do("TransferMoney", at("t-rival"), move("acc-a", "acc-c", 70))
    );
    await expect(
      app.do("TransferMoney", at("t-1"), move("acc-a", "acc-b", 50))
    ).rejects.toThrow("enough funds");
    expect((await app.load(Account, "acc-a")).state.balance).toBe(10);
    expect(await events("acc-b")).toEqual([]);
  });
});

describe("library loans", () => {
  test("only the borrower returns a copy, closing the loan on both streams", async ({
    app,
  }) => {
    await app.do("Lend", at("copy-1"), { member: "m-1" });
    await expect(
      app.do("ReturnCopy", at("ret-1"), { copy: "copy-1", member: "m-2" })
    ).rejects.toThrow("the copy is lent to this member");
    await app.do("ReturnCopy", at("ret-2"), { copy: "copy-1", member: "m-1" });
    expect((await app.load(Copy, "copy-1")).state.borrower).toBeUndefined();
    expect((await app.load(Member, "m-1")).state.loansClosed).toBe(1);
  });
});
