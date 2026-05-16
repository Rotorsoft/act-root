# Chapter 8 — core domains and when event sourcing is the right tool

Chapter 8 (Domain-Driven Design in Practice) should explain when event sourcing and Act are the right tool, drawing from Vlad Khononov's "Learning Domain-Driven Design" classification of domain complexity.

**Core domains** — the competitive advantage, complex business logic, high change rate. This is where event sourcing shines: full audit trail, temporal queries, complex workflows, event-driven reactions. Worth the investment.

**Supporting domains** — necessary but not differentiating. Simpler patterns (CRUD, basic services) are often sufficient. Event sourcing is overkill here.

**Generic domains** — solved problems (auth, payments, email). Buy or use existing solutions. Don't build these with event sourcing.

The key insight: event sourcing is not a universal pattern. It's the right choice for core domains where the history of state changes matters, where business rules are complex and evolving, where audit and temporal queries are valuable, and where event-driven workflows connect multiple aggregates. For simple CRUD entities or generic subdomains, the overhead isn't justified.

This is also a natural place to credit Khononov's contribution to modernizing DDD education and making the strategic/tactical distinction accessible.

Readers need to know when NOT to use event sourcing. A book that only says "use this everywhere" loses credibility.

In Chapter 8, after introducing ubiquitous language and bounded contexts, add a section on domain classification. Use Khononov's framework to explain why the Risk game (complex rules, state transitions, multiplayer interactions, audit needs) is a core domain that benefits from event sourcing, while something like user preferences or static configuration is not.
