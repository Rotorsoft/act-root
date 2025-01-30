import { EventEmitter } from "node:events";
import type { ZodType } from "zod";
import { State } from "./state";
import type { Disposable, Rec, RecRec, Snapshot } from "./types";

type Factory<
  T extends Rec = Rec,
  A extends RecRec = RecRec,
  E extends RecRec = RecRec
> = () => State<T, A, E>;

export declare interface Builder {
  on(
    event: "commit",
    listener: (args: {
      instance: State;
      snapshot?: Snapshot<Rec, RecRec>;
    }) => void
  ): this;
}

/**
 * Abstract application builder
 *
 * Concrete adapters should provide disposers and the listening framework
 */
export abstract class Builder extends EventEmitter implements Disposable {
  abstract readonly name: string;
  abstract listen(): Promise<void>;

  dispose(): Promise<void> {
    this.removeAllListeners();
    return Promise.resolve();
  }

  readonly factories = new Map<string, Factory>();
  readonly actions = new Map<string, { factory: Factory; schema: ZodType }>();
  readonly events = new Map<string, { factory: Factory; schema: ZodType }>();

  constructor() {
    super();
  }

  with<T extends Rec, A extends RecRec, E extends RecRec>(
    factory: Factory<T, A, E>
  ): this {
    if (this.factories.has(factory.name))
      throw Error(`Duplicate factory "${factory.name}"`);

    const generic_factory = factory as unknown as Factory;
    this.factories.set(factory.name, generic_factory);
    const instance = factory();
    Object.keys(instance.__actions).forEach((name) => {
      const found = this.actions.get(name);
      if (found)
        throw Error(
          `Duplicate action "${name}" found in "${found.factory.name}" and "${factory.name}"`
        );
      this.actions.set(name, {
        factory: generic_factory,
        schema: instance.__actions[name]
      });
    });
    Object.keys(instance.__events).forEach((name) => {
      const found = this.events.get(name);
      if (found)
        throw Error(
          `Duplicate event "${name}" found in "${found.factory.name}" and "${factory.name}"`
        );
      this.events.set(name, {
        factory: generic_factory,
        schema: instance.__events[name]
      });
    });
    return this;
  }

  /**
   * Builds app
   * Concrete app adapters should provide their own building steps
   * @returns optional internal application object (e.g. express)
   */
  build(): unknown | undefined {
    return;
  }
}
