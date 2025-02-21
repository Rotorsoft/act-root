import type {
  EventRegister,
  Reaction,
  ReactionHandler,
  ReactionOptions,
  ReactionResolver,
  Schemas,
} from "../types";
import { Broker } from "./broker";

// default resolver resolves to same event stream
const _this_ = ({ stream }: { stream: string }) => stream;
// nothing to resolve
const _void_ = () => undefined;

interface IBrokerBuilder<E extends Schemas> {
  when<K extends keyof E>(event: K): IDoBuilder<E, K>;
  build(): Broker<E>;
}

interface IDoBuilder<E extends Schemas, K extends keyof E>
  extends IBrokerBuilder<E> {
  do(
    handler: ReactionHandler<E, K>,
    options?: Partial<ReactionOptions>
  ): IToBuilder<E, K>;
}

interface IToBuilder<E extends Schemas, K extends keyof E>
  extends IDoBuilder<E, K> {
  to(resolver: ReactionResolver<E, K>): IDoBuilder<E, K>;
  void(): IDoBuilder<E, K>;
}

export class BrokerBuilder<E extends Schemas> implements IBrokerBuilder<E> {
  constructor(protected events: EventRegister<E>) {}
  when<K extends keyof E>(event: K): IDoBuilder<E, K> {
    return new DoBuilder(this.events, event);
  }
  build(drainLimit = 10): Broker<E> {
    return new Broker<E>(this.events, drainLimit);
  }
}

class DoBuilder<E extends Schemas, K extends keyof E>
  extends BrokerBuilder<E>
  implements IDoBuilder<E, K>
{
  constructor(
    events: EventRegister<E>,
    protected event: K
  ) {
    super(events);
  }

  do<K extends keyof E>(
    handler: ReactionHandler<E, K>,
    options?: Partial<ReactionOptions>
  ): IToBuilder<E, K> {
    const reaction = {
      handler: handler as ReactionHandler<E, keyof E>,
      resolver: _this_,
      options: {
        blockOnError: options?.blockOnError ?? true,
        maxRetries: options?.maxRetries ?? 3,
        retryDelayMs: options?.retryDelayMs ?? 1000,
      },
    };
    this.events[this.event].reactions.set(handler.name, reaction);
    return new ToBuilder(this.events, this.event, reaction);
  }
}

class ToBuilder<E extends Schemas, K extends keyof E>
  extends DoBuilder<E, K>
  implements IToBuilder<E, K>
{
  constructor(
    events: EventRegister<E>,
    event: K,
    private reaction: Reaction<E, K>
  ) {
    super(events, event);
  }

  to<K extends keyof E>(resolver: ReactionResolver<E, K>): IDoBuilder<E, K> {
    this.events[this.event].reactions.set(this.reaction.handler.name, {
      handler: this.reaction.handler,
      resolver: resolver as ReactionResolver<E, keyof E>,
      options: this.reaction.options,
    });
    return new DoBuilder(this.events, this.event);
  }

  void<K extends keyof E>(): IDoBuilder<E, K> {
    this.events[this.event].reactions.set(this.reaction.handler.name, {
      handler: this.reaction.handler,
      resolver: _void_,
      options: this.reaction.options,
    });
    return new DoBuilder(this.events, this.event);
  }
}
