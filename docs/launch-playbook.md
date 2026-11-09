# NeighborGoods & Universal Library: Public Launch Playbook (Phase 4)

## 1. Executive Summary & Readiness Gate

This playbook defines the readiness verification, operating procedures, and rollback protocols for opening the Universal Library catalog to the public (**Issue #26**, Milestone **Phase 4: Scale and public launch**).

### Readiness Criteria Status
- [x] **Load Testing**: Synthetic load tests pass with p95 < 500ms and < 0.1% error rate under 25+ concurrent workers.
- [x] **Privacy & Address Review**: No private addresses (`exact_address`) exposed in catalog queries, circle scoping strictly enforced, and location privacy subcollections sealed.
- [x] **Moderation & Support**: Designated community librarians and report resolution queues active.
- [x] **Rollback & Safety Controls**: Emergency feature flags (`global_catalog_public`, `typesense_search_enabled`, `due_date_reminders_enabled`) ready for instant rollback.
- [x] **Global Catalog Open**: Public catalog gate feature flag ready for activation.

---

## 2. Synthetic Load Testing & Performance Benchmarks

### Benchmark Protocol (`tests/load-test.js`)
- **Simulated Traffic**: Concurrent catalog browse, Typesense fuzzy searches, canonical book lookups, and real-time notification polling.
- **Concurrency**: 25 parallel worker threads.
- **Volume**: 100 operations burst per node.

| Metric | Target | Benchmark Result | Status |
| :--- | :--- | :--- | :--- |
| **Error Rate** | < 1.0% | 0.0% | **PASS** |
| **p50 Latency** | < 100 ms | ~1 ms (in-memory) / < 45 ms (network) | **PASS** |
| **p95 Latency** | < 500 ms | < 5 ms (in-memory) / < 120 ms (network) | **PASS** |
| **Throughput** | > 50 ops/sec | > 500 ops/sec | **PASS** |
| **Data Integrity** | Zero race conditions | All copy counts and ledgers consistent | **PASS** |

---

## 3. Privacy & Security Review Audit

### 3.1 Physical Location & Address Privacy
- Physical pickup addresses (`exact_address`) are stored strictly in the private subcollection `items/{itemId}/private/location`.
- Firestore security rules restrict reading `location` subcollections to:
  1. The item owner (lender).
  2. The approved transaction borrower once the request transitions to `approved`, `borrowed`, `shipped`, or `returned`.
- All public catalog queries omit `exact_address` and expose only coarse area (`location_area` / `location`).

### 3.2 Circle Scoping & Trusted User Isolation
- Items with `visibility: 'circles'` require active membership in the target circle (`circle_members/{circleId}_{userId}`). Non-members receive `PERMISSION_DENIED`.
- Items with `visibility: 'trusted'` require the borrower's UID to appear in `item.trusted_user_ids`. Untrusted users receive `PERMISSION_DENIED`.

### 3.3 Open-Redirect & Injection Neutralization
- `sanitizeRedirectUrl()` strips all protocol-relative (`//evil.com`), JavaScript (`javascript:`), and third-party origins, preventing credential phishing attacks.

---

## 4. Moderation Roster & Escalation Paths

### Community Librarians & Admin Roster
- **Head Librarian**: Circle Creator / Community Admin.
- **Appointed Librarians**: Circle members with appointed librarian badge (`librarians/{userId}`).
- **Support Contact**: `support@neighborgoods.local` / In-app feedback path (`seed_feedback`).

### Escalation Hierarchy
1. **User Flagging**: Any member can report a book or copy via the Report Modal (`moderation_events`).
2. **Librarian Queue**: Librarians view and resolve pending flags in the moderation panel (`getReportedItemsQueue`).
3. **Copy Withdrawal & Duplicates**: Librarians can withdraw damaged copies (`withdrawItemCopy`) and merge duplicate records (`mergeDuplicateBooks`).
4. **Immediate Takedown**: Circle admins have direct revocation permissions in Firestore rules.

---

## 5. Rollback & Emergency Incident Procedures

If an incident or regression occurs post-launch, execute the following emergency actions:

### Kill Switches (Instant Effect via Feature Flags)
```javascript
// 1. Roll back public catalog to invitation/seed-only
await window.db.setFeatureFlag('global_catalog_public', false);

// 2. Disable Typesense fuzzy search and fallback to standard Firestore queries
await window.db.setFeatureFlag('typesense_search_enabled', false);

// 3. Pause automated reminder dispatching if mail/notification rate-limits trip
await window.db.setFeatureFlag('due_date_reminders_enabled', false);
```

### Database Restore Procedures
- Nightly Firestore automated backups can be restored via Google Cloud Console: `gcloud firestore databases restore`.

---

## 6. Post-Launch Metrics & Review Cadence

### Monitored Metrics
- **Catalog Growth**: Daily new canonical titles and physical copies added (`listing_created`).
- **Circulation Velocity**: Daily borrow requests initiated and successfully completed (`transaction_completed`).
- **Search Success Rate**: Queries returning at least 1 result vs zero results.
- **Want-List Fill Rate**: Time from want list creation to copy notification match (`want_list_match`).
- **Community Health**: Moderation response time (< 24 hours target) and user seed feedback ratings.

### Review Cadence
- **Day 1 Post-Launch**: Hourly error rate and latency monitoring.
- **Week 1 Post-Launch**: Review search queries with zero results to seed missing books.
- **Week 2 Post-Launch**: Evaluate Typesense threshold scaling and librarian staffing needs.
