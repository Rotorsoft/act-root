import { act } from "@rotorsoft/act";
import { Calculator } from "./calculator.js";

/**
 * The built `Act` instance behind the calculator. `packages/server`
 * generates every transport from it (tRPC, REST, SSE and the OpenAPI
 * document) and exports their types for the client.
 */
export const calculatorApp = act().withState(Calculator).build();
