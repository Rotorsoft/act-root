import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import BrowserOnly from "@docusaurus/BrowserOnly";
import Layout from "@theme/Layout";
import CodeBlock from "@theme/CodeBlock";
import type { JSX } from "react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import sdk from "@stackblitz/sdk";
import styles from "./index.module.css";
const QUICKSTART_INSTALL = `npm install @rotorsoft/act zod`;

// The verbatim quickstart source is read at build time in docusaurus.config.ts
// (as raw .ts text, not transpiled) and threaded through siteConfig.customFields;
// the Quickstart component drops the leading `//` header so only the example shows.

const GENERATED_TRANSPORTS_CODE = `import { trpc } from "@rotorsoft/act-http/trpc";
import { hono } from "@rotorsoft/act-http/hono";
import { openapi } from "@rotorsoft/act-http/openapi";

// One Act, three transports — same actor / stream seams,
// same ApiError envelope, no codegen.
const tRouter = trpc(app, { actor, stream });
const restApi = hono(app, { actor, stream });
const apiDoc  = openapi(app, {
  info: { title: "Wolfdesk API", version: "1.0.0" },
});`;

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
    title: "Event Sourcing",
    body: "State is folded from events with pure patch functions, so any stream can be replayed to rebuild it.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
  },
  {
    title: "Composable Builders",
    body: "States, slices and projections are built with typed builders and composed into one app. No classes.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
  },
  {
    title: "Typed End to End",
    body: "Action, event and state types are inferred from Zod schemas, and the same schemas validate at runtime.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    title: "Reactions",
    body: "Reactions run after events are committed, with retries, backoff and timers handled by the framework.",
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
    title: "Store Adapters",
    body: "Postgres and SQLite stores, plus an in-memory store for tests. The store is set in one call.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 5v14c0 1.66-4.03 3-9 3s-9-1.34-9-3V5" />
        <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
      </svg>
    ),
  },
  {
    title: "Small Footprint",
    body: "The core package depends only on its own patch utility, with Zod as a peer. No code generation.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    ),
  },
];

type SandboxProps = {
  title: string;
  repoSlug: string;
  openFile: string;
  startScript: string;
  open: string;
  source: string;
  blurb: string;
};

function Sandbox({ title, repoSlug, openFile, startScript, open, source, blurb }: SandboxProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded) return;
    const el = wrapRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setLoaded(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setLoaded(true);
          obs.disconnect();
        }
      },
      { rootMargin: "300px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loaded]);

  // The StackBlitz SDK creates and manages the iframe itself,
  // including the credentialless attribute and cross-origin isolation
  // hints that hand-rolled iframes can't reliably set through React.
  useEffect(() => {
    if (!loaded) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const mount = document.createElement("div");
    mount.style.width = "100%";
    mount.style.height = "100%";
    wrap.appendChild(mount);
    let cancelled = false;
    sdk
      .embedGithubProject(mount, repoSlug, {
        openFile,
        startScript,
        view: "default",
        terminalHeight: 55,
        hideNavigation: true,
        hideExplorer: true,
        theme: "dark",
        height: 540,
        forceEmbedLayout: true,
        clickToLoad: false,
        crossOriginIsolated: true,
      })
      .catch((err) => {
        if (!cancelled) console.error("StackBlitz embed failed", err);
      });
    return () => {
      cancelled = true;
      mount.remove();
    };
  }, [loaded, repoSlug, openFile, startScript]);

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
      <div ref={wrapRef} className={styles.sandboxFrameWrap}>
        {!loaded && (
          <div className={styles.sandboxPoster} aria-busy="true" aria-label={`Loading ${title} sandbox`}>
            <span className={styles.sandboxPosterIcon}>
              <svg width="56" height="56" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </span>
            <span className={styles.sandboxPosterTitle}>Booting sandbox…</span>
            <span className={styles.sandboxPosterHint}>StackBlitz boots when this section scrolls into view</span>
          </div>
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

function CopyInstall() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={styles.install}
      onClick={() => {
        navigator.clipboard
          ?.writeText(QUICKSTART_INSTALL)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => {});
      }}
      aria-label="Copy the install command"
    >
      <span className={styles.installPrompt} aria-hidden>
        $
      </span>
      <code>{QUICKSTART_INSTALL}</code>
      <span className={styles.installCopy}>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

// The docs theme toggle sets data-theme on <html>; the embedded player follows it.
function useSiteTheme(): string {
  const [theme, setTheme] = useState("dark");
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.dataset.theme === "light" ? "light" : "dark");
    read();
    const obs = new MutationObserver(read);
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

function Hero() {
  const docsUrl = useBaseUrl("/docs/intro");
  const frameUrl = useBaseUrl("/flows/wolfdesk.html");
  const galleryUrl = useBaseUrl("/flows/index.html");
  const guideUrl = useBaseUrl("/docs/guides/flow-animations");
  const colorMode = useSiteTheme();
  return (
    <header className={styles.hero}>
      <div className={styles.heroTop}>
        <div className={styles.heroBrand}>
          <img
            className={styles.heroIcon}
            src={useBaseUrl("/img/logo-dark.png")}
            alt=""
            aria-hidden="true"
          />
          <h1 className={styles.heroWordmark} aria-label="Act">
            <span className={styles.wA}>A</span>
            <span className={styles.wC}>c</span>
            <span className={`${styles.heroT} ${styles.wT}`}>t</span>
          </h1>
        </div>
        <p className={styles.formula} aria-label="Actions, State, Reactions">
          <span className={styles.fAction}>Actions</span>
          <span className={styles.fArrow}> → </span>
          <span className={styles.fState}>
            <b>{"{"}</b>State<b>{"}"}</b>
          </span>
          <span className={styles.fArrow}> ← </span>
          <span className={styles.fReaction}>Reactions</span>
        </p>
        <p className={styles.heroLede}>
          Fluent event sourcing for TypeScript. Declare actions, state and reactions with typed
          builders; Act stores the events, runs the reactions and keeps the projections up to date.
        </p>
        <div className={styles.heroCtas}>
          <Link className={`button button--primary button--lg ${styles.cta}`} to={docsUrl}>
            Get started
          </Link>
          <Link
            className={`button button--secondary button--lg ${styles.cta}`}
            href="https://github.com/rotorsoft/act-root"
          >
            GitHub
          </Link>
          <CopyInstall />
        </div>
      </div>

      <figure className={styles.stage}>
        <iframe
          key={colorMode}
          className={styles.stageFrame}
          src={`${frameUrl}#embed-${colorMode}`}
          title="WolfDesk ticket flows, animated from the app's own builders"
        />
        <figcaption className={styles.stageCaption}>
          <p>
            <b>WolfDesk, the ticketing example, drawn from its builders.</b> Each tab is a
            scripted walk through its flows: an action passes the state's checks, its event is
            stored, and the reactions and timers it triggers run next. The repo includes a Claude
            Code skill that makes the same page for your own app.
          </p>
          <div className={styles.linkRow}>
            <a className={styles.textLink} href={frameUrl}>
              Open full screen
            </a>
            <a className={styles.textLink} href={galleryUrl}>
              All animations
            </a>
            <Link className={styles.textLink} to={guideUrl}>
              How it's made
            </Link>
          </div>
        </figcaption>
      </figure>
    </header>
  );
}

function SectionHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.head}>
      <h2 className={styles.headTitle}>{title}</h2>
      <p className={styles.headSub}>{children}</p>
    </div>
  );
}

function Quickstart() {
  const getStartedUrl = useBaseUrl("/docs/intro");
  const { siteConfig } = useDocusaurusContext();
  const quickstartApp = (siteConfig.customFields?.quickstartSource as string)
    .replace(/^(?:\/\/.*\n)+\n?/, "")
    .trimEnd();
  return (
    <section className={styles.section}>
      <div className={styles.split}>
        <div className={styles.splitText}>
          <SectionHead title="Quickstart">
            A calculator with one state, one action and three events, on the in-memory store. Swap
            in the Postgres or SQLite store when you need persistence.
          </SectionHead>
          <ol className={styles.steps}>
            <li>
              <b>Install</b> <code>{QUICKSTART_INSTALL}</code>
            </li>
            <li>
              <b>Declare the state.</b> A Zod schema, the events it emits, how each event patches it,
              and the action that decides which event to emit.
            </li>
            <li>
              <b>Run it.</b> Every <code>app.do</code> appends to the log; <code>app.load</code>{" "}
              folds the stream back into state.
            </li>
          </ol>
          <Link className={`button button--primary ${styles.cta}`} to={getStartedUrl}>
            Read the guide
          </Link>
        </div>
        <div className={styles.codePanel}>
          <CodeBlock language="typescript" title="quickstart.ts">
            {quickstartApp}
          </CodeBlock>
        </div>
      </div>
    </section>
  );
}

function CompositionPatterns() {
  const [active, setActive] = useState<PatternId>("slices");
  const ids = Object.keys(PATTERNS) as PatternId[];
  const current = PATTERNS[active];
  return (
    <section className={styles.section}>
      <SectionHead title="Composition patterns">
        How larger models are put together, shown on WolfDesk. The full source is in{" "}
        <Link to="https://github.com/rotorsoft/act-root/tree/master/packages/wolfdesk/src">
          packages/wolfdesk
        </Link>
        .
      </SectionHead>
      <div className={styles.patterns}>
        <div className={styles.patternTabs} role="tablist" aria-orientation="vertical">
          {ids.map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={active === id}
              className={styles.patternTab}
              onClick={() => setActive(id)}
            >
              <span>{PATTERNS[id].tab}</span>
              <small>{PATTERNS[id].title}</small>
            </button>
          ))}
        </div>
        <div className={styles.patternBody} role="tabpanel">
          <p className={styles.patternBlurb}>{current.blurb}</p>
          <CodeBlock language="typescript">{current.code}</CodeBlock>
          <p className={styles.patternNote}>{current.note}</p>
        </div>
      </div>
    </section>
  );
}

function GeneratedTransports() {
  const guideUrl = useBaseUrl("/docs/guides/auto-generated-api");
  return (
    <section className={styles.section}>
      <div className={styles.split}>
        <div className={styles.splitText}>
          <SectionHead title="Generated APIs">
            <code>@rotorsoft/act-http</code> reads the actions of a built app and creates a tRPC
            router, Hono REST routes and an OpenAPI 3.1 document from them, with the same actor and
            stream handling and the same error shape on each.
          </SectionHead>
          <dl className={styles.transports}>
            <div>
              <dt>tRPC</dt>
              <dd>
                A typed client from <code>typeof router</code>, on any fetch runtime.
              </dd>
            </div>
            <div>
              <dt>Hono REST</dt>
              <dd>
                <code>POST /api/actions/&lt;name&gt;</code> on Node, Bun, Workers, Vercel Edge or
                Lambda.
              </dd>
            </div>
            <div>
              <dt>OpenAPI 3.1</dt>
              <dd>A plain document of the live surface. Pair it with Scalar or Redoc.</dd>
            </div>
          </dl>
          <Link className={styles.textLink} to={guideUrl}>
            Read the API guide
          </Link>
        </div>
        <div className={styles.codePanel}>
          <CodeBlock language="typescript">{GENERATED_TRANSPORTS_CODE}</CodeBlock>
        </div>
      </div>
    </section>
  );
}

const SANDBOXES: SandboxProps[] = [
  {
    title: "Calculator with lanes",
    blurb:
      "Random keypresses commit events. A digit-board projection drains on the “board” lane and a per-stream result projection on the “result” lane; every drain cycle in the trace is tagged with its lane.",
    repoSlug: "rotorsoft/act-root/tree/master/packages/calculator",
    openFile: "src/main.ts",
    startScript: "dev:stackblitz",
    open: "https://stackblitz.com/github/rotorsoft/act-root/tree/master/packages/calculator?file=src/main.ts&startScript=dev%3Astackblitz",
    source: "https://github.com/rotorsoft/act-root/tree/master/packages/calculator/src",
  },
  {
    title: "Load test on three lanes",
    blurb:
      "A todo load test split across “creates”, “updates” and “deletes” lanes, each with its own lease and cadence. Each cycle prints a lane by frontier table, so you can watch every lane catch up at its own pace.",
    repoSlug: "rotorsoft/act-root/tree/master/performance/act-performance",
    openFile: "src/index.ts",
    startScript: "start:stackblitz",
    open: "https://stackblitz.com/github/rotorsoft/act-root/tree/master/performance/act-performance?file=src/index.ts&startScript=start%3Astackblitz",
    source: "https://github.com/rotorsoft/act-root/tree/master/performance/act-performance/src",
  },
];

function Sandboxes() {
  const [active, setActive] = useState(0);
  return (
    <BrowserOnly fallback={null}>
      {() => {
        const isChrome = /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
        const isDesktop = window.innerWidth > 900 && !/Mobi|Android/i.test(navigator.userAgent);
        if (!isChrome || !isDesktop) return null;
        return (
          <section className={styles.section}>
            <SectionHead title="Console output">
              Two example projects running in StackBlitz, so you can watch what Act logs as it
              works. They start when you scroll here, in desktop Chrome only.
            </SectionHead>
            <div className={styles.sandboxTabs} role="tablist">
              {SANDBOXES.map((s, i) => (
                <button
                  key={s.title}
                  type="button"
                  role="tab"
                  aria-selected={active === i}
                  className={styles.sandboxTab}
                  onClick={() => setActive(i)}
                >
                  {s.title}
                </button>
              ))}
            </div>
            <Sandbox key={SANDBOXES[active].title} {...SANDBOXES[active]} />
          </section>
        );
      }}
    </BrowserOnly>
  );
}

function Features() {
  return (
    <section className={styles.section}>
      <SectionHead title="Features">
        What the framework gives you, in short.
      </SectionHead>
      <div className={styles.features}>
        {FEATURES.map((f) => (
          <div key={f.title} className={styles.feature}>
            <span className={styles.featureIcon} aria-hidden>
              {f.icon}
            </span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
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
    <section className={`${styles.section} ${styles.final}`}>
      <div>
        <h2 className={styles.headTitle}>Get started</h2>
        <p className={styles.headSub}>
          Begin with the quickstart, then read the calculator and WolfDesk examples.
        </p>
      </div>
      <div className={styles.heroCtas}>
        <Link className={`button button--primary button--lg ${styles.cta}`} to={docsUrl}>
          Read the docs
        </Link>
        <Link className={`button button--secondary button--lg ${styles.cta}`} to={archUrl}>
          Architecture
        </Link>
      </div>
    </section>
  );
}

function AnimatedT() {
  // Swing the wordmark's "t" every 12 seconds while the hero is visible.
  useEffect(() => {
    const t = document.querySelector(`.${styles.heroT}`);
    if (!t || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: number | undefined;
    const trigger = () => {
      t.classList.remove(styles.heroTAnimate);
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
        <CompositionPatterns />
        <GeneratedTransports />
        <Sandboxes />
        <Features />
        <FinalCta />
      </main>
    </Layout>
  );
}
