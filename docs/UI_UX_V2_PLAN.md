# Mecordxn8n Control Center — UI/UX V2 Plan

## Objective

Turn the current functional Control Center into a professional, compact, evidence-first product UI that feels purpose-built for engineering and operations—not like an admin template and not like an AI-generated dashboard.

The product promise should be visible in the interaction model:

**Problem → Proof → Repair → Revenue**

The UI must make authorization, evidence, human approval, execution state, and business outcome obvious at every step.

## Current UI audit

The existing console is useful and already exposes the product surface, but it has reached the point where structure—not more cards—is the limiting factor.

### What is working

- clean light-mode visual direction;
- explicit workspace selector;
- clear human-approval terminology;
- simple status chips and compact metrics;
- no decorative AI/neon styling;
- secure server-rendered static shell with strong CSP;
- dedicated Launch flow;
- customer and operator surfaces already exist;
- common formatting and API helpers are centralized.

### Main UX problems

1. **Flat navigation is too wide.**
   The sidebar currently exposes Overview, Launch, Targets, Findings, Approvals, Pipeline, Operations, Integrations, Team & Access, Audit, and Operator at the same hierarchy level.

2. **The product lifecycle is not the navigation model.**
   The user should move naturally through Problem → Proof → Repair → Revenue, but the current information architecture is primarily resource/category based.

3. **Important entities do not have durable detail routes.**
   Target/finding/approval/report actions are mostly table + modal interactions. There are no deep-linkable entity pages, browser history, breadcrumbs, or persistent context.

4. **Evidence is not visually dominant enough.**
   Mecordxn8n's differentiator is verified proof. Screenshots, reproduction evidence, request/runtime information, verification confidence, and before/after proof should be first-class—not hidden behind generic rows.

5. **Failure handling is reactive rather than operational.**
   The hardened client now has timeouts, safe GET retries, degraded/offline state, and retry actions, but the product still needs stale-data indicators, partial-data states, dead-letter recovery UX, and clear remediation paths.

6. **Large tables need product-grade controls.**
   Findings, jobs, approvals, targets, audit, and pipeline need consistent search, filtering, sorting, density, saved views, pagination, selection, and export behavior.

7. **High-risk actions need stronger visual hierarchy.**
   Authorization replacement, revocation, report release, remediation approval, integration secret changes, and workspace deletion should look and behave differently from ordinary actions.

8. **Role-aware UX is incomplete.**
   Users should not discover permissions only after a 403. The UI should show read-only state, why an action is unavailable, and which role/approval is required.

9. **The frontend has become a monolith.**
   `web/console/app.js` is already ~900 lines. Continuing to add features in one file will make state races, inconsistent interactions, and regressions more likely.

10. **The visual system needs a deliberate density model.**
    Current primitives are useful, but the product needs standard sizes for rows, panels, drawers, typography, spacing, status semantics, and responsive behavior.

---

## Product design principles

### 1. Evidence first

Whenever a user opens a finding, the first visual question is:

> What happened, and how do we know?

Show proof before recommendations.

### 2. Authorization is always visible

Every target/detail page should show a persistent authorization badge:

- Public QA
- Bug bounty
- Client authorized
- Do not test
- Expiring soon
- Revoked

Source-remediation capability must be visible separately from ownership verification.

### 3. Human gates feel intentional

Approvals are not warning dialogs. They are a core product object with:

- request origin;
- requested action;
- evidence;
- scope;
- cost/risk;
- expiry;
- authorization state;
- approve/reject decision history.

### 4. Compact, not cramped

Use a dense professional layout similar in information efficiency to GitHub/Linear/Vercel-style tools, while keeping larger evidence media readable.

Avoid:
- oversized hero sections;
- giant empty cards;
- excessive rounded containers;
- neon gradients;
- decorative AI imagery;
- unnecessary glass effects;
- animations that delay work.

### 5. Progressive disclosure

The default view answers the next decision. Raw technical detail remains one click away.

### 6. Failure states are product states

A failed worker, expired authorization, stale monitor, dead-letter integration, or billing block should produce a guided recovery state, not merely a red label.

### 7. Every important object is deep-linkable

Targets, findings, approvals, reports, jobs, regressions, opportunities, integrations, and members get stable URLs.

---

# Information architecture

## Primary navigation

Replace the current flat 10–11 item sidebar with five primary areas.

### Home

Workspace-level pulse and action queue.

Contains:
- health;
- urgent approvals;
- open high-severity verified findings;
- active regressions;
- first-value/onboarding state;
- revenue/service pulse;
- degraded integrations;
- recent activity.

### Engineering

Contains:
- Targets
- Findings
- Regressions
- Runs / Jobs
- Evidence
- Reports

This is the Problem → Proof surface.

### Repair

Contains:
- Approval Inbox
- Repair Queue
- Remediation history
- Before/after verification
- Repair intelligence

This is the Proof → Repair surface.

### Revenue

Contains:
- Opportunities
- Proposals
- Outreach approvals/actions
- Revenue events
- Services / renewals

This is the Repair → Revenue surface.

### Workspace

Contains:
- Integrations
- Team & roles
- API keys
- Authorization settings
- Billing
- Retention
- Audit

Platform Operator is not shown as a normal workspace navigation item. It appears as a separate operator switch only for platform operators.

---

# Global shell

## Left rail

Width: ~232px desktop.

Structure:
- Mecordxn8n logo
- workspace switcher
- five primary navigation groups
- collapsed secondary workspace section
- help/docs
- user/account menu

Support compact collapse to icon rail.

## Top context bar

Persistent 48–52px bar containing:

- breadcrumb / current entity;
- global search / command palette;
- authorization state when target-scoped;
- environment/health state;
- notifications;
- primary action.

Avoid repeating large page titles if breadcrumb already supplies context.

## Command palette

Keyboard shortcut: `Ctrl/Cmd + K`.

Commands:
- jump to target;
- jump to finding;
- open approval;
- create target;
- run assessment;
- open integration;
- invite member;
- view failed jobs;
- switch workspace.

Search never exposes cross-workspace results.

---

# Core screens

## 1. Home

### Top row

Four compact decision metrics:
- verified findings needing action;
- approvals waiting;
- active regressions;
- workspace health.

Do not lead with total target count.

### Action queue

One ordered list of the next useful actions:

1. approval expiring;
2. failed/dead-letter runtime;
3. high-severity verified finding;
4. authorization expiring;
5. renewal due;
6. onboarding next step.

Each item has one obvious CTA.

### Operating pulse

Compact time-series/sparkline-ready region:
- successful vs failed jobs;
- verification rate;
- repair success;
- integration delivery health.

### Revenue/service strip

Small, not dominant for engineering users:
- received revenue;
- open opportunities;
- active services;
- renewal due.

---

## 2. Target detail

Route:
`/console/targets/:targetId`

Header:
- organization;
- canonical hostname;
- health;
- authorization mode;
- ownership verification;
- source-remediation capability;
- monitoring state;
- last successful assessment.

Tabs:
- Overview
- Findings
- Runs
- Monitoring
- Authorization
- Reports
- Activity

### Authorization panel

Make trust state understandable at a glance.

Show:
- ownership verified / not verified;
- active authorization;
- allowed capabilities;
- exact allowed hosts;
- evidence reference;
- expiry countdown;
- granted/replaced/revoked timeline.

Danger actions live in a dedicated bordered section.

---

## 3. Finding detail — flagship screen

Route:
`/console/findings/:findingId`

This should become the strongest screen in the product.

### Three-column desktop layout

**Left — finding context**
- severity;
- verified/unverified state;
- confidence;
- category;
- affected route;
- occurrences;
- first/last seen;
- regression state.

**Center — proof**
- screenshot/evidence viewer;
- reproduction result;
- browser/network/runtime evidence;
- verification comparison;
- before/after evidence after repair.

**Right — decision**
- business impact;
- priority;
- repair eligibility;
- authorization state;
- approval state;
- estimated cost;
- CTA: Verify / Request repair / View repair.

### Evidence viewer

Support:
- screenshots;
- console events;
- failed requests;
- response metadata;
- timing/performance observations;
- accessibility evidence;
- diff/before-after.

Evidence sections are typed and collapsible.

Raw JSON should be secondary.

---

## 4. Approval Inbox

Route:
`/console/approvals`

This is a queue, not a generic table.

Group by:
- source remediation;
- report release;
- outbound commercial action.

Each approval row/card shows:
- requested action;
- target;
- evidence summary;
- current authorization;
- requester;
- age / expiry;
- risk/cost;
- conflict state.

### Approval detail drawer/page

Approve/reject only after:
- current authorization is visible;
- affected target/finding is visible;
- evidence link is available;
- expiry is visible.

Confirmation wording must describe the actual action, not generic “Are you sure?”

---

## 5. Runs / Operations

Route:
`/console/runs`

Unified runtime view for:
- queued;
- running;
- retrying;
- succeeded;
- failed;
- dead-letter.

Columns:
- state;
- capability;
- target;
- worker;
- attempt;
- duration;
- cost units;
- created;
- last heartbeat.

Failure detail:
- safe error code;
- retry eligibility;
- authorization state;
- lease history;
- linked finding/report;
- recovery CTA.

Never expose secrets or raw MCP responses.

---

## 6. Repair

Repair page is lifecycle-oriented.

Stages:
- eligible;
- awaiting approval;
- queued;
- executing;
- verifying;
- succeeded;
- failed / aborted.

For a completed repair show:
- root cause summary;
- changed-system summary;
- tests;
- before proof;
- after proof;
- regression result;
- approval identity;
- authorization at execution.

---

## 7. Revenue

Use a compact kanban/list toggle.

Stages:
- New
- Qualified
- Engaged
- Proposal
- Negotiating
- Won
- Lost / Paused

Do not make money the visual center of the engineering workspace.

Opportunity detail connects:
verified finding → report → approved contact → response → revenue events → service.

---

## 8. Integrations

Use provider cards only at the top level.

Each connection detail shows:
- provider;
- state;
- subscribed events;
- last successful delivery;
- retrying count;
- dead-letter count;
- webhook verification state;
- secret configured (never secret value).

Dead-letter deliveries get a dedicated recovery queue.

---

## 9. Team & Access

Separate:
- Members
- Invites
- API keys
- Sessions

Show role capability descriptions inline.

API keys:
- prefix;
- scopes;
- rate limit;
- last used;
- expiry;
- revoke.

Never render the secret again after creation.

---

# Failure UX model

Every asynchronous view should support six states:

1. **Loading**
2. **Ready**
3. **Empty**
4. **Partial**
5. **Degraded**
6. **Failed**

## Partial data

If one panel fails but others succeed, keep successful data visible and show a local retry for the failed section.

Do not blank an entire page because one secondary request failed.

## Staleness

Every operational view should have:
- fetched-at timestamp;
- stale threshold;
- visible “stale” state;
- manual refresh.

## Mutation failures

Never auto-retry:
- approvals;
- billing;
- authorization changes;
- report release;
- remediation requests;
- secret changes;
- deletion/revocation.

Show:
- what failed;
- whether the server may have accepted the action;
- safe next action;
- idempotency/reference ID when available.

## Runtime failures

Use a consistent recovery block:

**What failed**
safe code + stage

**Impact**
what did not complete

**What Mecord will do**
retry / dead-letter / blocked

**What you can do**
retry, reauthorize, inspect evidence, fix integration, contact admin

---

# Design system

## Visual direction

Professional light UI with high information density.

### Base palette

Use neutral surfaces:
- canvas: near-white
- surface: white
- secondary surface: subtle cool gray
- borders: neutral gray

One primary accent only.

Suggested semantic roles:
- accent: blue
- success: green
- warning: amber
- danger: red
- informational: neutral/blue

No gradients required.

## Typography

Use system font stack initially to avoid font-file/shipping complexity.

Scale:
- 12px metadata
- 13px compact table
- 14px body/control
- 16px section title
- 20–24px entity/page title
- 28px max for exceptional onboarding/auth moments

Avoid giant dashboard headings.

## Spacing

4px base grid.

Preferred:
- 4
- 8
- 12
- 16
- 24
- 32

Default panel padding: 16px.

## Radius

Keep restrained:
- controls: 6px
- cards/panels: 8px
- pills: full radius only for statuses/tags

## Shadows

Almost none.

Use border hierarchy first.

## Tables

Three density modes are unnecessary. Choose one professional compact default:
- row height 40–44px;
- sticky header;
- horizontal overflow only when required;
- first column sticky for wide technical tables.

## Status

Never rely on color alone.

Every status uses:
- icon/shape;
- text;
- optional semantic color.

---

# Interaction model

## Drawers vs modals

Use modal dialogs only for short decisions/forms.

Use a right-side drawer for:
- evidence preview;
- run detail;
- integration delivery;
- quick approval context.

Use full routes for:
- target detail;
- finding detail;
- repair detail;
- opportunity detail;
- report detail.

## Keyboard

Support:
- `/` global search
- `g h` Home
- `g f` Findings
- `g a` Approvals
- `g r` Repair
- `Ctrl/Cmd+K` command palette
- `Esc` close drawer/modal

Do not hijack common browser shortcuts.

## Destructive actions

Require typed confirmation only for:
- workspace deletion;
- irreversible data deletion.

Ordinary revocation uses clear confirmation + consequence summary, not typing friction.

---

# Responsive behavior

## Desktop ≥ 1200px

Full rail + content + optional evidence/decision side panel.

## Tablet 768–1199px

Collapsible rail.
Two-column finding layout.
Right detail panel becomes drawer.

## Mobile < 768px

Bottom/compact navigation for Home / Engineering / Approvals / Workspace.
Tables become structured rows.
Evidence is full-width.
No horizontal desktop dashboard squeezing.

Mobile is for triage/approval/status first—not full engineering analysis.

---

# Frontend architecture plan

Do not build more features inside the current single `app.js`.

Refactor the existing console in place; do not maintain two parallel consoles.

Recommended structure:

```text
web/console/
  index.html
  styles/
    tokens.css
    base.css
    layout.css
    components.css
    views.css
  core/
    api.js
    auth.js
    router.js
    state.js
    format.js
    permissions.js
  components/
    shell.js
    table.js
    status.js
    drawer.js
    dialog.js
    empty-state.js
    error-state.js
    command-palette.js
  views/
    home.js
    launch.js
    targets.js
    target-detail.js
    findings.js
    finding-detail.js
    approvals.js
    repairs.js
    runs.js
    revenue.js
    integrations.js
    workspace.js
    operator.js
  app.js
```

Stay with browser-native ES modules initially.

Reasons:
- no framework rewrite risk;
- no second frontend;
- no new build/runtime dependency required;
- preserves current CSP;
- preserves static serving model;
- easy incremental migration.

If the UI later requires complex local state/data virtualization, reassess framework adoption after the V2 interaction model is stable.

---

# Router

Introduce History API routing.

Examples:

```text
/console
/console/home
/console/targets
/console/targets/:id
/console/findings
/console/findings/:id
/console/approvals
/console/approvals/:id
/console/repairs
/console/repairs/:id
/console/runs
/console/revenue
/console/integrations
/console/workspace/access
/console/operator
```

The server should safely return the console shell for recognized `/console/*` routes.

Workspace ID stays in authenticated state, not in public query strings unless needed for explicit workspace switching.

---

# Data loading architecture

Each page declares its data dependencies.

Use:
- AbortController per navigation;
- request timeout;
- GET-only bounded retry;
- independent section loading;
- stale response rejection using navigation epoch;
- no mutation replay;
- small in-memory cache for read-mostly reference data.

The UI must never render a late response from a previous workspace/view over the current view.

---

# Permission-aware UX

Create a UI permission map from:
- workspace role;
- API-key scopes;
- subscription state;
- authorization state.

Buttons should be:
- visible + enabled when permitted;
- visible + disabled with explanation when contextually useful;
- hidden only when the feature itself is irrelevant.

Examples:
- Viewer sees “Request repair” disabled with “Operator role required.”
- Past-due owner sees engineering mutations disabled but Billing remains available.
- Source repair remains disabled until domain ownership + client authorization + capability are present.

Backend remains authoritative.

---

# Accessibility baseline

Target WCAG 2.2 AA behavior.

Required:
- visible focus rings;
- logical tab order;
- semantic headings;
- aria-current navigation;
- modal focus trapping;
- drawer focus management;
- keyboard-close behavior;
- status text in addition to color;
- sufficient contrast;
- reduced-motion support;
- touch targets ≥ 40px on mobile.

Add automated browser checks for:
- keyboard navigation;
- focus restoration;
- landmarks;
- obvious label/name failures.

---

# Performance targets

For the Control Center shell:

- first HTML response: < 300 ms server-side under normal deployment conditions;
- initial JS/CSS payload: keep small enough to load comfortably on mobile;
- view switch with cached shell: immediate skeleton, useful content target < 1 s on normal API latency;
- no full page reload for navigation;
- large tables paginated/virtualized before DOM size becomes a problem;
- screenshots/evidence lazy-loaded;
- never block the entire page on a secondary panel.

---

# Implementation phases

## Phase U0 — architecture + tokens

- split `app.js`;
- split CSS;
- add router;
- add navigation abort/stale-response protection;
- introduce design tokens;
- build shell primitives;
- preserve existing behavior.

Acceptance: feature parity, no visual regression blocker, all current tests green.

## Phase U1 — shell + Home

- new 5-area information architecture;
- workspace switcher;
- command palette;
- compact top context bar;
- action queue;
- health pulse;
- role/subscription state.

## Phase U2 — Engineering flagship

- targets list/detail;
- findings list/detail;
- evidence viewer;
- runs;
- regressions;
- reports;
- deep links and breadcrumbs.

This phase produces the strongest “first impression” screen: Finding Detail.

## Phase U3 — Approval + Repair

- decision-centric approval inbox;
- repair lifecycle;
- before/after proof;
- explicit risk/authorization context;
- recovery states.

## Phase U4 — Revenue + integrations

- compact opportunity pipeline;
- commercial lifecycle detail;
- integrations health/delivery/dead-letter UX;
- services/renewals.

## Phase U5 — Workspace + operator

- team/access;
- API keys;
- billing;
- retention;
- audit;
- platform operator fleet view.

## Phase U6 — polish/certification

- responsive/mobile triage;
- keyboard shortcuts;
- accessibility pass;
- empty/loading/degraded/partial states;
- visual regression screenshots;
- browser acceptance tests;
- performance budget;
- error-state chaos testing.

---

# UI acceptance criteria

Do not call UI V2 complete until:

- every primary entity has a stable route;
- browser back/forward works;
- workspace switching cannot render stale data;
- no important workflow depends on a generic raw JSON modal;
- finding evidence is visually first-class;
- all high-risk actions expose authorization/impact context;
- approval queue is usable without opening every row;
- customer and platform-operator navigation are clearly separated;
- every major page has loading/empty/partial/degraded/failed states;
- offline/transient GET failures recover cleanly;
- mutations are never auto-replayed;
- mobile approvals and status triage are usable;
- WCAG-focused browser checks pass;
- no dark/neon/AI-slop treatment;
- no giant hero/dashboard whitespace;
- existing authorization and approval security boundaries remain server-enforced;
- CI, Security, and Release Gate remain green.

---

# Recommended build order

The highest-impact order is:

1. **Frontend architecture split + router**
2. **New shell/navigation**
3. **Finding Detail + evidence viewer**
4. **Approval Inbox**
5. **Target Detail / authorization**
6. **Runs + failure recovery**
7. **Repair lifecycle**
8. **Home**
9. **Revenue**
10. **Integrations / Team / Billing / Audit**
11. **Mobile + accessibility + visual certification**

The first screenshot a customer should remember is not a generic dashboard.

It should be a verified finding with clear proof, business impact, authorization state, and a safe next action.
