import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
    TRANSACTION_TYPES,
    REQUEST_STATUSES,
    ACTIONS,
    validateTransition
} from './state-machine.js';
import {
    cleanIsbn,
    normalizeIsbn,
    normalizeTitle,
    normalizeAuthor,
    normalizeAuthors,
    buildCanonicalBookPayload,
    getBookCopiesStatus
} from './catalog.js';
import {
    lookupBookMetadata as performLookup,
    checkRateLimit,
    searchGoogleBooks,
    fetchOpenLibraryByIsbn,
    searchOpenLibrary
} from './book-lookup.js';

initializeApp();
const db = getFirestore();

/**
 * Health check endpoint.
 */
export const healthCheck = onCall({ cors: true }, async (request) => {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        auth: request.auth ? { uid: request.auth.uid } : null
    };
});

/**
 * Callable Function: createRequest
 * Enforces server-derived lender_id, checks item availability, prevents self-requests
 * and duplicates, and records an initial 'requested' transaction event.
 */
export const createRequest = onCall({ cors: true }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated to create a request.');
    }
    const actorId = request.auth.uid;
    const { itemId, duration, message, type } = request.data || {};

    if (!itemId) {
        throw new HttpsError('invalid-argument', 'itemId is required.');
    }

    try {
        const itemRef = db.collection('items').doc(itemId);
        let createdRequestId = null;

        await db.runTransaction(async (transaction) => {
            const itemDoc = await transaction.get(itemRef);
            if (!itemDoc.exists) {
                throw new HttpsError('not-found', 'Item not found.');
            }
            const itemData = itemDoc.data();

            // Self-borrow check
            if (itemData.owner_id === actorId) {
                throw new HttpsError('invalid-argument', 'You cannot borrow your own item.');
            }

            // Availability check
            if (itemData.is_available === false) {
                throw new HttpsError('failed-precondition', 'This item is currently not available for borrowing.');
            }

            // Existing active request check
            const activeRequestsSnap = await transaction.get(
                db.collection('requests')
                    .where('item_id', '==', itemId)
                    .where('borrower_id', '==', actorId)
            );
            const hasActive = activeRequestsSnap.docs.some(doc =>
                ['pending', 'approved', 'borrowed', 'returned'].includes(doc.data().status)
            );
            if (hasActive) {
                throw new HttpsError('already-exists', 'You already have an active request for this item.');
            }

            const requestType = type || (
                (itemData.listing_type === 'giveaway' || itemData.intent === 'donate')
                    ? TRANSACTION_TYPES.GIVEAWAY
                    : TRANSACTION_TYPES.BORROW
            );

            const newRequestRef = db.collection('requests').doc();
            createdRequestId = newRequestRef.id;

            transaction.set(newRequestRef, {
                item_id: itemId,
                borrower_id: actorId,
                lender_id: itemData.owner_id, // server-derived
                type: requestType,
                duration: duration || 'flexible',
                message: message || '',
                circle_id: itemData.circle_id || null,
                circle_ids: itemData.circle_ids || [],
                status: REQUEST_STATUSES.PENDING,
                created_at: FieldValue.serverTimestamp(),
                updated_at: FieldValue.serverTimestamp()
            });

            // Write initial immutable transaction event
            const eventRef = db.collection('transaction_events').doc();
            transaction.set(eventRef, {
                request_id: createdRequestId,
                item_id: itemId,
                actor_id: actorId,
                event_type: 'requested',
                from_status: null,
                to_status: REQUEST_STATUSES.PENDING,
                metadata: { type: requestType, duration: duration || 'flexible' },
                created_at: FieldValue.serverTimestamp()
            });
        });

        return { success: true, id: createdRequestId };
    } catch (err) {
        if (err instanceof HttpsError) throw err;
        throw new HttpsError('internal', err.message);
    }
});

/**
 * Callable Function: transitionRequest
 * Validates and executes state transitions for borrow and giveaway transactions.
 * Updates item status and aggregates, records immutable transaction events,
 * and maintains the impact ledger.
 */
export const transitionRequest = onCall({ cors: true }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated.');
    }
    const actorId = request.auth.uid;
    const { requestId, action, metadata } = request.data || {};

    if (!requestId || !action) {
        throw new HttpsError('invalid-argument', 'requestId and action are required.');
    }

    try {
        const requestRef = db.collection('requests').doc(requestId);
        let transitionResult = null;

        await db.runTransaction(async (transaction) => {
            const reqDoc = await transaction.get(requestRef);
            if (!reqDoc.exists) {
                throw new HttpsError('not-found', 'Request not found.');
            }
            const requestData = { id: reqDoc.id, ...reqDoc.data() };

            const itemRef = db.collection('items').doc(requestData.item_id);
            const itemDoc = await transaction.get(itemRef);
            const itemData = itemDoc.exists ? itemDoc.data() : null;

            // Validate transition rules
            try {
                transitionResult = validateTransition({
                    action,
                    requestData,
                    itemData,
                    actorId
                });
            } catch (validationErr) {
                throw new HttpsError('failed-precondition', validationErr.message);
            }

            // Update request aggregate
            transaction.update(requestRef, {
                ...transitionResult.requestUpdates,
                updated_at: FieldValue.serverTimestamp()
            });

            // Update item if needed
            if (itemDoc.exists && transitionResult.itemUpdates && Object.keys(transitionResult.itemUpdates).length > 0) {
                transaction.update(itemRef, {
                    ...transitionResult.itemUpdates,
                    updated_at: FieldValue.serverTimestamp()
                });
            }

            // Write immutable transaction event
            const eventRef = db.collection('transaction_events').doc();
            transaction.set(eventRef, {
                request_id: requestId,
                item_id: requestData.item_id,
                actor_id: actorId,
                event_type: transitionResult.eventType,
                from_status: requestData.status,
                to_status: transitionResult.nextStatus,
                metadata: metadata || {},
                created_at: FieldValue.serverTimestamp()
            });

            // Manage impact ledger if completing or reversing
            if (transitionResult.impactCredit) {
                const isDonation = requestData.type === TRANSACTION_TYPES.GIVEAWAY;
                const creditKg = 2;
                const participants = [
                    { id: requestData.lender_id, role: 'lender' },
                    { id: requestData.borrower_id, role: 'borrower' }
                ];
                for (const p of participants) {
                    const impactRef = db.collection('impact_events').doc();
                    transaction.set(impactRef, {
                        actor_id: actorId,
                        beneficiary_id: p.id,
                        role: p.role,
                        credit_kg: creditKg,
                        request_id: requestId,
                        item_id: requestData.item_id,
                        kind: isDonation ? 'donation' : 'loan',
                        created_at: FieldValue.serverTimestamp()
                    });
                }
            } else if (transitionResult.reversalImpact) {
                // Reversal: Find existing positive credits and append reversals
                const ledgerSnap = await transaction.get(
                    db.collection('impact_events').where('request_id', '==', requestId)
                );
                for (const doc of ledgerSnap.docs) {
                    const data = doc.data();
                    if (typeof data.credit_kg === 'number' && data.credit_kg > 0) {
                        const reversalRef = db.collection('impact_events').doc();
                        transaction.set(reversalRef, {
                            actor_id: actorId,
                            beneficiary_id: data.beneficiary_id,
                            role: data.role,
                            credit_kg: -data.credit_kg,
                            request_id: requestId,
                            item_id: requestData.item_id,
                            kind: 'reversal',
                            reverses_event_id: doc.id,
                            created_at: FieldValue.serverTimestamp()
                        });
                    }
                }
            }
        });

        return {
            success: true,
            status: transitionResult.nextStatus,
            eventType: transitionResult.eventType
        };
    } catch (err) {
        if (err instanceof HttpsError) throw err;
        throw new HttpsError('internal', err.message);
    }
});

/**
 * Callable Function: findOrCreateBook
 * Finds an existing canonical book by ISBN or Title+Author,
 * or creates a new canonical book record.
 */
export const findOrCreateBook = onCall({ cors: true }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const actorId = request.auth.uid;
    const bookData = request.data || {};

    if (!bookData.title || typeof bookData.title !== 'string' || !bookData.title.trim()) {
        throw new HttpsError('invalid-argument', 'Book title is required.');
    }

    try {
        const normIsbn = normalizeIsbn(bookData.isbn || bookData.isbn_13 || bookData.isbn_10 || '');
        const normTitle = normalizeTitle(bookData.title);
        const { authors, authors_normalized } = normalizeAuthors(bookData.authors || []);

        let matchedDoc = null;

        // 1. Try deterministic doc id if ISBN-13 is valid
        if (normIsbn.valid && normIsbn.isbn13) {
            const directDoc = await db.collection('books').doc(`isbn_${normIsbn.isbn13}`).get();
            if (directDoc.exists) {
                matchedDoc = { id: directDoc.id, ...directDoc.data() };
            }
        }

        // 2. Try querying by ISBN across isbns array
        if (!matchedDoc && normIsbn.isbns.length > 0) {
            for (const code of normIsbn.isbns) {
                const snap = await db.collection('books')
                    .where('isbns', 'array-contains', code)
                    .limit(1)
                    .get();
                if (!snap.empty) {
                    matchedDoc = { id: snap.docs[0].id, ...snap.docs[0].data() };
                    break;
                }
            }
        }

        // 3. Fallback: Query by normalized title and check author
        if (!matchedDoc && normTitle) {
            const titleSnap = await db.collection('books')
                .where('title_normalized', '==', normTitle)
                .limit(10)
                .get();

            if (!titleSnap.empty) {
                if (authors_normalized.length > 0) {
                    for (const doc of titleSnap.docs) {
                        const data = doc.data();
                        const existingAuthorsNorm = data.authors_normalized || [];
                        const hasMatchingAuthor = authors_normalized.some(a => existingAuthorsNorm.includes(a));
                        if (hasMatchingAuthor) {
                            matchedDoc = { id: doc.id, ...data };
                            break;
                        }
                    }
                } else {
                    matchedDoc = { id: titleSnap.docs[0].id, ...titleSnap.docs[0].data() };
                }
            }
        }

        if (matchedDoc) {
            return {
                created: false,
                book: matchedDoc,
                copiesStatus: getBookCopiesStatus(matchedDoc)
            };
        }

        // No match found -> create new canonical book
        const payload = buildCanonicalBookPayload({
            ...bookData,
            created_at: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp()
        }, actorId);

        const docId = normIsbn.valid && normIsbn.isbn13 
            ? `isbn_${normIsbn.isbn13}` 
            : db.collection('books').doc().id;

        const docRef = db.collection('books').doc(docId);
        await docRef.set(payload);

        const createdBook = {
            id: docId,
            ...payload
        };

        return {
            created: true,
            book: createdBook,
            copiesStatus: getBookCopiesStatus(createdBook)
        };
    } catch (err) {
        if (err instanceof HttpsError) throw err;
        throw new HttpsError('internal', err.message);
    }
});

/**
 * Callable Function: lookupBookMetadata
 * Server-side metadata lookup with Open Library as primary and Google Books
 * as fallback, with rate limiting and caching.
 */
export const lookupBookMetadata = onCall({ cors: true }, async (request) => {
    const actorId = request.auth ? request.auth.uid : null;
    const { isbn, query } = request.data || {};

    try {
        const result = await performLookup({ isbn, query, actorId }, { db });
        return result;
    } catch (err) {
        throw new HttpsError('internal', err.message);
    }
});

export {
    TRANSACTION_TYPES,
    REQUEST_STATUSES,
    ACTIONS,
    cleanIsbn,
    normalizeIsbn,
    normalizeTitle,
    normalizeAuthor,
    normalizeAuthors,
    buildCanonicalBookPayload,
    getBookCopiesStatus,
    performLookup
};
