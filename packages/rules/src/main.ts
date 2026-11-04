/**
 * A short tour of the rules: each step runs one action, and prints what
 * landed, or the refusal a client would get.
 */
import { dispose, sleep } from "@rotorsoft/act";
import {
  Account,
  app,
  courseStream,
  Email,
  emailStream,
  Product,
  Seats,
  Session,
  sessionsStream,
  UserSessions,
} from "./index.js";

const actor = { id: "tour", name: "tour" };
const at = (stream: string) => ({ stream, actor });

const heading = (title: string) => console.log(`\n${title}`);
// Runs an action a caller might be refused, and prints the outcome either way.
const attempt = async (what: string, action: () => Promise<unknown>) => {
  try {
    await action();
    console.log(`  ✓ ${what}`);
  } catch (error) {
    console.log(`  ✕ ${what}: ${(error as Error).message}`);
  }
};

heading("A unique value: one stream per email address");
const ann = "ann@x.io";
await attempt("Ann registers", () =>
  app.do("Register", at("user-ann"), { email: ann })
);
await attempt("Ben tries Ann's address", () =>
  app.do("Register", at("user-ben"), { email: ann })
);
await attempt("Ann changes her address: one frees, one takes, one commit", () =>
  app.do("ChangeEmail", at("user-ann"), { email: "ann@y.io" })
);
await attempt("Ben takes the freed address", () =>
  app.do("Register", at("user-ben"), { email: ann })
);
const { state: email } = await app.load(Email, emailStream(ann));
console.log(`  ${ann} is held by ${email.holder}`);

heading("A count limit: a course with two seats");
for (const student of ["ann", "ben", "cal"])
  await attempt(`${student} enrolls`, () =>
    app.do("Enroll", at(`enrollment-${student}`), { course: "c1", student })
  );
await attempt(
  "the course shrinks to one seat: those enrolled keep theirs",
  () => app.do("SetCapacity", at(courseStream("c1")), { capacity: 1 })
);
const { state: seats } = await app.load(Seats, courseStream("c1"));
console.log(`  ${seats.taken} taken of ${seats.capacity}`);

heading("A limit freed by a timer: a session that expires");
await attempt("Ann logs in for 50 ms", () =>
  app.do("OpenSession", at("session-1"), {
    user: "ann",
    expiresAt: Date.now() + 50,
  })
);
while ((await app.load(Session, "session-1")).state.open) await sleep(50);
const { state: sessions } = await app.load(UserSessions, sessionsStream("ann"));
console.log(`  ${sessions.active} sessions active after the timer`);

heading("Another state's schema: a room can't be double-booked");
await attempt("Dana books 9 to 11", () =>
  app.do("Book", at("booking-dana"), { room: "r1", from: 9, to: 11 })
);
await attempt("Eli books 10 to 12", () =>
  app.do("Book", at("booking-eli"), { room: "r1", from: 10, to: 12 })
);

heading("Several streams, all or none: a transfer");
await app.do("Deposit", at("acct-a"), { amount: 80 });
await attempt("move 50 from A to B", () =>
  app.do("TransferMoney", at("transfer-1"), {
    from: "acct-a",
    to: "acct-b",
    amount: 50,
  })
);
await attempt("move 50 more from A to B", () =>
  app.do("TransferMoney", at("transfer-2"), {
    from: "acct-a",
    to: "acct-b",
    amount: 50,
  })
);
await attempt("move 10 from A to A", () =>
  app.do("TransferMoney", at("transfer-3"), {
    from: "acct-a",
    to: "acct-a",
    amount: 10,
  })
);
const { state: a } = await app.load(Account, "acct-a");
const { state: b } = await app.load(Account, "acct-b");
console.log(`  A has ${a.balance}, B has ${b.balance}`);

heading("A read: the price a customer saw, checked but not guarded");
await app.do("SetPrice", at("p-7"), { price: 10 });
await attempt("add to the cart at 10", () =>
  app.do("AddToCart", at("cart-1"), { product: "p-7", price: 10 })
);
await attempt("add to the cart at 9", () =>
  app.do("AddToCart", at("cart-1"), { product: "p-7", price: 9 })
);
const { state: product } = await app.load(Product, "p-7");
console.log(`  the product's price is still ${product.price}`);

await dispose()();
