/**
 * Server-side transaction state machine for NeighborGoods / A World of Books.
 * Implements Issue #2 & #3: Enforces valid state transitions, roles, item availability,
 * and immutable event recording for borrow and giveaway transactions.
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

export const ACTIONS = {
    CREATE: 'create',
    APPROVE: 'approve',
    DECLINE: 'decline',
    CANCEL: 'cancel',
    PICKUP: 'pickup',
    RETURN: 'return',
    COMPLETE: 'complete',
    COMPLETE_GIVEAWAY: 'complete_giveaway',
    UNDO: 'undo'
};

/**
 * Validates whether an action is permitted given current transaction state and actor.
 */
export function validateTransition({
    action,
    requestData,
    itemData,
    actorId,
    targetUndoStatus
}) {
    if (!actorId) {
        throw new Error('Authentication required.');
    }

    const type = requestData.type || (
        (itemData && (itemData.listing_type === 'giveaway' || itemData.intent === 'donate'))
            ? TRANSACTION_TYPES.GIVEAWAY
            : TRANSACTION_TYPES.BORROW
    );

    const currentStatus = requestData.status;
    const isLender = actorId === requestData.lender_id;
    const isBorrower = actorId === requestData.borrower_id;

    switch (action) {
        case ACTIONS.APPROVE:
            if (!isLender) throw new Error('Only the lender can approve a request.');
            if (currentStatus !== REQUEST_STATUSES.PENDING) {
                throw new Error(`Cannot approve request in '${currentStatus}' status. Must be pending.`);
            }
            if (itemData && itemData.is_available === false && itemData.active_request_id && itemData.active_request_id !== requestData.id) {
                throw new Error('This item is currently unavailable or assigned to another active request.');
            }
            return {
                nextStatus: REQUEST_STATUSES.APPROVED,
                eventType: 'approved',
                itemUpdates: { is_available: false, active_request_id: requestData.id, status: 'approved' },
                requestUpdates: { status: REQUEST_STATUSES.APPROVED, confirmed_at: new Date() }
            };

        case ACTIONS.DECLINE:
            if (!isLender) throw new Error('Only the lender can decline a request.');
            if (currentStatus !== REQUEST_STATUSES.PENDING) {
                throw new Error(`Cannot decline request in '${currentStatus}' status. Must be pending.`);
            }
            return {
                nextStatus: REQUEST_STATUSES.DECLINED,
                eventType: 'declined',
                itemUpdates: {},
                requestUpdates: { status: REQUEST_STATUSES.DECLINED, declined_at: new Date() }
            };

        case ACTIONS.CANCEL:
            if (!isBorrower && !isLender) throw new Error('Only participants can cancel a request.');
            if (currentStatus !== REQUEST_STATUSES.PENDING && currentStatus !== REQUEST_STATUSES.APPROVED) {
                throw new Error(`Cannot cancel a transaction after handoff (status: '${currentStatus}').`);
            }
            return {
                nextStatus: REQUEST_STATUSES.CANCELLED,
                eventType: 'cancelled',
                itemUpdates: (itemData && itemData.active_request_id === requestData.id) ? {
                    active_request_id: null,
                    is_available: true,
                    status: 'available'
                } : {},
                requestUpdates: { status: REQUEST_STATUSES.CANCELLED, cancelled_at: new Date() }
            };

        case ACTIONS.PICKUP:
            if (!isBorrower && !isLender) throw new Error('Only borrower or lender can mark item as picked up.');
            if (currentStatus !== REQUEST_STATUSES.APPROVED) {
                throw new Error(`Item must be approved before pickup (current: '${currentStatus}').`);
            }
            return {
                nextStatus: REQUEST_STATUSES.BORROWED,
                eventType: 'picked_up',
                itemUpdates: { status: 'borrowed', is_available: false },
                requestUpdates: { status: REQUEST_STATUSES.BORROWED, picked_up_at: new Date() }
            };

        case ACTIONS.RETURN:
            if (!isBorrower) throw new Error('Only the borrower can mark an item as returned.');
            if (type === TRANSACTION_TYPES.GIVEAWAY) {
                throw new Error('Giveaway items are permanent transfers and cannot be marked returned.');
            }
            if (currentStatus !== REQUEST_STATUSES.BORROWED) {
                throw new Error(`Only borrowed items can be marked returned (current: '${currentStatus}').`);
            }
            return {
                nextStatus: REQUEST_STATUSES.RETURNED,
                eventType: 'returned',
                itemUpdates: { status: 'returned' },
                requestUpdates: { status: REQUEST_STATUSES.RETURNED, returned_at: new Date() }
            };

        case ACTIONS.COMPLETE:
        case ACTIONS.COMPLETE_GIVEAWAY:
            if (!isLender) throw new Error('Only the lender can confirm completion.');
            if (type === TRANSACTION_TYPES.GIVEAWAY) {
                if (currentStatus !== REQUEST_STATUSES.APPROVED && currentStatus !== REQUEST_STATUSES.BORROWED) {
                    throw new Error(`Giveaway must be approved before completion (current: '${currentStatus}').`);
                }
                return {
                    nextStatus: REQUEST_STATUSES.COMPLETED,
                    eventType: 'giveaway_completed',
                    itemUpdates: { status: 'transferred', is_available: false, active_request_id: null },
                    requestUpdates: { status: REQUEST_STATUSES.COMPLETED, completed_at: new Date() },
                    impactCredit: true
                };
            } else {
                if (currentStatus !== REQUEST_STATUSES.RETURNED) {
                    throw new Error(`Return must be marked by borrower before confirmation (current: '${currentStatus}').`);
                }
                return {
                    nextStatus: REQUEST_STATUSES.COMPLETED,
                    eventType: 'borrow_completed',
                    itemUpdates: { status: 'available', is_available: true, active_request_id: null },
                    requestUpdates: { status: REQUEST_STATUSES.COMPLETED, completed_at: new Date() },
                    impactCredit: true
                };
            }

        case ACTIONS.UNDO:
            if (currentStatus === REQUEST_STATUSES.COMPLETED) {
                if (!isLender) throw new Error('Only the lender can undo completion.');
                const prev = (type === TRANSACTION_TYPES.GIVEAWAY) ? REQUEST_STATUSES.APPROVED : REQUEST_STATUSES.RETURNED;
                return {
                    nextStatus: prev,
                    eventType: 'reversal_undo_completed',
                    itemUpdates: { status: prev, is_available: false, active_request_id: requestData.id },
                    requestUpdates: { status: prev, completed_at: null },
                    reversalImpact: true
                };
            } else if (currentStatus === REQUEST_STATUSES.RETURNED) {
                if (!isBorrower) throw new Error('Only the borrower can undo return.');
                return {
                    nextStatus: REQUEST_STATUSES.BORROWED,
                    eventType: 'reversal_undo_returned',
                    itemUpdates: { status: 'borrowed' },
                    requestUpdates: { status: REQUEST_STATUSES.BORROWED, returned_at: null }
                };
            } else if (currentStatus === REQUEST_STATUSES.BORROWED) {
                if (!isBorrower && !isLender) throw new Error('Only participants can undo pickup.');
                return {
                    nextStatus: REQUEST_STATUSES.APPROVED,
                    eventType: 'reversal_undo_picked_up',
                    itemUpdates: { status: 'approved' },
                    requestUpdates: { status: REQUEST_STATUSES.APPROVED, picked_up_at: null }
                };
            } else if (currentStatus === REQUEST_STATUSES.APPROVED) {
                if (!isLender) throw new Error('Only the lender can undo approval.');
                return {
                    nextStatus: REQUEST_STATUSES.PENDING,
                    eventType: 'reversal_undo_approved',
                    itemUpdates: { status: 'available', is_available: true, active_request_id: null },
                    requestUpdates: { status: REQUEST_STATUSES.PENDING, confirmed_at: null }
                };
            } else {
                throw new Error(`Cannot undo from '${currentStatus}' status.`);
            }

        default:
            throw new Error(`Unknown action: '${action}'.`);
    }
}
