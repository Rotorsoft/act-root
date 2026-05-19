import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import BrowserOnly from "@docusaurus/BrowserOnly";
import Layout from "@theme/Layout";
import CodeBlock from "@theme/CodeBlock";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import styles from "./index.module.css";

const QUICKSTART_INSTALL = `npm install @rotorsoft/act zod`;

const QUICKSTART_APP = `import { act, state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.amount }) })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const app = act().withState(Counter).build();

await app.do("increment",
  { stream: "counter1", actor: { id: "1", name: "User" } },
  { by: 1 }
);
console.log(await app.load(Counter, "counter1"));`;

type PatternId = "slices" | "projections" | "partial" | "invariants" | "orchestrator";

const PATTERNS: Record<
  PatternId,
  { tab: string; title: string; blurb: string; code: string; note: string }
> = {
  slices: {
    tab: "Vertical Slices",
    title: "Group states and reactions into feature modules",
    blurb:
      "Each slice owns a set of partial states and their scoped reactions. Handlers receive the full IAct interface for cross-state coordination.",
    code: `const TicketCreationSlice = slice()
  .withState(TicketCreation)      // partial state
  .withState(TicketOperations)    // another partial state

  .on("TicketOpened")
  .do(async function assign(event, _stream, app) {
    const agent = assignAgent(event.stream, event.data.supportCategoryId);
    await app.do("AssignTicket",
      { stream: event.stream, actor: { id: randomUUID(), name: "assign" } },
      agent, event
    );
  })
  .build();`,
    note: "WolfDesk uses 3 slices: Creation, Operations, and Messaging — each a self-contained feature boundary.",
  },
  projections: {
    tab: "Projections",
    title: "Build read-model updaters from events",
    blurb:
      "Projections react to events and update external state (databases, caches). Unlike slices, handlers are pure side effects — no IAct needed.",
    code: `const TicketProjection = projection("tickets")
  .on({ TicketOpened })
    .do(async function opened({ stream, data }) {
      await db.insert(tickets).values({ id: stream, ...data });
    })
  .on({ TicketClosed })
    .do(async function closed({ stream, data }) {
      await db.update(tickets).set(data).where(eq(tickets.id, stream));
    })
  .on({ MessageAdded })
    .do(async function messageAdded({ stream }) {
      await db.update(tickets)
        .set({ messages: sql\`\${tickets.messages} + 1\` })
        .where(eq(tickets.id, stream));
    })
  .build();`,
    note: 'Default target "tickets" is inherited by all handlers. Override per-handler with .to().',
  },
  partial: {
    tab: "Partial States",
    title: "Compose multiple partial states into a single aggregate",
    blurb:
      "Split a complex aggregate into focused partial states that share the same stream. Each partial declares only the fields it needs. Schemas merge automatically at build time.",
    code: `// Three partials share the Ticket stream
const TicketCreation = state({ Ticket: TicketCreationState })
  .init(() => ({ title: "", productId: "", userId: "", priority: "Low", messages: {} }))
  .emits({ TicketOpened, TicketClosed, TicketResolved })
  .patch({ TicketOpened: ... })  // optional — only custom reducers
  .on({ OpenTicket }).emit(...)
  .on({ CloseTicket }).given([mustBeOpen]).emit("TicketClosed")  // passthrough
  .build();

const TicketOperations = state({ Ticket: TicketOperationsState })
  .init(() => ({ productId: "", userId: "", messages: {} }))
  .emits({ TicketAssigned, TicketEscalated, TicketReassigned })
  .on({ AssignTicket }).given([mustBeOpen]).emit("TicketAssigned")  // passthrough
  .build();

const TicketMessaging = state({ Ticket: TicketMessagingState })
  // ... handles AddMessage, MarkMessageDelivered, AcknowledgeMessage
  .build();`,
    note: 'All three share the name "Ticket" — the orchestrator merges their schemas via ZodObject.extend().',
  },
  invariants: {
    tab: "Invariants",
    title: "Define reusable business rules across slices",
    blurb:
      "Invariants are typed constraints checked before actions execute. Define them once, reuse across any state via .given([invariant]).",
    code: `import { type Invariant } from "@rotorsoft/act";

export const mustBeOpen: Invariant<{ productId: string; closedById?: string }> = {
  description: "Ticket must be open",
  valid: (state) => !!state.productId && !state.closedById,
};

export const mustBeUser: Invariant<{ productId: string; userId: string }> = {
  description: "Must be the owner",
  valid: (state, actor) => state.userId === actor?.id,
};

// Use in any state builder:
.on({ CloseTicket }).given([mustBeOpen]).emit("TicketClosed")
.on({ RequestEscalation }).given([mustBeOpen, mustBeUser]).emit("TicketEscalationRequested")`,
    note: "Typed against minimal interfaces — TypeScript contravariance ensures Invariant<SuperType> is assignable to Invariant<SubType>.",
  },
  orchestrator: {
    tab: "Orchestrator",
    title: "Wire everything together with the Act orchestrator",
    blurb:
      "The act() builder uses .withState(), .withSlice(), and .withProjection() for type-safe composition. Schemas and reactions merge automatically — one line per feature module.",
    code: `import { act } from "@rotorsoft/act";

export const app = act()
  .withSlice(TicketCreationSlice)    // slice: states + scoped reactions
  .withSlice(TicketMessagingSlice)   // slice: states + scoped reactions
  .withSlice(TicketOpsSlice)         // slice: states + scoped reactions
  .withProjection(TicketProjection)  // projection: read-model updaters
  .build();

// Execute actions
await app.do("OpenTicket", { stream: "ticket-1", actor }, payload);

// Load merged state (all partials combined)
const snapshot = await app.load("Ticket", "ticket-1");

// Process reactions
await app.drain({ streamLimit: 100, eventLimit: 1000 });`,
    note: "3 slices + 1 projection compose into a complete ticketing system. Each feature module is independently testable.",
  },
};

const FEATURES: { title: string; body: string; icon: JSX.Element }[] = [
  {
    title: "Functional Event Sourcing",
    body: "Every state change is a pure function of previous state and events. Immutability and replayability by design.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
  },
  {
    title: "Composable State Machines",
    body: "Model your domain as composable, strongly-typed state machines. No classes, just functions and data.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
  },
  {
    title: "TypeScript Native",
    body: "Type safety and inference everywhere. Catch errors at compile time, not at runtime.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    title: "Reactive by Default",
    body: "Reactions let you build event-driven flows and side effects with ease — with built-in correlation, drain, and dual-frontier processing.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10" />
        <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14" />
      </svg>
    ),
  },
  {
    title: "Production Adapters Included",
    body: "Postgres for scale, SQLite for embedded, in-memory for tests. Switch between them with a single line of code.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 5v14c0 1.66-4.03 3-9 3s-9-1.34-9-3V5" />
        <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
      </svg>
    ),
  },
  {
    title: "Minimal Footprint",
    body: "Minimal and dependency-light. No codegen, no runtime bloat, and a tiny bundle size.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    ),
  },
];

function Hero() {
  const docsUrl = useBaseUrl("/docs/intro");
  return (
    <header className={styles.hero}>
      <div className={styles.heroGlow} aria-hidden />
      <div className={styles.heroInner}>
        <div className={styles.heroBadge}>
          <span className={styles.heroBadgeDot} />
          v0.x &middot; TypeScript-first event sourcing
        </div>

        <div className={styles.heroBrand}>
          <img
            className={styles.heroIcon}
            src={useBaseUrl("/img/logo-dark.png")}
            alt=""
            aria-hidden="true"
          />
          <h1 className={styles.heroWordmark} aria-label="Act">
            <span style={{ color: "var(--act-cyan)" }}>A</span>
            <span style={{ color: "var(--act-amber)" }}>c</span>
            <span className={styles.heroT} style={{ color: "var(--act-green)" }}>
              t
            </span>
          </h1>
        </div>

        <p className={styles.heroTagline}>
          <span className="act-gradient-text">Fluent event sourcing</span> for TypeScript
        </p>

        <p className={styles.heroLede}>
          Build robust, auditable, and reactive systems with composable state machines, pure
          functions, and zero runtime bloat.
        </p>

        <div className={styles.heroCtas}>
          <Link className={`button button--primary button--lg ${styles.heroCta}`} to={docsUrl}>
            Get started
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Link>
          <Link
            className={`button button--secondary button--lg ${styles.heroCta}`}
            href="https://github.com/rotorsoft/act-root"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.184 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.868-.014-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.157-1.11-1.465-1.11-1.465-.908-.62.069-.608.069-.608 1.004.07 1.532 1.032 1.532 1.032.892 1.53 2.341 1.088 2.91.832.091-.647.35-1.088.636-1.339-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.987 1.029-2.686-.103-.254-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.025A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.295 2.748-1.025 2.748-1.025.546 1.378.202 2.396.1 2.65.64.699 1.028 1.593 1.028 2.686 0 3.847-2.338 4.695-4.566 4.944.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.749 0 .268.18.579.688.481C19.138 20.2 22 16.447 22 12.021 22 6.484 17.523 2 12 2Z" />
            </svg>
            GitHub
          </Link>
          <Link
            className={`button button--lg ${styles.heroCta} ${styles.heroCtaBook}`}
            href="https://payhip.com/b/7ezLy"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            Read the Book
          </Link>
        </div>

        <div className={styles.heroPills}>
          <span className={styles.heroPill}>Actions → State ← Reactions</span>
          <span className={styles.heroPill}>Postgres · SQLite · In-Memory</span>
          <span className={styles.heroPill}>Zod-typed</span>
        </div>
      </div>
    </header>
  );
}

function Quickstart() {
  const getStartedUrl = useBaseUrl("/docs/intro");
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>
          <span className="act-gradient-text">Three steps</span> to your first event
        </h2>
        <p className={styles.sectionSub}>From install to your first persisted event in under a minute.</p>
      </div>

      <div className={styles.quickstartCard}>
        <div className={styles.qsStep}>
          <span className={styles.qsStepNum}>1</span>
          <span className={styles.qsStepLabel}>Install</span>
        </div>
        <CodeBlock language="bash">{QUICKSTART_INSTALL}</CodeBlock>

        <div className={styles.qsStep}>
          <span className={styles.qsStepNum}>2</span>
          <span className={styles.qsStepLabel}>Define a state and run an action</span>
        </div>
        <CodeBlock language="typescript">{QUICKSTART_APP}</CodeBlock>

        <div className={styles.qsStep}>
          <span className={styles.qsStepNum}>3</span>
          <span className={styles.qsStepLabel}>Run &amp; explore</span>
        </div>
        <p className={styles.qsRunHint}>
          Run your app and see the output in your terminal. Then dive into reactions, projections,
          and slices.
        </p>

        <Link className={`button button--primary button--lg ${styles.qsCta}`} to={getStartedUrl}>
          Read the full guide
        </Link>
      </div>
    </section>
  );
}

type SandboxProps = {
  title: string;
  src: string;
  open: string;
  source: string;
  blurb: string;
};

function Sandbox({ title, src, open, source, blurb }: SandboxProps) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={styles.sandboxCard}>
      <div className={styles.sandboxHeader}>
        <span className={styles.sandboxIcon} aria-hidden>
          <svg viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </span>
        <div>
          <h3 className={styles.sandboxTitle}>{title}</h3>
          <p className={styles.sandboxBlurb}>{blurb}</p>
        </div>
      </div>
      <div className={styles.sandboxFrameWrap}>
        {loaded ? (
          <iframe
            className={styles.sandboxFrame}
            src={src}
            title={title}
            tabIndex={-1}
            allow="accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; payment; usb; vr; xr-spatial-tracking"
            sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
          />
        ) : (
          <button
            type="button"
            className={styles.sandboxPoster}
            onClick={() => setLoaded(true)}
            aria-label={`Run ${title} sandbox`}
          >
            <span className={styles.sandboxPosterIcon}>
              <svg width="56" height="56" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </span>
            <span className={styles.sandboxPosterTitle}>Run live sandbox</span>
            <span className={styles.sandboxPosterHint}>Loads StackBlitz editor + terminal in place</span>
          </button>
        )}
      </div>
      <div className={styles.sandboxLinks}>
        <a href={open} target="_blank" rel="noopener noreferrer">
          Open in StackBlitz ↗
        </a>
        <a href={source} target="_blank" rel="noopener noreferrer">
          Source on GitHub ↗
        </a>
      </div>
    </div>
  );
}

function Sandboxes() {
  return (
    <BrowserOnly fallback={null}>
      {() => {
        const isChrome =
          /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
        const isDesktop =
          window.innerWidth > 900 && !/Mobi|Android/i.test(navigator.userAgent);
        if (!isChrome || !isDesktop) return null;

        return (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>
                <span className="act-gradient-text">Try it live</span>
              </h2>
              <p className={styles.sectionSub}>
                Two interactive sandboxes — actions, events and replay in the first;
                independent drain lanes drafting over the leading/lagging frontier in the second.
              </p>
              <p className={styles.sectionNote}>
                StackBlitz fetches the project from GitHub on each click. If the
                sandbox stalls on "Downloading from GitHub…" the first time,
                refresh once and it loads from the warm cache.
              </p>
            </div>

            <Sandbox
              title="Event Sourcing + Lanes"
              blurb="Calculator demo — random keypresses commit events, a digit-board projection drains on the “board” lane, a per-stream result projection drains on the “result” lane. Watch lane names tag every drain cycle in the trace."
              src="https://stackblitz.com/github/rotorsoft/act-root/tree/master/packages/calculator?embed=1&view=editor&terminal=1&file=src/main.ts&hideNavigation=1&showSidebar=0&showExplorer=0&showPreview=0&startScript=dev%3Astackblitz"
              open="https://stackblitz.com/github/rotorsoft/act-root/tree/master/packages/calculator?file=src/main.ts&embed=1&view=editor&terminal=1&hideNavigation=1&showSidebar=0&showExplorer=0&showPreview=0&startScript=dev%3Astackblitz"
              source="https://github.com/rotorsoft/act-root/tree/master/packages/calculator/src"
            />

            <Sandbox
              title="Lanes × Adaptive Dual-Frontier Drain"
              blurb="Todo load test split across two lanes — “writes” (creates + updates, tight lease, hot path) and “mutations” (deletes, longer lease, can tolerate lag). Each drain cycle prints a lane × frontier table so you can see Act adapt the leading/lagging budget independently per lane until everything converges."
              src="https://stackblitz.com/github/rotorsoft/act-root/tree/master/performance/act-performance?embed=1&view=editor&terminal=1&file=src/index.ts&hideNavigation=1&showSidebar=0&showExplorer=0&showPreview=0&startScript=start%3Astackblitz"
              open="https://stackblitz.com/github/rotorsoft/act-root/tree/master/performance/act-performance?file=src/index.ts&embed=1&view=editor&terminal=1&hideNavigation=1&showSidebar=0&showExplorer=0&showPreview=0&startScript=start%3Astackblitz"
              source="https://github.com/rotorsoft/act-root/tree/master/performance/act-performance/src"
            />
          </section>
        );
      }}
    </BrowserOnly>
  );
}

function CompositionPatterns() {
  const [active, setActive] = useState<PatternId>("slices");
  const ids = Object.keys(PATTERNS) as PatternId[];
  const current = PATTERNS[active];

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>
          <span className="act-gradient-text">Advanced composition</span> patterns
        </h2>
        <p className={styles.sectionSub}>
          Five primitives compose every Act application — slices, projections, partial states,
          invariants, and the orchestrator.
        </p>
      </div>

      <div className={styles.patternsPanel}>
        <div className={styles.patternsTabs} role="tablist">
          {ids.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={active === id}
              type="button"
              className={`${styles.patternsTab} ${active === id ? styles.patternsTabActive : ""}`}
              onClick={() => setActive(id)}
            >
              {PATTERNS[id].tab}
            </button>
          ))}
        </div>

        <div className={styles.patternsBody}>
          <h3 className={styles.patternsHeading}>{current.title}</h3>
          <p className={styles.patternsBlurb}>{current.blurb}</p>
          <CodeBlock language="typescript">{current.code}</CodeBlock>
          <p className={styles.patternsNote}>{current.note}</p>
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>
          <span className="act-gradient-text">Built for serious systems</span>
        </h2>
        <p className={styles.sectionSub}>
          Type-safe primitives and production-ready adapters, with the smallest API surface that
          gets the job done.
        </p>
      </div>

      <div className={styles.featureGrid}>
        {FEATURES.map((f) => (
          <div key={f.title} className={styles.featureCard}>
            <div className={styles.featureIcon}>{f.icon}</div>
            <h3 className={styles.featureTitle}>{f.title}</h3>
            <p className={styles.featureBody}>{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  const docsUrl = useBaseUrl("/docs/intro");
  const archUrl = useBaseUrl("/docs/architecture");
  return (
    <section className={`${styles.section} ${styles.finalCta}`}>
      <div className={styles.finalCtaInner}>
        <h2 className={styles.finalCtaTitle}>
          Ready to <span className="act-gradient-text">act</span>?
        </h2>
        <p className={styles.finalCtaBody}>
          Spend a minute on the quickstart, an afternoon on the Calculator example, or a weekend
          on WolfDesk — every step has a working sandbox.
        </p>
        <div className={styles.heroCtas}>
          <Link className="button button--primary button--lg" to={docsUrl}>
            Get started
          </Link>
          <Link className="button button--secondary button--lg" to={archUrl}>
            Architecture deep-dive
          </Link>
        </div>
      </div>
    </section>
  );
}

function AnimatedT() {
  // Animate the wordmark "t" every 12 seconds when the hero is visible.
  useEffect(() => {
    const t = document.querySelector(`.${styles.heroT}`);
    if (!t) return;
    let timer: number | undefined;
    const trigger = () => {
      t.classList.remove(styles.heroTAnimate);
      // Force reflow.
      void (t as HTMLElement).offsetWidth;
      t.classList.add(styles.heroTAnimate);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          trigger();
          timer = window.setInterval(trigger, 12000);
        } else if (timer) {
          window.clearInterval(timer);
          timer = undefined;
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(t);
    return () => {
      observer.disconnect();
      if (timer) window.clearInterval(timer);
    };
  }, []);
  return null;
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} — ${siteConfig.tagline}`}
      description="Act is a TypeScript-first event sourcing framework with composable state machines, reactions, projections, and adapters for Postgres and SQLite."
    >
      <BrowserOnly>{() => <AnimatedT />}</BrowserOnly>
      <main className={styles.main}>
        <Hero />
        <Quickstart />
        <Sandboxes />
        <CompositionPatterns />
        <Features />
        <FinalCta />
      </main>
    </Layout>
  );
}
