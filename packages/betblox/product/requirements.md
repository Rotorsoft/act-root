# BetBlox — Requirements & Task List

## Functional Requirements

- [ ] Users can create prediction polls on blockchain (with wallet)
- [ ] Users can vote on open polls (with wallet, pay entry fee)
- [ ] Polls close at a set time; outcome is resolved (oracle/manual)
- [ ] Winnings are distributed to correct voters (minus 10% house fee)
- [ ] All actions are on-chain; backend listens to events and updates projections
- [ ] UI displays real-time poll data, voting, and results

## Technical Requirements

- [ ] **Blockchain smart contract** (Solana, Anchor, future chains)
- [ ] **Backend**: Node.js, event listener, Act projections, Drizzle ORM, trpc API
- [ ] **Database**: PostgreSQL (Neon for beta)
- [ ] **Frontend**: Next.js, trpc, wallet adapter, elegant UI
- [ ] **Testing**: Unit, integration, contract, and e2e tests
- [ ] **CI/CD**: GitHub Actions, deploy to Vercel (UI), Railway/Neon (backend/db)
- [ ] **Dev**: Local Solana validator, Anchor, Docker (optional)

## Task List

### 0. Initial Setup

- [x] Create `/packages/betblox` with scaffold.
- [x] Initialize monorepo workspace (pnpm, turbo, or similar).
- [x] Add README with architecture diagram and setup instructions.

### 1. Blockchain Smart Contract (Rust, Anchor)

- [ ] Install Rust, Solana CLI, Anchor.
- [ ] Scaffold Anchor program for polls.
- [ ] Implement instructions: create_poll, vote, close_poll, claim_winnings.
- [ ] Emit events/logs for all actions.
- [ ] Write contract unit tests (Anchor).
- [ ] Add test scripts for local validator.
- [ ] Document contract API and deployment steps.

### 2. Backend (Node.js)

- [x] Scaffold backend (TypeScript, pnpm).
- [x] Install dependencies: solana/web3.js, Act, Drizzle, trpc, pg.
- [x] Add mock smart contract event emitter for local/dev.
- [x] Set up Drizzle models/migrations for projections.
- [x] Integrate projection logic into Fastify server (mock events are now projected to DB).
- [ ] Implement blockchain event listener (web3.js/Anchor client) (in progress).
- [ ] Map on-chain events to Act events, update projections in PG (in progress).
- [x] Expose trpc API for UI.
- [ ] Add unit/integration tests for event handling and projections (in progress).
- [x] Add Docker Compose for backend Postgres (local dev).
- [ ] Add Dockerfile for backend (optional).
- [x] Document backend setup and local dev in README.

### 3. Act Projections

- [x] Define Act event types for PollCreated, VoteCast, PollClosed, WinningsClaimed.
- [x] Implement projection logic (reactions) to update Drizzle/PG.
- [ ] Add tests for projection logic (in progress).

### 4. Database (Postgres)

- [x] Set up local Postgres (Docker Compose for betblox).
- [x] Configure Drizzle migrations for betblox.
- [ ] Add Neon free-tier setup instructions for beta (in progress).

### 5. Frontend (Next.js, trpc)

- [x] Scaffold Next.js app in `/src/ui`.
- [x] Install dependencies: trpc, Tailwind (for UI), etc.
- [x] Implement poll creation, voting, results, claim winnings.
- [x] Connect to backend via trpc.
- [x] Add elegant, responsive UI.
- [ ] Install wallet adapter and implement wallet connect (in progress).
- [x] Add modern navigation bar on all pages.
- [x] Add pagination to API endpoints and UI.
- [x] Handle nullable fields gracefully in UI.
- [x] Add reusable, modern-styled components.
- [ ] Add unit/component tests (Jest/React Testing Library) (in progress).
- [ ] Add e2e tests (Playwright/Cypress) (in progress).
- [x] Document frontend setup and local dev in README.

### 6. Dev Environment & Local Testing

- [x] Add dev script for UI.
- [x] Add `.env.example` for betblox.
- [x] Write scripts for:
  - Running backend and frontend in dev mode
  - Running migrations
- [ ] Write scripts for:
  - Starting local Solana validator (in progress)
  - Deploying contract locally (in progress)
  - Running all tests (in progress)
- [ ] Add Makefile or npm scripts for common tasks (in progress).

### 7. CI/CD

- [ ] Set up GitHub Actions workflow (in progress):
  - Lint, typecheck, test all packages
  - Build and deploy backend to Railway (or similar)
  - Build and deploy frontend to Vercel
  - Run contract tests on local validator
- [ ] Add code coverage reporting (Codecov/Coveralls) (in progress).
- [ ] Add status badges to README (in progress).

### 8. Beta Deployment

- [ ] Deploy backend to Railway (free tier) or similar (in progress).
- [ ] Deploy frontend to Vercel (set trpc endpoint env var) (in progress).
- [ ] Deploy Postgres to Neon (free tier) (in progress).
- [ ] Deploy blockchain contract to devnet/testnet (in progress).
- [ ] Document beta URLs and test wallet setup (in progress).

### 9. Documentation

- [x] Write comprehensive README (setup, architecture, usage) for betblox.
- [ ] Add API docs for contract, backend, and trpc endpoints (in progress).
- [ ] Add developer guide for contributing, testing, and deployment (in progress).

### 10. Stretch/Polish

- [ ] Add analytics, notifications, or Discord integration.
- [ ] Add admin/oracle UI for resolving outcomes.
- [ ] Add support for multiple tokens (SOL, USDC, etc).
- [ ] Add mobile-friendly UI.

---

## Improvements & New Features from Refactor

- [x] **All event schemas consolidated** in a single file.
- [x] **Legacy endpoints and code paths removed** for poll creation/voting.
- [x] **Backend router refactored** as a "mocked blockchain" and commits events directly to the Act store.
- [x] **UI blockchain abstraction** (`blockchainClient`) created for all blockchain actions, with path aliasing.
- [x] **AI-powered poll suggestion** in poll creation UI.
- [x] **User can set poll close time** in the UI.
- [x] **Support for all event types** (PollCreated, VoteCast, PollClosed, WinningsClaimed) in both backend and UI abstraction.
- [x] **TypeScript project references and path aliases** set up for monorepo compatibility.
- [x] **UI and backend ready for easy swap to real blockchain integration**.
- [x] **All code paths and imports updated** to match the new architecture.

---

_Note: Items marked (in progress) are partially complete or ready for extension._

## Installation & Local Testing Steps

1. **Install prerequisites:**
   - Rust, Solana CLI, Anchor, Node.js, pnpm, Docker (optional)
2. **Clone repo & bootstrap:**
   - `pnpm install`
3. **Start local Solana validator:**
   - `solana-test-validator`
4. **Deploy contract locally:**
   - `anchor build && anchor deploy`
5. **Run backend & frontend:**
   - `pnpm dev` (or separate scripts for each)
6. **Run tests:**
   - `pnpm test` (all packages)
7. **Check code coverage:**
   - `pnpm coverage`
8. **Run migrations:**
   - `pnpm drizzle:migrate`
9. **Connect wallet (Phantom, Solflare) to local/testnet**

## Beta Deployment Steps

- **Backend:** Deploy to Railway (connect Neon PG, set env vars)
- **Frontend:** Deploy to Vercel (set trpc endpoint env var)
- **Database:** Deploy to Neon, run migrations
- **Blockchain Contract:** Deploy to devnet/testnet, update program ID in backend/frontend
- **Update README with beta URLs and test instructions**
