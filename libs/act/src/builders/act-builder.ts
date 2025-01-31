import type { Schema, Schemas, StateFactory } from "../types";
import { Act, type Registry, type SchemaRegister } from "./act";

interface IActBuilder<
  E extends Schemas,
  A extends Schemas,
  S extends SchemaRegister<A>,
> {
  with<EX extends Schemas, AX extends Schemas, SX extends Schema>(
    factory: StateFactory<EX, AX, SX>
  ): IActBuilder<E & EX, A & AX, S & { [K in keyof AX]: SX }>;
  build(): Act<E, A, S>;
}

/* eslint-disable @typescript-eslint/no-empty-object-type */
export class ActBuilder<
  E extends Schemas = {},
  A extends Schemas = {},
  // @ts-expect-error empty schema
  S extends SchemaRegister<A> = {},
> implements IActBuilder<E, A, S>
{
  private factories = new Set<string>();

  constructor(
    public readonly registry = {
      actions: {},
      events: {},
    } as Registry<E, A, S>
  ) {}

  with<EX extends Schemas, AX extends Schemas, SX extends Schema>(
    factory: StateFactory<EX, AX, SX>
  ): IActBuilder<E & EX, A & AX, S & { [K in keyof AX]: SX }> {
    if (!this.factories.has(factory.name)) {
      this.factories.add(factory.name);
      const me = factory();
      Object.keys(me.actions).forEach((name) => {
        if (this.registry.actions[name])
          throw Error(`Duplicate action "${name}"`);
        // @ts-expect-error indexed access
        this.registry.actions[name] = me;
      });
      Object.keys(me.events).forEach((name) => {
        if (this.registry.events[name])
          throw Error(`Duplicate event "${name}"`);
        // @ts-expect-error indexed access
        this.registry.events[name] = {
          schema: me.events[name],
          reactions: new Map(),
        };
      });
    }
    return this as unknown as IActBuilder<
      E & EX,
      A & AX,
      S & { [K in keyof AX]: SX }
    >;
  }

  build(): Act<E, A, S> {
    return new Act<E, A, S>(this.registry);
  }
}
