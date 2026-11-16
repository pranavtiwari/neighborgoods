# Go-To-Market Plan — Neighborhood Circles & Universal Circles

Status: Draft v1 · Owner: Growth · Companion docs: `docs/rollout-plan.md`, `docs/launch-playbook.md`, `Specs/WORLD_OF_BOOKS.md`

---

## 1. The one strategic call

We are launching **two products with two different GTM motions**, not one product with two audience segments.

| | **Neighborhood Circles** (e.g. Palm Meadows) | **Universal Circles** (e.g. Book Shelf / World of Books) |
| :--- | :--- | :--- |
| What it is | A private, high-trust commons for a bounded geography | An open, global catalogue that circulates locally |
| Growth engine | **Supply-led, organizer-led, invite-only** | **Demand-led, search-led, partner-fed** |
| Cold-start unit | One street / one apartment complex | One metro's book inventory |
| Primary channel | In-person + WhatsApp/Signal + QR flyers | SEO/book search intent + reading communities + bulk import partners |
| Buyer/user | Households; the **Circle Admin** is the buyer | Readers; the **Librarian** is the curator |
| Identity | "My neighbors" | "My shelf is part of a library" |
| Success gate | ≥25 households, ≥60 listings, ≥15 completed shares/30d | ≥300 titles, ≥25 concurrent loans, ≥25% want-list fill |

**The rule that governs every launch decision:** *the catalogue can be global, but circulation must be local.* Never market a universal circle in a city where we have not seeded copies — an empty search result is worse than no search result (`Specs/WORLD_OF_BOOKS.md` §0, §6).

**The second call:** launch both motions **in the same metro, in the same quarter**. Universal circles need local copies to clear; neighborhood circles need a reason to come back after the drill is returned. Books are that reason. This "city pod" strategy is the core of the plan.

---

## 2. Positioning

### Category we are creating
> **The modern commons** — a trusted local layer for borrowing, sharing, and gifting, with a universal catalogue for the things everyone wants but nobody wants to buy twice.

### Positioning statement
> For households who own far more than they use and readers who can't find the book they want nearby, **Share, Instead.** is the community sharing circle that turns a neighborhood's shelves, garages, and gardens into one trusted library — because it is invite-scoped, reputation-backed, and organized around real people, not anonymous listings.

### Competitive alternatives (what we must beat)

| Alternative | Why people use it | Our wedge |
| :--- | :--- | :--- |
| Buy new / own duplicates | Convenience, no coordination | "You need a ladder twice a year, not a ladder" |
| Facebook Marketplace / Nextdoor / Buy Nothing | Reach, familiarity | Structured borrowing lifecycle, due dates, reputation, no infinite feed |
| WhatsApp groups | Zero friction, existing trust | Inventory, search, request state, no lost messages |
| Public library | Free, trusted | Books the library doesn't stock; books that surface near you; everything else too |
| Little Free Libraries / book boxes | Charm, no signup | Tracked lending, wishlists, discovery, scale |

### Brand architecture (decision required)
The codebase uses **"Share, Instead."** as the user-facing brand and **"NeighborGoods"** internally; docs also use **"Universal Library"** and **"Book Shelf."** Recommended architecture:

- **Master brand:** *Share, Instead.*
- **Product surfaces:** *Neighborhood Circles* and *Universal Circles* (flagship: *Book Shelf*, formerly "World of Books")
- Retire "NeighborGoods" from any user-facing copy; keep it as the internal codename.

---

## 3. Target segments

### Neighborhood Circles
| Segment | Size signal | Why they adopt | Where to find them |
| :--- | :--- | :--- | :--- |
| **HOA / gated community boards** | 50–500 homes | Amenity without capex; engagement metric for the board | Board meetings, community managers |
| **Apartment / co-op buildings** | 30–300 units | Shared storage, moving churn, package-room culture | Building managers, resident councils |
| **New-build suburbs** | 40–200 homes, young families | People don't know neighbors yet; kids' gear is expensive | Facebook groups, school WhatsApp, moving-in events |
| **Existing community groups** | 20–100 members | Already have trust + a chat group; need better tooling | WhatsApp admins, RWA groups, church/community centers |

**Buyer:** the **Circle Admin** (organizer, not a consumer). The GTM is therefore a *community-organizer sales motion*: recruit one champion, arm them with a kit, let them invite their own circle.

### Universal Circles
| Segment | Size signal | Why they adopt | Where to find them |
| :--- | :--- | :--- | :--- |
| **Book clubs & reading groups** | 8–40 members | Social reading; shared wishlists; swaps | Meetup, libraries, WhatsApp, Bookstagram |
| **Parents of young readers** | Households with kids 3–12 | Picture books are read once and outgrown | Schools, preschools, parenting groups |
| **Students & recent grads** | Campus + transitory housing | Textbooks and set texts are expensive and disposable | Campus societies, departing-student drives |
| **Declutterers / movers** | Trigger event | Books are heavy, emotionally hard to bin | Moving-sale listings, "leaving the city" posts |
| **Institutional partners** | Libraries, schools, cafés | Footfall, CSR, community programming | Partnership outreach |

**Buyer:** the **Librarian** (curator) for institutional circles; the reader for organic ones.

---

## 4. Product packaging at launch

Free for everyone. No fees, deposits, or shipping in v0 — this is a trust and liquidity decision, not a monetization gap.

| Included | Deliberately excluded (v0) |
| :--- | :--- |
| Circles (neighborhood + universal), membership, roles | Payments, deposits, fines |
| Item + book listing, ISBN/Goodreads import, cover enrichment | Shipping / long-haul lending |
| Borrow lifecycle: request → approve → handoff → return | Hold queues / reservations |
| Chat scoped to item/circle, due-date reminders | Reviews (ratings only) |
| Want lists + "a copy surfaced near you" alerts | Global leaderboards |
| Reports, moderation queue, librarian tools | Ebook lending / DRM |

**Future monetization (Phase 3+, do not message now):** HOA/building SaaS seat for admins; partner programs with libraries and schools; optional donations to fund circle operations.

---

## 5. Motion A — Neighborhood Circles

**Goal:** prove that a bounded neighborhood can reach real sharing liquidity in 30 days, repeatably.

### 5.1 The offer
> *"Your neighborhood, on one shelf. Pledge two things, borrow everything else. Free, private, invite-only."*

The unit of activation is not a signup — it is **two items pledged**. Every asset, event, and message is designed to produce listings, not accounts.

### 5.2 Funnel & tactics

| Stage | Tactic | Target conversion |
| :--- | :--- | :--- |
| **Recruit the champion** | 1:1 outreach to HOA board / building manager / WhatsApp admin. 20-min call, show the seeded circle, offer "founding admin" status | 30% of conversations → champion |
| **Seed before inviting** | Champion + 2–3 co-leads pledge 30–50 high-utility items (ladder, drill, pressure washer, tent, folding tables) over one weekend | 40+ items before public invite |
| **Launch event** | "Coffee & Cataloging" table at the clubhouse/mailbox: laptops + QR codes, list an item in 30s, coffee paid by us | 15–25 households attend, 60% list |
| **Distribution** | WhatsApp/Signal invite video + `join-community.html?invite=[CODE]` link; QR flyers at mailbox/bulletin/gym; front-door hangers | 25 households in 14 days |
| **First share nudge** | Weekly feed post featuring one seasonal item ("Pressure washer season — 4 neighbors have one"); admin-scripted | ≥15 completed shares by day 30 |
| **Retention ritual** | Named monthly ritual ("First Saturday Swap") + monthly impact recap (items shared, money saved) | 60% 30-day return |

### 5.3 Champion kit (must be built)
- 1-page "Founding Admin" guide: roles, privacy, moderation, what good looks like.
- Pre-written WhatsApp/Signal invite copy + 30s video.
- Printable QR flyer + mailbox hanger (PDF).
- "Pledge 2" checklist and a seed-item list by home type.
- Launch-event runbook (90 minutes, 1 host, 1 helper).
- Monthly recap template (shared items, estimated $ saved, waste diverted).

### 5.4 Economics
CAC is **people-hours, not ad spend**. Budget assumption per neighborhood: ~$150 (coffee, printing, small thank-you) + ~8 organizer hours. Target: ≤$6 per activated household.

### 5.5 Neighborhood gate (do not scale until met)
- ≥25 registered households, ≥60 active listings across ≥4 categories, ≥15 completed borrows in 30 days, ≥4.8/5 average rating, return rate ≥95%.

---

## 6. Motion B — Universal Circles (Book Shelf)

**Goal:** make "does anyone near me have this book?" a query we own, and convert that intent into local handoffs.

### 6.1 The offer
> *"Every book. Your neighbors' shelves. One library."*
> *"Add your shelf once. Borrow what you want. Gift what you've finished."*

The universal promise is **discovery**, not delivery. Copy must never imply a copy can be shipped.

### 6.2 Funnel & tactics

| Stage | Tactic | Target |
| :--- | :--- | :--- |
| **Seed supply at scale** | Goodreads/CSV bulk import; live ISBN barcode scanning at book-club meetups, campus drives, society fairs (100+ books in 30 min) | 300 titles pre-launch in launch metro |
| **Own search intent** | SEO landing pages per title/author/ISBN, "borrow [title] in [city]" pages, schema.org Book markup, shareable book pages (already in `book-detail.html`) | Top-3 local intent for 200 long-tail titles by day 90 |
| **Partner distribution** | Independent bookshops, cafés, school libraries, apartment lobbies as drop boxes and QR touchpoints; "host a shelf" program | 5 partners in launch metro |
| **Community seeding** | Book-club outreach (offer: free wishlist page + swap night kit), Bookstagram/BookTok micro-creators, parenting groups for kids' books | 10 clubs, 5 creators |
| **Trigger campaigns** | "Leaving the city?" / "Finished your degree?" / "Kids outgrew picture books?" donation drives with a 3-tap donate flow | 40% of supply from triggers |
| **Retention loop** | Want-list alerts, due-date reminders, monthly reading challenge, "your shelf has been borrowed N times" | ≥25% want-list fill, 40% 30-day return |
| **Librarian program** | Appoint 2–3 librarians per circle; curation guidelines, duplicate merging, condition grading | Every partner circle staffed |

### 6.3 The wishlist is the growth loop
Every want-list entry creates a future notification and a shareable page. This is the only mechanic that turns a global catalogue into local transactions — prioritize it above reviews, leaderboards, and recommendations.

### 6.4 Universal gate (do not scale until met)
- ≥300 titles in one metro, ≥25 concurrent loans, ≥25% want-list fill in 30 days, search-with-zero-results <15%, return rate ≥90%.

---

## 7. The city pod — how the two motions compound

```
                 ┌─────────────────────────────┐
                 │      ONE LAUNCH METRO       │
                 └──────────────┬──────────────┘
        ┌───────────────────────┴───────────────────────┐
        ▼                                               ▼
┌──────────────────┐                          ┌──────────────────┐
│ NEIGHBORHOOD     │  supplies readers,       │ UNIVERSAL        │
│ CIRCLES          │  drop-box hosts,  ──────▶│ CIRCLE (Book     │
│ (trust, density) │  real handoff points     │ Shelf)           │
└────────┬─────────┘                          └────────┬─────────┘
         │  gives every circle a                    │
         │  reason to return after                 │
         │  the drill is returned                  │
         └──────────────────┬──────────────────────┘
                            ▼
              Shared trust layer: reputation,
              join policy, moderation, reminders
```

- **Same metro, same quarter.** Books from universal circles become the second reason a neighborhood member opens the app.
- **Neighborhood circles are the handoff network.** A dense neighborhood is a set of safe, walkable meetup points; Book Shelf can clear there on day one.
- **Universal circles are the acquisition surface.** Book search is a scalable top-of-funnel; neighborhoods are not. Use books to acquire, neighborhoods to retain.
- **One trust system, two norms.** Neighbors accept porch pickup; strangers need public meetups and verification tiers. Never let universal-circle policy weaken neighborhood privacy defaults.

---

## 8. Channel plan & budget (first 90 days)

| Channel | Motion | Effort | Budget | Why |
| :--- | :--- | :--- | :--- | :--- |
| Champion 1:1s + HOA/building outreach | Neighborhood | High | $0 | Only reliable way to get a seeded circle |
| Launch events ("Coffee & Cataloging", swap nights) | Both | High | $600 | Converts intent to listings in one sitting |
| Print (QR flyers, hangers, shelf cards) | Both | Medium | $300 | Physical adjacency is the product's advantage |
| WhatsApp/Signal invite kits | Neighborhood | Low | $0 | Existing trust graph; highest conversion |
| SEO title/author/ISBN pages | Universal | Medium | $0–500 | Compounding, intent-qualified acquisition |
| Book-club & creator outreach | Universal | Medium | $500 | Trusted recommendation; supplies + demand |
| Bulk-import drives (campus, moving, kids) | Universal | Medium | $400 | Fastest path to catalogue density |
| Partner drop boxes (cafés, shops, lobbies) | Both | Medium | $300 | Real-world discovery + handoff points |
| Paid social (geo-fenced, retargeting only) | Both | Low | $1,000 | Test only; not a primary engine |
| **Total** | | | **~$3,600** | Excludes people time; deliberately offline-first |

**Explicitly not doing in the first 90 days:** broad paid acquisition, national PR, influencer campaigns, app-store optimization, referral cash incentives.

---

## 9. Messaging & assets

### Message matrix

| Audience | Hook | Proof | CTA |
| :--- | :--- | :--- | :--- |
| HOA / building manager | "A free amenity your residents will actually use." | Seeded circle + admin tools + privacy defaults | Book a 20-min walkthrough |
| Founding admin | "Be the neighbor who started it." | Champion kit, co-leads, launch runbook | Claim your circle |
| Household | "You need a ladder twice a year, not a ladder." | 40 items already on your street | Join and pledge 2 |
| Reader | "The book you want is probably on a shelf near you." | Local copy count + want-list alert | Add to want list |
| Book club | "One shared shelf for the whole club." | Bulk import, wishlists, swap kit | Host a shelf |
| Donor / mover | "Give your books a second reader." | 3-tap donate, no return policy | Donate a book |

### Assets to produce
- 60-second product film (one neighborhood, one book, one handoff).
- Champion kit (see §5.3) and Librarian kit (curation + moderation guide).
- 6 social templates: pledge, first share, want-list match, impact recap, book drop, swap night.
- Landing pages: `/neighborhoods`, `/books`, `/host-a-shelf`, plus per-title SEO pages.
- Trust one-pager: privacy model, meetup guidance, never-lost policy.

---

## 10. 90-day launch timeline

| Phase | Weeks | Neighborhood track | Universal track | Gate |
| :--- | :--- | :--- | :--- | :--- |
| **0. Prepare** | 1–2 | Pick 2 pilot neighborhoods; sign 2 champions; build champion kit | Pick launch metro; recruit 3 librarians; stand up import + SEO pages | 2 champions signed, 3 librarians |
| **1. Seed** | 3–5 | Pledge drives; 40+ items per circle; launch event | Bulk import + ISBN scan drives; 300 titles | Supply gates met |
| **2. Open** | 6–8 | Invite households; first-share nudge; weekly feed posts | Public catalogue + want lists; book-club outreach; 5 partners | 25 households; 25 loans in flight |
| **3. Prove** | 9–12 | Measure return rate, repeat rate, NPS; run monthly ritual | Measure want-list fill, zero-result rate, SEO impressions | Both motion gates met |
| **4. Decide** | 12 | Retro: repeat with 2 more neighborhoods or fix the loop | Retro: second metro or deepen the first | Go / fix / stop memo |

**Cadence:** weekly growth standup (funnel + supply + trust metrics), biweekly champion check-in, monthly public impact recap.

---

## 11. Metrics

**North stars**
- Neighborhood: **monthly sharing households** (households with ≥1 completed handoff in 30 days).
- Universal: **books in motion** (distinct copies lent or donated in 30 days within the local radius).

| Layer | Neighborhood | Universal |
| :--- | :--- | :--- |
| Acquisition | champion→circle conversion; invite→join; join→first-list | search impressions→book page; page→want-list; import→list |
| Supply | items per household; % households with ≥2 listings; category coverage | titles per metro; % listings <60s; donation share |
| Liquidity | request→approve; approve→handoff; days to first handoff | search→request; want-list fill rate; zero-result rate |
| Trust | return rate; no-show rate; dispute rate; % verified | return rate; lost-book rate; reports/100 handoffs |
| Health | 30-day repeat; NPS; admin burden (hrs/week) | 30-day repeat; density (books/km²) |

**Guardrails:** search-with-zero-results, listing-with-zero-views, unanswered requests, median time-to-first-response. A rise in any of these invalidates the north star.

**Instrumentation:** ship the event schema in Phase 1 (§7 of `Specs/WORLD_OF_BOOKS.md`); do not launch a channel that cannot be attributed.

---

## 12. Risks & mitigations

| Risk | Motion | Mitigation |
| :--- | :--- | :--- |
| Champion burns out / becomes bottleneck | Neighborhood | Recruit 2–3 co-admins up front; moderation roles, not one owner |
| Circle becomes a dead group chat | Neighborhood | Weekly scripted feed post; monthly ritual; admin dashboard with a "needs attention" queue |
| Empty catalogue at launch | Universal | Density gate; never market a metro before 300 titles |
| Universal promise read as "shipping" | Universal | Copy rule: "near you," never "delivered"; no long-haul until Phase 3 |
| Unrecovered book → trust collapse | Universal | Never-lost policy, reminders, verification tiers, public loss log |
| Privacy incident (address exposure) | Both | Coarse area only; exact address only post-approval; audit per `launch-playbook.md` §3 |
| CAC drifts to paid before PMF | Both | Budget cap: paid ≤20% of spend until both gates met |
| Brand confusion (three names) | Both | Adopt brand architecture in §2 before any external asset ships |

---

## 13. Team & ownership

| Role | Owns | Time |
| :--- | :--- | :--- |
| Growth lead | Plan, gates, weekly standup, channel mix | 1.0 FTE |
| Community organizer | Champion recruitment, events, kits | 1.0 FTE |
| Content/SEO | Title pages, book-club outreach, social templates | 0.5 FTE |
| Product/eng liaison | Instrumentation, feature flags, import tools | 0.25 FTE |
| Librarian lead (contract/volunteer) | Curation standards, partner circles | 0.25 FTE |

---

## 14. Open decisions

1. **Launch metro** — must be named before Phase 1; the plan degrades badly if the answer is "everywhere."
2. **Brand architecture** — approve *Share, Instead.* master brand; retire "World of Books" vs "Book Shelf" duplication.
3. **Neighborhood pilot count** — 2 (recommended) vs 5; more pilots dilute organizer time below the seeding threshold.
4. **Monetization stance** — confirm free-for-all through Phase 2; do not tease paid tiers in launch messaging.
5. **Partner terms** — what a café/library gets in exchange for hosting a shelf (badge, co-marketing, analytics).
