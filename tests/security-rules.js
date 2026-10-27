// A deliberately SMALL subset of firestore.rules, expressed as a plain JS
// function so the mock can enforce it.
//
// Why this exists: the mock previously ignored security rules entirely, which
// let a real bug ship — createBorrowRequest never wrote `lender_id`, so
// firestore.rules:139 (`request.resource.data.lender_id is string`) denied
// EVERY borrow request, while the test suite passed because it injected
// `lender_id` itself. Enforcing the rule locally closes that gap.
//
// This is not a general rules interpreter. It encodes only the rules for the
// collections the "A World of Books" work touches. Keep it in sync by hand
// when firestore.rules changes.

const DENY = (msg) => {
    const err = new Error(`PERMISSION_DENIED: ${msg}`);
    err.code = 'permission-denied';
    throw err;
};

// Mirrors firestore.rules canParticipantUpdateItem(). Rules have NO query
// primitive — `get()` takes a single document path only — so the item
// denormalises `active_request_id` and the rule reads just that one request.
// Only an IN-FLIGHT request confers item-write rights: terminal requests
// (completed/denied/cancelled) must not leave the counterparty able to
// mutate the item.
//
// This model is deliberately the same single-document shape as firestore.rules.
// An earlier version paraphrased the *intent* ("scan all requests") instead of
// the *mechanism*, which is exactly how the invalid `.where()` off `get()`
// survived in the real rules file while the mock kept passing.
const ACTIVE_REQUEST_STATUSES = ['pending', 'approved', 'borrowed', 'returned'];

function canParticipantUpdateItem(firestore, uid, itemId, activeRequestId) {
    if (typeof activeRequestId !== 'string') return false;
    const req = firestore._getData('requests', activeRequestId);
    if (!req) return false;
    return req.item_id === itemId
        && ACTIVE_REQUEST_STATUSES.includes(req.status)
        && (req.borrower_id === uid || req.lender_id === uid);
}

function enforceDelete(collectionName, docId, data, uid, firestore) {
    switch (collectionName) {
        case 'requests':
            // firestore.rules:160 — audit trail is preserved; no client deletes.
            DENY('requests cannot be deleted (audit trail)');

        case 'ratings':
            // firestore.rules:259
            DENY('ratings are immutable once created');

        case 'circle_members': {
            // firestore.rules:75-78
            const circleDoc = firestore._getData('circles', data.circle_id);
            const isCreator = circleDoc && circleDoc.created_by === uid;
            if (data.profile_id !== uid && !isCreator) {
                DENY('only the member or the circle creator may remove a membership');
            }
            return;
        }

        case 'circle_join_requests': {
            // firestore.rules:227-232
            const circleDoc = firestore._getData('circles', data.circle_id);
            const isCreator = circleDoc && circleDoc.created_by === uid;
            if (data.profile_id !== uid && !isCreator) {
                DENY('only the requester or the circle creator may cancel this request');
            }
            return;
        }

        case 'items': {
            // firestore.rules:114-115
            if (data.owner_id !== uid) DENY('only the owner may delete an item');
            return;
        }

        case 'wishlists': {
            if (data.profile_id !== uid) DENY('only the owner may delete their wishlist entry');
            return;
        }

        case 'impact_events':
            // firestore.rules: allow update, delete: if false
            DENY('impact_events are immutable (append-only ledger)');

        case 'profiles': {
            // firestore.rules:59 - a user may delete their own profile.
            if (docId !== uid) DENY('can only delete your own profile');
            return;
        }

        case 'reports':
        case 'blocks':
            // Append-only moderation records; no client deletes.
            DENY(`${collectionName} are immutable once created`);

        default:
            return;
    }
}

// Collections whose rules are modelled here. Anything else is left unvalidated
// so unrelated low-level fixtures in the suite keep working.
const ENFORCED = new Set([
    'requests', 'items', 'circle_members', 'circle_join_requests',
    'ratings', 'wishlists', 'reports', 'blocks', 'profiles', 'impact_events'
]);

function buildRulesEngine(firestore) {
    return function enforce(collectionName, docId, data, isCreate) {
        if (!ENFORCED.has(collectionName)) return;

        const auth = firestore._auth ? firestore._auth.currentUser : null;
        const uid = auth ? auth.uid : null;

        // Firestore always requires authentication for writes. Reads are
        // deliberately not modelled here — this engine exists to catch
        // malformed/denied WRITES, which is where the shipped bug was.
        if (uid === null) DENY('not signed in');

        if (isCreate === 'delete') {
            return enforceDelete(collectionName, docId, data, uid, firestore);
        }

        const prior = isCreate ? null : (firestore._getData(collectionName, docId) || null);

        switch (collectionName) {
            // ── requests ────────────────────────────────────────────────────
            // firestore.rules:136-141 (create)
            // firestore.rules:143-157 (update)
            case 'requests': {
                if (isCreate) {
                    if (!uid) DENY('not signed in');
                    if (data.borrower_id !== uid) DENY('borrower_id must be the authenticated user');
                    if (data.status !== 'pending') DENY("new requests must have status 'pending'");
                    if (typeof data.lender_id !== 'string') DENY("lender_id must be a string — this is the rule that createBorrowRequest violated");
                    if (data.lender_id === uid) DENY('cannot borrow from yourself');
                } else {
                    if (!uid) DENY('not signed in');
                    if (!prior) DENY('request not found');
                    if (data.borrower_id !== prior.borrower_id || data.lender_id !== prior.lender_id) {
                        DENY('borrower_id / lender_id are immutable');
                    }
                    const isLender = prior.lender_id === uid;
                    const isBorrower = prior.borrower_id === uid;
                    if (!isLender && !isBorrower) DENY('only the borrower or lender may update');

                    const changed = Object.keys(data).filter(k => data[k] !== prior[k]);
                    const LENDER_FIELDS = ['status', 'confirmed_at', 'declined_at', 'picked_up_at', 'returned_at', 'completed_at', 'donated_at'];
                    const BORROWER_FIELDS = ['status', 'picked_up_at', 'returned_at'];
                    if (isLender && !isBorrower) {
                        if (changed.some(k => !LENDER_FIELDS.includes(k))) DENY(`lender may only change: ${LENDER_FIELDS.join(', ')}`);
                    } else if (isBorrower && !isLender) {
                        if (changed.some(k => !BORROWER_FIELDS.includes(k))) DENY(`borrower may only change: ${BORROWER_FIELDS.join(', ')}`);
                    } else {
                        // Actor is both sides — allow the union so tests that
                        // self-interact are not spuriously denied.
                        const union = [...new Set([...LENDER_FIELDS, ...BORROWER_FIELDS])];
                        if (changed.some(k => !union.includes(k))) DENY(`actor may only change: ${union.join(', ')}`);
                    }
                }
                return;
            }

            // ── items ───────────────────────────────────────────────────────
            // firestore.rules:96-115 plus the VULN-13 fix that lets a
            // participant in a request advance the item's lifecycle fields.
            case 'items': {
                if (isCreate) {
                    if (data.owner_id !== uid) DENY('owner_id must be the authenticated user');
                    if (typeof data.name !== 'string') DENY('name must be a string');
                    if (data.name.length > 200) DENY('name exceeds 200 chars');
                } else {
                    if (!prior) DENY('item not found');
                    if (data.owner_id !== prior.owner_id) DENY('owner_id is immutable');
                    if (typeof data.name !== 'string' || data.name.length > 200) DENY('invalid name');
                    if (prior.owner_id !== uid) {
                        // Non-owner: only if the denormalised active request
                        // points at this item and they are a participant in it,
                        // and only lifecycle fields.
                        if (!canParticipantUpdateItem(
                                firestore, uid, prior.id || docId, prior.active_request_id)) {
                            DENY('only the owner or a participant in an active request may update an item');
                        }
                        const changed = Object.keys(data).filter(k => data[k] !== prior[k]);
                        // `active_request_id` is deliberately absent: a
                        // participant may not repoint the item at their own
                        // request. Owners bypass this branch entirely.
                        const LIFECYCLE = ['status', 'is_available', 'updated_at'];
                        if (changed.some(k => !LIFECYCLE.includes(k))) {
                            DENY(`a non-owner may only change: ${LIFECYCLE.join(', ')}`);
                        }
                    }
                }
                return;
            }

            // ── circle_members ──────────────────────────────────────────────
            // firestore.rules:67-84. Self-join must declare role 'member'.
            case 'circle_members': {
                if (!uid) DENY('not signed in');
                if (isCreate) {
                    const circleId = data.circle_id;
                    const circleDoc = circleId ? firestore._getData('circles', circleId) : null;
                    const isCreator = circleDoc && circleDoc.created_by === uid;
                    const selfJoin = data.profile_id === uid && data.role === 'member';
                    if (!isCreator && !selfJoin) {
                        DENY('self-join requires role "member"; only the circle creator may add others');
                    }
                } else {
                    const circleDoc = firestore._getData('circles', prior.circle_id);
                    const isCreator = circleDoc && circleDoc.created_by === uid;
                    const isSelf = prior.profile_id === uid;
                    if (!isCreator) DENY('only the circle creator may update memberships');
                    if (data.circle_id !== prior.circle_id || data.profile_id !== prior.profile_id) {
                        DENY('circle_id / profile_id are immutable');
                    }
                }
                return;
            }

            // ── circle_join_requests ────────────────────────────────────────
            // firestore.rules:225-232
            case 'circle_join_requests': {
                if (!uid) DENY('not signed in');
                if (isCreate) {
                    if (data.profile_id !== uid) DENY('profile_id must be the authenticated user');
                } else {
                    const circleDoc = firestore._getData('circles', prior.circle_id);
                    const isCreator = circleDoc && circleDoc.created_by === uid;
                    if (prior.profile_id !== uid && !isCreator) {
                        DENY('only the requester or the circle creator may change this');
                    }
                }
                return;
            }

            // ── ratings ─────────────────────────────────────────────────────
            // firestore.rules:243-259
            case 'ratings': {
                if (!uid) DENY('not signed in');
                if (isCreate) {
                    if (data.rater_id !== uid) DENY('rater_id must be the authenticated user');
                    if (typeof data.ratee_id !== 'string') DENY('ratee_id must be a string');
                    if (data.ratee_id === uid) DENY('cannot rate yourself');
                    if (typeof data.score !== 'number' || data.score < 1 || data.score > 5) DENY('score must be 1-5');
                    if (typeof data.request_id !== 'string') DENY('request_id must be a string');
                    if (!['rater_id', 'ratee_id', 'score', 'request_id'].every(k => k in data)) {
                        DENY('missing required rating fields');
                    }
                } else {
                    DENY('ratings are immutable once created');
                }
                return;
            }

            // ── wishlists / wishlist_matches (new) ──────────────────────────
            case 'wishlists': {
                if (!uid) DENY('not signed in');
                if (isCreate) {
                    if (data.profile_id !== uid) DENY('profile_id must be the authenticated user');
                } else if (data.profile_id !== uid) {
                    DENY('only the owner may update their wishlist');
                }
                return;
            }

            // ── reports (new) ───────────────────────────────────────────────
            case 'reports': {
                if (!uid) DENY('not signed in');
                if (isCreate) {
                    if (data.reporter_id !== uid) DENY('reporter_id must be the authenticated user');
                    if (typeof data.reason !== 'string' || !data.reason) DENY('reason is required');
                } else {
                    DENY('reports are immutable once filed');
                }
                return;
            }

            // ── blocks (new) ───────────────────────────────────────────────
            case 'blocks': {
                if (!uid) DENY('not signed in');
                // doc id is "<blocker>_<blocked>"; only the blocker may write it
                if (!String(docId).startsWith(`${uid}_`)) DENY('only the blocking user may modify this block');
                return;
            }

            // ── profiles ────────────────────────────────────────────────────
            // firestore.rules:15-38.
            //
            // Two fields are deliberately NOT client-writable and are the
            // reason this engine exists:
            //   * reputation_score — firestore.rules:30
            //   * carbon_saved_kg — the same class of server-owned aggregate.
            //     confirmReturn used to write BOTH participants' profiles, so
            //     crediting the counterparty's carbon was denied in production.
            //     Carbon is now recorded as an append-only `impact_events`
            //     ledger entry and folded in by a trusted process.
            case 'profiles': {
                if (docId !== uid) DENY('can only write your own profile');
                if (isCreate) {
                    if ('reputation_score' in data && data.reputation_score !== 5.0) {
                        DENY('reputation_score may only be initialised to 5.0');
                    }
                    if ('carbon_saved_kg' in data && data.carbon_saved_kg !== 0) {
                        DENY('carbon_saved_kg must start at 0');
                    }
                } else {
                    if (!prior) DENY('profile not found');
                    if ('reputation_score' in data && data.reputation_score !== prior.reputation_score) {
                        DENY('reputation_score is not client-writable');
                    }
                    if ('carbon_saved_kg' in data && data.carbon_saved_kg !== prior.carbon_saved_kg) {
                        DENY('carbon_saved_kg is not client-writable (server-owned aggregate)');
                    }
                }
                return;
            }

            // ── impact_events (new, append-only ledger) ─────────────────────
            // Replaces the illegal cross-profile carbon write. Credit is
            // derived from these rows, never hand-written by a client.
            case 'impact_events': {
                if (isCreate) {
                    if (data.actor_id !== uid) DENY('actor_id must be the authenticated user');
                    if (typeof data.credit_kg !== 'number') DENY('credit_kg must be a number');
                    if (typeof data.beneficiary_id !== 'string' || !data.beneficiary_id) {
                        DENY('beneficiary_id is required');
                    }
                    if (data.credit_kg > 10) DENY('credit_kg exceeds the 10kg ceiling');
                    if (data.credit_kg > 0) {
                        if (!['loan', 'donation'].includes(data.kind)) {
                            DENY("a positive credit must have kind 'loan' or 'donation'");
                        }
                    } else if (data.credit_kg < 0) {
                        if (data.kind !== 'reversal') DENY("a negative credit must have kind 'reversal'");
                        if (typeof data.reverses_event_id !== 'string') {
                            DENY('a reversal must reference reverses_event_id');
                        }
                    } else {
                        DENY('credit_kg may not be zero');
                    }
                } else {
                    DENY('impact_events are immutable (append-only ledger)');
                }
                return;
            }

            default:
                return;
        }
    };
}

export { buildRulesEngine };
