import { Act } from "./act";
import type {
  EventRegister,
  Reaction,
  ReactionHandler,
  ReactionOptions,
  ReactionResolver,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  StateFactory,
} from "./types";

// default resolver resolves to same event stream
const _this_ = ({ stream }: { stream: string }) => stream;
// nothing to resolve
const _void_ = () => undefined;

export interface IActBuilder<
  E extends Schemas,
  A extends Schemas,
  S extends SchemaRegister<A>,
> {
  get events(): EventRegister<E>;
  with<EX extends Schemas, AX extends Schemas, SX extends Schema>(
    factory: StateFactory<EX, AX, SX>
  ): IActBuilder<E & EX, A & AX, S & { [K in keyof AX]: SX }>;
  on<K extends keyof E>(event: K): IDoBuilder<E, A, S, K>;
  build(drainLimit?: number): Act<E, A, S>;
}

interface IDoBuilder<
  E extends Schemas,
  A extends Schemas,
  S extends SchemaRegister<A>,
  K extends keyof E,
> extends IActBuilder<E, A, S> {
  do(
    handler: ReactionHandler<E, K>,
    options?: Partial<ReactionOptions>
  ): IToBuilder<E, A, S, K>;
}

interface IToBuilder<
  E extends Schemas,
  A extends Schemas,
  S extends SchemaRegister<A>,
  K extends keyof E,
> extends IDoBuilder<E, A, S, K> {
  to(resolver: ReactionResolver<E, K>): IDoBuilder<E, A, S, K>;
  void(): IDoBuilder<E, A, S, K>;
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
    protected _registry = {
      actions: {},
      events: {},
    } as Registry<E, A, S>
  ) {}

  get events(): EventRegister<E> {
    return this._registry.events;
  }

  with<EX extends Schemas, AX extends Schemas, SX extends Schema>(
    factory: StateFactory<EX, AX, SX>
  ): IActBuilder<E & EX, A & AX, S & { [K in keyof AX]: SX }> {
    if (!this.factories.has(factory.name)) {
      this.factories.add(factory.name);
      const me = factory();
      Object.keys(me.actions).forEach((name) => {
        if (this._registry.actions[name])
          throw Error(`Duplicate action "${name}"`);
        // @ts-expect-error indexed access
        this._registry.actions[name] = me;
      });
      Object.keys(me.events).forEach((name) => {
        if (this._registry.events[name])
          throw Error(`Duplicate event "${name}"`);
        // @ts-expect-error indexed access
        this._registry.events[name] = {
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

  on<K extends keyof E>(event: K): IDoBuilder<E, A, S, K> {
    return new DoBuilder(this._registry, event);
  }

  build(drainLimit = 10): Act<E, A, S> {
    return new Act<E, A, S>(this._registry, drainLimit);
  }
}

class DoBuilder<
    E extends Schemas,
    A extends Schemas,
    S extends SchemaRegister<A>,
    K extends keyof E,
  >
  extends ActBuilder<E, A, S>
  implements IDoBuilder<E, A, S, K>
{
  constructor(
    registry: Registry<E, A, S>,
    protected event: K
  ) {
    super(registry);
  }
  get events(): EventRegister<E> {
    throw new Error("Method not implemented.");
  }

  do<K extends keyof E>(
    handler: ReactionHandler<E, K>,
    options?: Partial<ReactionOptions>
  ): IToBuilder<E, A, S, K> {
    const reaction = {
      handler: handler as ReactionHandler<E, keyof E>,
      resolver: _this_,
      options: {
        blockOnError: options?.blockOnError ?? true,
        maxRetries: options?.maxRetries ?? 3,
        retryDelayMs: options?.retryDelayMs ?? 1000,
      },
    };
    this._registry.events[this.event].reactions.set(handler.name, reaction);
    return new ToBuilder(this._registry, this.event, reaction);
  }
}

class ToBuilder<
    E extends Schemas,
    A extends Schemas,
    S extends SchemaRegister<A>,
    K extends keyof E,
  >
  extends DoBuilder<E, A, S, K>
  implements IToBuilder<E, A, S, K>
{
  constructor(
    registry: Registry<E, A, S>,
    event: K,
    private reaction: Reaction<E, K>
  ) {
    super(registry, event);
  }
  get events(): EventRegister<E> {
    throw new Error("Method not implemented.");
  }

  to<K extends keyof E>(
    resolver: ReactionResolver<E, K>
  ): IDoBuilder<E, A, S, K> {
    this._registry.events[this.event].reactions.set(
      this.reaction.handler.name,
      {
        handler: this.reaction.handler,
        resolver: resolver as ReactionResolver<E, keyof E>,
        options: this.reaction.options,
      }
    );
    return new DoBuilder(this._registry, this.event);
  }

  void<K extends keyof E>(): IDoBuilder<E, A, S, K> {
    this._registry.events[this.event].reactions.set(
      this.reaction.handler.name,
      {
        handler: this.reaction.handler,
        resolver: _void_,
        options: this.reaction.options,
      }
    );
    return new DoBuilder(this._registry, this.event);
  }
}
