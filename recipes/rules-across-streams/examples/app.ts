import { act } from "@rotorsoft/act";
import {
  Bill,
  Enrollment,
  InvoiceCounter,
  Seats,
  SessionTimers,
  Student,
} from "./count-limits.js";
import { Cart } from "./reads.js";
import { Account, Copy, Member, Return, Transfer } from "./several-streams.js";
import {
  Bike,
  Booking,
  HoldTimers,
  Invoice,
  Payment,
  Rental,
  Room,
} from "./state-schemas.js";
import {
  Email,
  Plate,
  Redemption,
  Review,
  Reviewer,
  Token,
  User,
  Vehicle,
} from "./unique-values.js";

/** Every loaded state is registered here: one Act, one store, one commit. */
export const rules = act()
  .withState(Email)
  .withState(User)
  .withState(Plate)
  .withState(Vehicle)
  .withState(Token)
  .withState(Redemption)
  .withState(Review)
  .withState(Reviewer)
  .withState(Seats)
  .withState(Student)
  .withState(Enrollment)
  .withSlice(SessionTimers)
  .withState(InvoiceCounter)
  .withState(Bill)
  .withState(Room)
  .withState(Booking)
  .withState(Invoice)
  .withState(Payment)
  .withSlice(HoldTimers)
  .withState(Bike)
  .withState(Rental)
  .withState(Account)
  .withState(Transfer)
  .withState(Copy)
  .withState(Member)
  .withState(Return)
  .withState(Cart);

export const app = rules.build();
