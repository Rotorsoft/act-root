/**
 * Several streams, all or none: one decision appends to each, so a part can't
 * land without the rest.
 */
import { state, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

// ── Money transfer: one state loaded twice ──────────────────────────────

const Amount = z.object({ amount: z.number().positive() });

export const Account = state({
  Account: z.object({ balance: z.number().min(0) }),
})
  .init(() => ({ balance: 0 }))
  .emits({ Deposited: Amount, Debited: Amount, Credited: Amount })
  .patch({
    Deposited: ({ data }, state) => ({ balance: state.balance + data.amount }),
    Debited: ({ data }, state) => ({ balance: state.balance - data.amount }),
    Credited: ({ data }, state) => ({ balance: state.balance + data.amount }),
  })
  .on({ Deposit: Amount })
  .emit("Deposited")
  .build();

const TransferMoney = Amount.extend({ from: z.string(), to: z.string() });

export const Transfer = state({ Transfer: TransferMoney })
  .init(() => ({ from: "", to: "", amount: 1 }))
  .emits({ Transferred: TransferMoney })
  .on({ TransferMoney }, { maxRetries: 4 })
  .loads(Account, (data) => data.from, ["Debited"], "from")
  .loads(Account, (data) => data.to, ["Credited"], "to")
  .requires([
    {
      description: "enough funds",
      holds: (data, _, __, { from }) => from.balance >= data.amount,
    },
  ])
  .emit((data) => [
    ["Transferred", data],
    ["Debited", { amount: data.amount }],
    ["Credited", { amount: data.amount }],
  ])
  .build();

// ── Library loans: only the borrower returns a copy ─────────────────────

const Lend = z.object({ member: z.string() });

export const Copy = state({
  Copy: z.object({ borrower: z.string().optional() }),
})
  .init(() => ({}))
  .emits({ Lent: Lend, CopyReturned: ZodEmpty })
  .patch({
    Lent: ({ data }) => ({ borrower: data.member }),
    CopyReturned: () => ({ borrower: undefined }),
  })
  .on({ Lend })
  .emit("Lent")
  .build();

export const Member = state({ Member: z.object({ loansClosed: z.number() }) })
  .init(() => ({ loansClosed: 0 }))
  .emits({ LoanClosed: z.object({ copy: z.string() }) })
  .patch({
    LoanClosed: (_, state) => ({ loansClosed: state.loansClosed + 1 }),
  })
  .build();

const ReturnCopy = z.object({ copy: z.string(), member: z.string() });

export const Return = state({ Return: ReturnCopy })
  .init(() => ({ copy: "", member: "" }))
  .emits({ Returned: ReturnCopy })
  .on({ ReturnCopy })
  .loads(Copy, (data) => data.copy, ["CopyReturned"])
  .loads(Member, (data) => data.member, ["LoanClosed"])
  .requires([
    {
      description: "the copy is lent to this member",
      holds: (data, _, __, { Copy }) => Copy.borrower === data.member,
    },
  ])
  .emit((data) => [
    ["Returned", data],
    ["CopyReturned", {}],
    ["LoanClosed", { copy: data.copy }],
  ])
  .build();
