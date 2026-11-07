/**
 * A rule added to existing data needs its new streams filled from current
 * state: until then, every address already in use looks free. `fill` is safe to
 * run again, because it skips what's already filled. Duplicates it finds are
 * reported for a person to resolve.
 *
 * Fill once, deploy the rule, then fill again, to catch anyone who registered
 * in between.
 *
 * Run from the repo root:
 *   LOG_LEVEL=error npx tsx recipes/rules-across-streams/examples/fill-streams.ts
 */
import { fileURLToPath } from "node:url";
import { act, dispose, PreconditionError, state } from "@rotorsoft/act";
import { z } from "zod";
import { Email, emailStream } from "./unique-values.js";

const SYSTEM = { id: "fill", name: "email fill" };

/** The state before the rule: users with an address, and nothing unique about it. */
const SignUp = z.object({ emailStream: z.string() });

export const Customer = state({ Customer: SignUp })
  .init(() => ({ emailStream: "" }))
  .emits({ SignedUp: SignUp })
  .on({ SignUp })
  .emit("SignedUp")
  .build();

const FillEmail = z.object({ customer: z.string(), emailStream: z.string() });

/** Records each fill on its own stream, and takes the address in one commit. */
export const EmailFill = state({ EmailFill: FillEmail })
  .init(() => ({ customer: "", emailStream: "" }))
  .emits({ EmailFilled: FillEmail })
  .on({ FillEmail }, { maxRetries: 2 })
  .loads(Email, (data) => data.emailStream, ["EmailTaken"])
  .requires([
    {
      description: "the email is free",
      holds: (_, __, ___, { Email }) => !Email.holder,
    },
  ])
  .emit((data) => [
    ["EmailFilled", data],
    ["EmailTaken", { user: data.customer }],
  ])
  .build();

export const builder = act()
  .withState(Email)
  .withState(Customer)
  .withState(EmailFill);

type App = ReturnType<typeof builder.build>;

/** Fills an `Email` for every customer, and returns what it did. */
export async function fill(app: App) {
  const customers = new Set<string>();
  await app.query({ names: ["SignedUp"] }, (event) =>
    customers.add(event.stream)
  );

  const report = { filled: 0, skipped: 0, duplicates: [] as string[] };
  for (const customer of customers) {
    const { state: current } = await app.load(Customer, customer);
    const { state: taken } = await app.load(Email, current.emailStream);
    if (taken.holder === customer) {
      report.skipped++;
      continue;
    }
    try {
      await app.do(
        "FillEmail",
        { stream: `fill-${customer}`, actor: SYSTEM },
        { customer, emailStream: current.emailStream }
      );
      report.filled++;
    } catch (error) {
      if (!(error instanceof PreconditionError)) throw error;
      report.duplicates.push(customer);
    }
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = builder.build();
  const signUp = (stream: string, email: string) =>
    app.do(
      "SignUp",
      { stream, actor: SYSTEM },
      { emailStream: emailStream(email) }
    );
  await signUp("ann", "ann@example.com");
  await signUp("bob", "bob@example.com");
  await signUp("ann-again", "ann@example.com");

  console.log("first run ", await fill(app));
  console.log("second run", await fill(app));
  await dispose()();
}
