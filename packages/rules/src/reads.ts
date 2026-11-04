/**
 * A load without events is a read: the rule sees the state, but the stream is
 * outside the commit and isn't checked when it lands. It costs no conflicts
 * and guards nothing, so use it for a rule that can tolerate a stale answer.
 */
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { Product } from "./state-schemas.js";

const AddToCart = z.object({ product: z.string(), price: z.number() });

export const Cart = state({ Cart: z.object({ total: z.number() }) })
  .init(() => ({ total: 0 }))
  .emits({ ItemAdded: AddToCart })
  .patch({
    ItemAdded: ({ data }, state) => ({ total: state.total + data.price }),
  })
  .on({ AddToCart })
  .loads(Product, (data) => data.product)
  .requires([
    {
      description: "the displayed price is current",
      holds: (data, _, __, { Product }) => data.price === Product.price,
    },
  ])
  .emit("ItemAdded")
  .build();
