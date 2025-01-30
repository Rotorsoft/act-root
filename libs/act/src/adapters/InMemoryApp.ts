import { Builder } from "../builder";

/**
 * @category Adapters
 * @remarks In-memory app adapter
 */
export class InMemoryApp extends Builder {
  constructor() {
    super();
  }

  get name() {
    return "InMemoryApp";
  }

  dispose() {
    return super.dispose();
  }

  listen() {
    return Promise.resolve();
  }
}
