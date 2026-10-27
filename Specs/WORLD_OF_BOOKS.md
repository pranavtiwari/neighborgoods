# "A World of Books" — Product & Technical Plan

Status: Proposal · Owner: unassigned · Target: v0 public pilot

---

## 0. The one decision that shapes everything

**A physical book cannot teleport.** The product brief asks for a global, open, universal
public library, but the existing app is a hyperlocal neighbor-to-neighbor tool
(`Specs/PRD.md:7`, "neighbors to share and borrow items"). Those two things are in direct
tension, and pretending otherwise is the single most likely way this project fails.

So the central architectural and product decision is to **separate the catalogue from the
circulation**:

| Layer | Scope | What it does | Phase |
| --- | --- | --- | --- |
| **Catalogue** | Global | Every book, every copy, every wishlist. Discovery, search, "does this title exist here?" | 1 |
| **Circulation** | Local (radius/walkable) | Actual borrow/return hand-offs between real people | 1 |
| **Long-haul** | Regional/national | Shipping a copy, or gifting/donating it outright | 3 |

- The **catalogue can be global from day one** and is what makes the product *feel* like a
  universal library. It is also nearly free to build on the current stack.
- The **transaction must be local**. A "borrow from Tokyo" promise is unfulfillable and would
  be a support catastrophe. Instead: a global wishlist that *notifies you when a copy surfaces
  near you* is genuinely more useful than a fake global checkout, and it is honest.
- The "open, anyone can join" requirement is a **policy**, not a go-to-market. The circle
  record should be open and permissionless on day one; the *launch* should be dense
  (see §6). Launching globally with 12 books per country is worse than useless — it produces
  dead search results and no second visit.

**Explicit non-goal for v0:** shipping. Revisit at Phase 3, and only if local density is
already proven.

---

## 1. Three distinct transactions, three distinct products

The brief bundles three things that need *different flows, different rules, and different
incentives*. Modeling them as one `requests` flow will make each one worse.

| Intent | Counterparty | Return? | Friction target | Why it matters |
| --- | --- | --- | --- | --- |
| **Donate** (give away) | Nobody — it leaves your shelf | No, irrevocable | ~3 taps, no approval | **Supply engine.** This is how you cold-start a library. Lowest friction, highest supply yield. |
| **Lend** (share) | A specific reader | Yes, tracked | Medium | Retains assets; builds the "real library" feel |
| **Request** (borrow) | Lend/donate choice | Depends on which | Medium | Demand side |

Two design rules follow:

1. **Listing must be one gesture.** Donating should never require choosing a return policy,
   a duration, or messaging a stranger first. A donation is a fire-and-forget listing that a
   nearby reader can claim.
2. **Never mix donate and lend in one record.** A `requests` doc that resolves to a permanent
   transfer needs a terminal state distinct from `returned`. Reusing `status: 'returned'` for
   a donated book corrupts the return-stats and reputation signals that trust depends on.

---

## 2. Launch blockers (must be fixed before any user joins)

These are **verified against the current code**, not hypothetical. Items 1 and 2 mean the
core borrow loop and chat are non-functional against a real Firestore today — the existing
test suite does not catch them because it supplies `lender_id` in its own fixture and the
mock does not enforce rules.

### Blocker 1 — Borrowing is broken; every write is denied (CRITICAL)
`createBorrowRequest` reads the item and validates against `itemData.owner_id`
(`site/public/firebase-client.js:915-920`) but never writes `lender_id` into the transaction
(`site/public/firebase-client.js:945-951`). Meanwhile `firestore.rules:139` **requires**
`request.resource.data.lender_id is string`, and `:140` requires it to differ from the
borrower. Every borrow request is rejected; `request-borrow.html:427-430` surfaces it as
"Failed to send request".

Two further consequences even if that rule were relaxed:
- `getBorrowRequestsForUser(uid,'lending')` filters on `where('lender_id','==',userId)`
  (`firebase-client.js:979`) — matches nothing, so lenders see an empty dashboard.
- `getRatingsSummary` queries the same field (`firebase-client.js:1613`) — lenders never
  accrue reputation, which is the currency the trust model depends on.

**Fix:** add `lender_id: itemData.owner_id` to the `transaction.set` payload
(`firebase-client.js:945-948`). It is derived server-side from the item doc, so it cannot be
spoofed — the rule was clearly written expecting exactly this. Add a rules-enforcing test
fixture (pass no `lender_id`, assert success) so the mock stops hiding it.

### Blocker 2 — No composite indexes; chat and unread badges throw at runtime (CRITICAL)
`firebase.json` declares `rules` only — no `indexes` key, and no `firestore.indexes.json`
anywhere in the repo. Firestore auto-provisions single-field indexes only, so these shapes
fail with `FAILED_PRECONDITION`:

| Query | Location | Index needed |
| --- | --- | --- |
| `messages` `sender_id ==` + `receiver_id ==` (×2 listeners) | `firebase-client.js:1192-1201` | `messages(sender_id, receiver_id)` |
| `messages` `receiver_id ==` + `is_read ==` | `firebase-client.js:1570-1573` | `messages(receiver_id, is_read)` |
| `messages` `sender_id` + `receiver_id` + `is_read` | `firebase-client.js:1583-1587` | `messages(sender_id, receiver_id, is_read)` |
| `requests` `item_id in (…)` + `lender_id ==` | `firebase-client.js:977-979` | `requests(item_id, lender_id)` |

Chat is how a global stranger marketplace establishes trust ("I'm at the library, which
table?"). It is not optional.

**Fix:** add a `firestore/indexes.json` and reference it from `firebase.json`. Deploy
indexes *before* the first real user — index builds are async and a missing index is a hard
runtime error, not a slow query.

### Blocker 3 — Unbounded reads that don't survive global scale
- `getRatingsSummary` reads the **entire** `ratings` collection with no filter and no
  `limit()` (`firebase-client.js:1618`), then fans out one profile read per rater
  (`:1643-1647`). The result is memoised in `_ratingsSummaryCache` (`:1599`) which is never
  invalidated — stale for the whole session. It is called on 6 pages (`explore.html:271`,
  `item-details.html:189`, `circle-detail.html:809`, `chat.html:170`, `activity.html:366`).
  A book catalogue multiplies this by orders of magnitude.
- `markMessagesAsRead` selects all unread messages from a peer with no `limit()` then
  `batch.update`s each (`firebase-client.js:1581-1597`). Firestore caps a batch at **500
  ops**; past that `commit()` rejects, the `catch` only `console.error`s, and the unread badge
  silently persists.
- `getItems`, `getCircles`, `getCircleItems`, `getCircleMembers` are unfiltered full
  collections with no pagination.

**Fix:** paginate everything; key the ratings cache by uid and invalidate on new rating;
scope ratings aggregation to the visible page of items.

### Blocker 4 — Book covers stored as base64 inside Firestore documents
`uploadFile` calls `firebase.storage()` (`firebase-client.js:520-524`) and, on any failure,
**silently falls back to a canvas-compressed base64 data URL written into the document**
(`:526-567`). There is a `storage.rules`, so the intent was there, but the fallback means
image bytes land in Firestore: Firestore bills and scans document bytes, and a 1M-title
catalogue of base64 covers is a structural cost wall.

**Fix:** load the Firebase **Storage compat** library explicitly, make the base64 path a
deliberate, size-capped opt-in rather than a silent default, and reject uploads > ~1MB. This
must land *before* seeding the catalogue, not after.

### Blocker 5 — No way to mark a circle as the open/global one
`circles` has exactly one visibility field, `is_private` (`create-circle.html:140-158`).
There is no `kind`/`topic`/`system` flag, so nothing can pin, sort, or specially render "A
World of Books". Meanwhile `index.html:577` renders `circle.is_public ? 'Public' : 'Private'`
— a field that is **never written**, so every circle on the homepage is labelled *Private*.

**Fix:** add `circles.kind` (`'neighborhood' | 'topic' | 'global'`), `circles.topic`, and
`circles.is_official`. `items` and `circles` are schemaless at the rules layer (validation in
`firestore.rules:93-116` only guards a few fields), so these can be added **without touching
security rules**. Pin the official circle in `circles.html:302-311`; fix the `is_public`
label at the same time.

### Blocker 6 — Chat threads merge every interaction between two people
`subscribeToChatMessages` filters only on `sender_id`/`receiver_id` and ignores `item_id` and
`circle_id` (`firebase-client.js:1192-1201`) — even though `sendMessage` persists both
(`:1150-1156`). All messages a pair has ever exchanged, across every item and circle,
collapse into one thread. In a global catalogue this is severe: a book request bleeds into the
user's lawn-mower conversation.

**Fix:** add `item_id`/`circle_id` to the read path. The data is already there.

---

## 3. Data model additions

All additive. `items` and `circles` are schemaless at the rules layer, so none of this
requires a rules change (the one exception is flagged).

**On `circles`**
```
kind:      'neighborhood' | 'topic' | 'global'
topic:     'books' | 'tools' | ...          // for topic/global circles
is_official: bool                          // pins + curated badge
join_policy: 'open' | 'approval'           // global default: 'open'
```
"Open circle anyone can join" is then data, not special-cased code. A global circle with
`join_policy: 'open'` must bypass `circle_join_requests` entirely — today *only the creator*
can approve (`firestore.rules:231`), which would make one person a global moderation
bottleneck and a single point of failure.

**On `items`** (book-specific; harmless for tools)
```
kind:        'book' | 'item' | 'skill' | 'surplus'
isbn13, isbn10
title, author, publisher, published_year, language
page_count, condition_grade
cover_url            // must be a Storage URL, not base64 (Blocker 4)
intent:     'lend' | 'donate'                 // the §1 split
edition_note
```

**On `requests`** — a terminal `status: 'donated'` distinct from `'returned'`, plus
`resolved_at` and `lost_at` so non-returns are a tracked, escalating state rather than a
row that sits in `borrowed` forever.

**On `profiles`** — `verification_tier` (`'unverified' | 'email' | 'id'`) and
`reliable_until`. Trust tier should gate the riskier actions (long lends, lending to
first-time-meets).

### Do NOT add a `circle_members` row per person for a global circle
Membership IDs are `${circleId}_${profileId}` (`firebase-client.js:791`) and
`circle_members` is readable by any authenticated user with no filter
(`firestore.rules:65`). One global circle + N members = one hot, fully-enumerated collection,
and `getCircleMembers` fans out a profile read per member. **A global circle should use
membership-free membership** — a counter plus an explicit opt-in set — so that "I am in the
World of Books" is a badge, not a distributed-systems problem. Individual/local circles keep
the row-per-member model.

---

## 4. Features that actually determine success

Ranked by expected impact, not by build cost.

1. **Search & metadata (highest).** A book catalogue without search is not a library, it is
   a spreadsheet. Integrate a free book metadata + cover API (Open Library / Google Books)
   at listing time: scan or type the ISBN → title, author, year, and cover auto-fill → list.
   This cuts listing to ~3 taps, solves cold-start metadata *and* covers at zero cost, and is
   the single highest-leverage feature in the product. The current app has no real search at
   all (`Specs/SITE.md:27` still lists it as a roadmap item).
2. **Wishlist / request-a-title.** The mechanism that reconciles "global catalogue" with
   "local circulation": anyone can list a title they want, and a nearby reader who owns it
   gets notified. This is how a global catalogue produces *local* transactions, and it is
   the honest version of "universal library".
3. **Trust & safety (gate everything).** For a global stranger marketplace handing over
   physical property, this is the blocking risk, not a nice-to-have. Needs: tiered identity
   verification, visible lender reputation (the `ratings` collection already exists and
   Blocker 1 currently starves it), a borrowing streak, report/block, meetup-safety guidance,
   and age-gating for children's books. Design the hand-off UX to default to a **public,
   well-lit place** — this measurably reduces both harm and no-shows.
4. **Never-lost policy + no-show handling.** State the rules up front: grace period,
   reminders, a "lost book" flow, what happens to the lender's streak, and a stated
   community norm. Undefined, this becomes the #1 source of member churn.
5. **Density map.** A "1,200 books within 2 km of you" view. Density is the health metric
   for a marketplace, and it is also the most persuasive onboarding screen — it is the
   answer to "will anyone actually show up?"
6. **Wishlists as gifting.** The highest-intent surface: a "for a person who loves X" flow
   that converts a want into a donation. Gives the product a reason to be opened when you
   have nothing to lend.
7. **Preschool/school/kids' literacy track.** A narrow, high-emotion wedge that reliably
   recruits both supply (parents with surplus picture books) and demand (parents hunting
   hard-to-find titles). A good first vertical beyond the general catalogue.
8. **Campus & second-hand bookshops as supply anchors.** Physical spaces that donate in bulk
   are how you get a real inventory on day one.

### Explicit non-goals for v0
Shipping/mail · ebook lending & DRM · hold/reservation queues · fine or fee systems ·
in-app payments or deposits · book reviews (ratings ≠ reviews) · a global leaderboard.

---

## 5. Phased roadmap

Each phase ends at a **gate** — a number, not a feeling. Do not start a phase until the
previous gate is met.

### Phase 0 — Foundations (make it work, and make it survive 10k books)
- [ ] Fix `lender_id` (Blocker 1) + add a rules-enforcing test fixture
- [ ] Add `firestore/indexes.json` with the 5 composite indexes (Blocker 2); deploy and verify
- [ ] Make Storage the real image path; retire the silent base64 fallback (Blocker 4)
- [ ] Paginate `getItems` / `getCircles` / `getCircleItems` / `getCircleMembers`; bound and
      key `getRatingsSummary`; cap `markMessagesAsRead` (Blocker 3)
- [ ] Add `circles.kind` / `topic` / `is_official` / `join_policy`; fix the `is_public` label (Blocker 5)
- [ ] Scope chat reads by `item_id` / `circle_id` (Blocker 6)
- [ ] Seed the official circle doc with a stable well-known ID
- [ ] Add proper observability — this is a static client with no monitoring, so
      `console.error` in a `catch` is the *only* failure signal you have. Blocker 2 and 3 are
      both the kind of failure that a user experiences as "the app is broken" with nothing in
      a log you own.

**Gate:** a test user can donate a book, a second test user can find it via search, request
it, message the donor, and complete a return — with zero console errors and no uncaught rule
denials. Plus: 10,000 seeded items, all four list/search pages load in <2s.

### Phase 1 — The catalogue is the product
- [ ] Book metadata + cover auto-fill (ISBN scan or type) — target: 3-tap listing
- [ ] Real search: title, author, ISBN, publisher, year, language
- [ ] Wishlist / request-a-title + "a copy surfaced near you" notifications
- [ ] `intent: 'lend' | 'donate'` flows; terminal `status: 'donated'`
- [ ] Trust surface on the book page: lender reputation, verification tier, lend history
- [ ] Density map; meetup guidance; report/block
- [ ] Profile shows a "World of Books" badge + contributed/borrowed counts
- [ ] Analytics instrumentation from day one (§7)

**Gate:** ≥300 books listed in one metro · ≥40% of listings completed in <60s · search
p95 <400ms · ≥25% of items requested within 14 days of listing.

### Phase 2 — Density and trust (the real work)
- [ ] Never-lost policy, reminders, escalation
- [ ] Identity verification tiers; gate long/high-risk lends
- [ ] Onboarding that requires a first listing, not just a profile
- [ ] Supply-side campaigns: bulk donation drives, school/library partnerships, bookshop anchors
- [ ] Cold-start playbook (§6) run city by city
- [ ] Moderation tooling that does **not** route through one person

**Gate:** a city reaches **≥5,000 active books and ≥1,000 monthly active borrowers** with
a **return rate ≥90%** and **no-show rate <5%**. Return rate is the number that matters —
a book-sharing network is a trust network, and a single well-publicized unrecovered book
damages it more than a hundred missing features.

### Phase 3 — Beyond one circle
- [ ] Multi-city catalogue with a location-scoped default
- [ ] Shipping or gifting long-haul, only if Phase 2 gates are met
- [ ] Aggregation of *existing* real libraries/reading rooms — the "universal public library"
  promise is ultimately better served by federating public collections than by out-lending them
- [ ] Optional digital lending as a bridge for long-tail titles
- [ ] i18n/RTL; low-bandwidth and feature-phone-optimized surface (a "universal" library has
  to work on cheap Android hardware, not just the median iPhone)

---

## 6. Cold start — the part that actually kills these apps

Supply and demand cannot both be cold. Sequence deliberately.

- **"Open to anyone" ≠ "launch everywhere."** Keep the circle permissionless, but seed and
  market **one metro at a time**. A globally searchable catalogue with no local copies is an
  empty search result set — worse for trust than not existing.
- **Supply before demand.** Land books first (bulk donations, campus drives, declutter
  campaigns), then open borrowing. Lenders will not list for an empty borrower pool.
- **Ask for the donation first.** A 3-tap donation yields far more supply than a lend request
  with a return policy, and donated books can be re-listed by a new lender later, so they
  keep circulating.
- **Seed with real scarcity.** Titles that are hard to buy secondhand (out-of-print, textbook
  sets, niche non-fiction) are what make a sharing library worth using. "Everyone can lend
  you a bestseller" is not a compelling wedge.
- **Onboarding must produce supply.** Ask the new user to list one book before they can
  browse. A one-line prompt: *"What's on your shelf that you'd be happy to see read?"*
- **Trigger events, not ads.** Moving house, finishing a degree, a child's birthday, a
  bookshelf clear-out. These are when people have books to give.
- **Name the ritual.** A named, repeated, visible ritual ("Friday Shelf Sweep") is what turns
  a directory into a community.
- **Every claim must be verifiable.** A claimed book count that is not the real count is the
  fastest way to lose the only asset you have: credibility.

---

## 7. Metrics

**North star: books in motion** — distinct copies lent *or* donated in the last 30 days, in
a user's local radius. It is the only metric that cannot be gamed by listing vanity and that
proves the marketplace is actually clearing.

| Layer | Metrics |
| --- | --- |
| Acquisition | install→first-list, listing completion rate, time-to-first-listing, invite conversion |
| Liquidity | **search→request rate**, request→accept, accept→handoff, days-to-first-handoff, median time-to-match, **request-a-title fulfillment rate** |
| Trust & safety | **return rate**, late-return rate, no-show rate, lost-book rate, dispute rate, reports per 100 handoffs, % verified |
| Health | monthly active borrowers, 30-day repeat rate, **supply density (books/km²)** |
| Impact | books kept out of landfill, kg waste diverted, countries/cities live |

Guardrail metrics (a rise here invalidates the north star): search-with-zero-results rate,
listing-with-zero-views rate, median time-to-first-response, and unanswered requests.

---

## 8. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Unrecovered book → reputational death spiral** | Critical | Strict never-lost policy, reminder/escalation ladder, high-barrier identity tier for long lends, public loss log, moderate the *lender* for non-return after clear evidence, never for a first offence |
| **Global promise vs. physical reality** | Critical | §0 — catalogue global, circulation local. Never imply you can ship a copy you can't ship |
| **No liquidity at launch** | High | Density-gated launch (§6); refuse to market a city before it's seeded |
| **Firestore cost wall at scale** | High | Fix Blocker 4 *before* seeding; paginate everything; move aggregation server-side before catalogue growth |
| **Abuse / fraud / safety** | High | Tiered verification, report/block, moderation tooling that doesn't route through one person, meetup guidance, audit log on transfers |
| **Moderation does not scale** | High | `join_policy: 'open'` + flags/auto-throttle replaces the current creator-only approval gate (`firestore.rules:231`) |
| **Single-owner key-person risk** | Medium | The current model makes the circle *creator* an admin bottleneck and single point of failure; move moderation to a role set before global launch |
| **Privacy (borrower location inference)** | Medium | Don't expose precise location on listings; fuzzy/radius only; no public address in Firestore |
| **Data-loss / moderation deletion** | Medium | Export + backup of the catalogue; nothing critical lives only in client state |

---

## 9. Immediate next steps

1. **Fix Blocker 1** — one line at `site/public/firebase-client.js:945-948`, plus a test
   fixture that stops hiding it. Borrowing does not work at all until this lands.
2. **Add and deploy `firestore/indexes.json`** (Blocker 2). Index builds are async; do it now,
   not on launch day.
3. **Land Blocker 5** (`circles.kind` / `join_policy`) so the open-circle concept is
   representable in data rather than special-cased.
4. **Write the Phase 0 gate as an end-to-end script** — donate → search → request → message →
   return — and make it the definition of "working".
5. **Decide the launch city** before building Phase 1 features. The roadmap and the design
   both get measurably worse if the answer is "everywhere."

---

## Appendix — verified code references

| Claim | Location |
| --- | --- |
| `lender_id` required by rules, never written | `firestore.rules:139-140` vs. `site/public/firebase-client.js:945-951` |
| Existing code validates against `itemData.owner_id` | `site/public/firebase-client.js:915-920` |
| Tests mask the bug by supplying `lender_id` | `tests/run-tests.js:226-231` |
| Composite-index-dependent chat queries | `site/public/firebase-client.js:1192-1201`, `1570-1573`, `1583-1587` |
| No `indexes` key | `firebase.json:2-4` |
| Full `ratings` collection read, never invalidated | `site/public/firebase-client.js:1599`, `1618` |
| Uncapped 500-op batch | `site/public/firebase-client.js:1581-1597` |
| Silent base64 image fallback | `site/public/firebase-client.js:520-568` |
| `storage.rules` exists but is unused by the client | `storage.rules`, `site/public/firebase-client.js:522` |
| `is_public` rendered but never written | `site/public/index.html:577` vs. `site/public/create-circle.html:154-159` |
| Only the creator can approve join requests | `firestore.rules:231` |
| Membership ID convention | `site/public/firebase-client.js:791` |
| `circle_members` readable by any authed user, unfiltered | `firestore.rules:65` |
| Chat ignores `item_id` / `circle_id` on read | `site/public/firebase-client.js:1192-1201` (writes at `:1150-1156`) |
| `items`/`circles` are schemaless at the rules layer | `firestore.rules:93-116`, `44-53` |
| Search still on the roadmap, not built | `Specs/SITE.md:27` |
