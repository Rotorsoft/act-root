# Calculator Example

This example demonstrates a simple calculator implemented using the Act Framework. It showcases how to define state machines, actions, and events for basic arithmetic operations, and how to compose workflows using event-driven design.

## What You'll Learn

- How to define a state machine for a calculator
- How to model actions (key presses) and events (state changes)
- How to use reactions to build workflows
- How to test and run the example

## Source Files

- [calculator.ts](https://github.com/rotorsoft/act-root/blob/master/packages/calculator/src/calculator.ts): Calculator state machine and logic
- [main.ts](https://github.com/rotorsoft/act-root/blob/master/packages/calculator/src/main.ts): Example usage and entry point
- [index.ts](https://github.com/rotorsoft/act-root/blob/master/packages/calculator/src/index.ts): Module entry

## How It Works

1. The calculator state machine models the left/right operands, operator, and result.
2. Actions represent key presses (digits, operators, dot, equals, clear).
3. Events are emitted for each key press and drive state transitions.
4. The main example demonstrates pressing keys, updating state, and reacting to events.

## Usage

See the source files above for implementation details and usage examples.

[API Reference (act)](../api/act.src)
