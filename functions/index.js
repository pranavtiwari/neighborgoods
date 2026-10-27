import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

// Initialize Firebase Admin SDK
initializeApp();

const db = getFirestore();

/**
 * Health check endpoint to verify callable functions deployment and emulator connectivity.
 */
export const healthCheck = onCall({ cors: true }, async (request) => {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        auth: request.auth ? { uid: request.auth.uid } : null
    };
});

/**
 * Shared transaction state constants and allowed transitions.
 * Used by server-side state machine in Issue #2.
 */
export const TRANSACTION_TYPES = {
    BORROW: 'borrow',
    GIVEAWAY: 'giveaway',
    SWAP: 'swap'
};

export const REQUEST_STATUSES = {
    PENDING: 'pending',
    APPROVED: 'approved',
    BORROWED: 'borrowed',
    RETURNED: 'returned',
    COMPLETED: 'completed',
    DECLINED: 'declined',
    CANCELLED: 'cancelled'
};

export const ALLOWED_TRANSITIONS = {
    [TRANSACTION_TYPES.BORROW]: {
        [REQUEST_STATUSES.PENDING]: [REQUEST_STATUSES.APPROVED, REQUEST_STATUSES.DECLINED, REQUEST_STATUSES.CANCELLED],
        [REQUEST_STATUSES.APPROVED]: [REQUEST_STATUSES.BORROWED, REQUEST_STATUSES.CANCELLED, REQUEST_STATUSES.PENDING], // pending via undo
        [REQUEST_STATUSES.BORROWED]: [REQUEST_STATUSES.RETURNED, REQUEST_STATUSES.APPROVED], // approved via undo
        [REQUEST_STATUSES.RETURNED]: [REQUEST_STATUSES.COMPLETED, REQUEST_STATUSES.BORROWED], // borrowed via undo
        [REQUEST_STATUSES.COMPLETED]: [REQUEST_STATUSES.RETURNED] // returned via undo
    },
    [TRANSACTION_TYPES.GIVEAWAY]: {
        [REQUEST_STATUSES.PENDING]: [REQUEST_STATUSES.APPROVED, REQUEST_STATUSES.DECLINED, REQUEST_STATUSES.CANCELLED],
        [REQUEST_STATUSES.APPROVED]: [REQUEST_STATUSES.COMPLETED, REQUEST_STATUSES.CANCELLED, REQUEST_STATUSES.PENDING], // direct completion
        [REQUEST_STATUSES.COMPLETED]: [REQUEST_STATUSES.APPROVED] // approved via undo
    }
};

/**
 * Helper to record an immutable transaction event to the ledger.
 */
export async function recordTransactionEvent(transaction, {
    requestId,
    itemId,
    actorId,
    eventType,
    fromStatus,
    toStatus,
    metadata = {}
}) {
    const eventRef = db.collection('transaction_events').doc();
    const eventData = {
        request_id: requestId,
        item_id: itemId,
        actor_id: actorId,
        event_type: eventType,
        from_status: fromStatus || null,
        to_status: toStatus,
        metadata,
        created_at: FieldValue.serverTimestamp()
    };
    transaction.set(eventRef, eventData);
    return eventRef.id;
}
