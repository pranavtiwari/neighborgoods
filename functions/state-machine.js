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

export const FULFILLMENT_METHODS = {
    PICKUP: 'pickup',
    SHIPPING: 'shipping',
    BOTH: 'both'
};

export const SHIPPING_PAYERS = {
    REQUESTER: 'requester',
    OWNER: 'owner',
    SPLIT: 'split',
    FREE: 'free'
};

export const REQUEST_STATUSES = {
    PENDING: 'pending',
    APPROVED: 'approved',
    BORROWED: 'borrowed',
    SHIPPED: 'shipped',
    DELIVERED: 'delivered',
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
    SHIP: 'ship',
    DELIVER: 'deliver',
    RETURN: 'return',
    COMPLETE: 'complete',
    COMPLETE_GIVEAWAY: 'complete_giveaway',
    CONFIRM_SWAP: 'confirm_swap',
    UNDO: 'undo'
};

/**
 * Builds a validated, normalized transaction (request) payload.
 * @param {Object} input 
 * @param {Object} context { itemData, offeredItemData, actorId }
 * @returns {Object}
 */
export function buildTransactionPayload(input = {}, { itemData, offeredItemData, actorId } = {}) {
    if (!actorId) throw new Error('Authentication required.');
    if (!itemData || !itemData.id) throw new Error('Target item is required.');
    if (itemData.owner_id === actorId) throw new Error('You cannot transact with your own item.');

    const rawType = input.type || (
        (itemData.listing_type === 'giveaway' || itemData.intent === 'donate')
            ? TRANSACTION_TYPES.GIVEAWAY
            : (itemData.listing_type === 'swap' ? TRANSACTION_TYPES.SWAP : TRANSACTION_TYPES.BORROW)
    );

    const type = Object.values(TRANSACTION_TYPES).includes(rawType) ? rawType : TRANSACTION_TYPES.BORROW;

    let offeredItemId = null;
    let offeredBookId = null;

    if (type === TRANSACTION_TYPES.SWAP) {
        offeredItemId = offeredItemData?.id || input.offered_item_id || null;
        if (!offeredItemId) {
            throw new Error('A swap request requires an offered item.');
        }
        if (offeredItemData && offeredItemData.owner_id && offeredItemData.owner_id !== actorId) {
            throw new Error('You can only offer items you own in a swap.');
        }
        offeredBookId = offeredItemData?.book_id || input.offered_book_id || null;
    }

    const fulfillment = Object.values(FULFILLMENT_METHODS).includes(input.fulfillment_method)
        ? input.fulfillment_method
        : FULFILLMENT_METHODS.PICKUP;

    const shippingPayer = Object.values(SHIPPING_PAYERS).includes(input.shipping_payer)
        ? input.shipping_payer
        : null;

    const circleId = itemData.circle_id || null;
    const circleIds = Array.isArray(itemData.circle_ids) ? itemData.circle_ids : (circleId ? [circleId] : []);

    const now = input.created_at || new Date();

    return {
        item_id: itemData.id,
        book_id: itemData.book_id || null,
        offered_item_id: offeredItemId,
        offered_book_id: offeredBookId,
        borrower_id: actorId,
        lender_id: itemData.owner_id,
        participant_ids: [actorId, itemData.owner_id],
        type,
        status: REQUEST_STATUSES.PENDING,
        circle_id: circleId,
        circle_ids: circleIds,
        fulfillment_method: fulfillment,
        shipping_payer: shippingPayer,
        shipping_notes: input.shipping_notes ? String(input.shipping_notes).trim() : '',
        carrier: input.carrier ? String(input.carrier).trim() : null,
        tracking_number: input.tracking_number ? String(input.tracking_number).trim() : null,
        return_due_date: input.return_due_date || null,
        duration: input.duration || 'flexible',
        notes: input.notes ? String(input.notes).trim() : '',
        timeline: [
            {
                status: REQUEST_STATUSES.PENDING,
                actor_id: actorId,
                event_type: 'requested',
                created_at: now
            }
        ],
        last_event_id: null,
        last_event_type: 'requested',
        created_at: now,
        updated_at: now
    };
}

/**
 * Builds a validated, normalized transaction event payload.
 * @param {Object} input 
 * @returns {Object}
 */
export function buildTransactionEventPayload(input = {}) {
    if (!input.request_id) throw new Error('request_id is required.');
    if (!input.actor_id) throw new Error('actor_id is required.');
    if (!input.event_type) throw new Error('event_type is required.');
    if (!input.to_status) throw new Error('to_status is required.');

    const participantIds = Array.isArray(input.participant_ids) && input.participant_ids.length > 0
        ? input.participant_ids
        : [input.borrower_id, input.lender_id].filter(Boolean);

    const circleIds = Array.isArray(input.circle_ids)
        ? input.circle_ids
        : (input.circle_id ? [input.circle_id] : []);

    return {
        request_id: input.request_id,
        transaction_type: input.transaction_type || input.type || TRANSACTION_TYPES.BORROW,
        item_id: input.item_id || null,
        book_id: input.book_id || null,
        offered_item_id: input.offered_item_id || null,
        offered_book_id: input.offered_book_id || null,
        circle_id: input.circle_id || null,
        circle_ids: circleIds,
        actor_id: input.actor_id,
        borrower_id: input.borrower_id || null,
        lender_id: input.lender_id || null,
        participant_ids: participantIds,
        event_type: input.event_type,
        from_status: input.from_status !== undefined ? input.from_status : null,
        to_status: input.to_status,
        fulfillment_method: input.fulfillment_method || FULFILLMENT_METHODS.PICKUP,
        metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
        created_at: input.created_at || new Date()
    };
}

/**
 * Validates whether an action is permitted given current transaction state and actor.
 */
export function validateTransition({
    action,
    requestData,
    itemData,
    offeredItemData,
    actorId,
    targetUndoStatus
}) {
    if (!actorId) {
        throw new Error('Authentication required.');
    }

    const type = requestData.type || (
        (itemData && (itemData.listing_type === 'giveaway' || itemData.intent === 'donate'))
            ? TRANSACTION_TYPES.GIVEAWAY
            : (itemData && itemData.listing_type === 'swap' ? TRANSACTION_TYPES.SWAP : TRANSACTION_TYPES.BORROW)
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
            if (type === TRANSACTION_TYPES.SWAP && offeredItemData) {
                if (offeredItemData.is_available === false && offeredItemData.active_request_id && offeredItemData.active_request_id !== requestData.id) {
                    throw new Error('The offered swap item is currently unavailable or assigned to another active request.');
                }
            }
            return {
                nextStatus: REQUEST_STATUSES.APPROVED,
                eventType: 'approved',
                itemUpdates: { is_available: false, active_request_id: requestData.id, status: 'approved' },
                offeredItemUpdates: (type === TRANSACTION_TYPES.SWAP && offeredItemData) ? {
                    is_available: false,
                    active_request_id: requestData.id,
                    status: 'approved'
                } : null,
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
                offeredItemUpdates: (type === TRANSACTION_TYPES.SWAP && offeredItemData && offeredItemData.active_request_id === requestData.id) ? {
                    active_request_id: null,
                    is_available: true,
                    status: 'available'
                } : null,
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
                offeredItemUpdates: (type === TRANSACTION_TYPES.SWAP && offeredItemData && offeredItemData.active_request_id === requestData.id) ? {
                    active_request_id: null,
                    is_available: true,
                    status: 'available'
                } : null,
                requestUpdates: { status: REQUEST_STATUSES.CANCELLED, cancelled_at: new Date() }
            };

        case ACTIONS.CONFIRM_SWAP: {
            if (!isBorrower && !isLender) throw new Error('Only swap participants can confirm exchange.');
            if (type !== TRANSACTION_TYPES.SWAP) {
                throw new Error('confirm_swap is only valid for swap transactions.');
            }
            if (currentStatus !== REQUEST_STATUSES.APPROVED) {
                throw new Error(`Swap must be approved before exchange confirmation (current: '${currentStatus}').`);
            }
            const swapNow = new Date();
            const isBorrowerConfirming = isBorrower;
            const otherAlreadyConfirmed = isBorrowerConfirming
                ? Boolean(requestData.lender_confirmed_at || requestData.owner_confirmed_at)
                : Boolean(requestData.borrower_confirmed_at || requestData.requester_confirmed_at);

            if (otherAlreadyConfirmed) {
                return {
                    nextStatus: REQUEST_STATUSES.COMPLETED,
                    eventType: 'swap_completed',
                    itemUpdates: { status: 'completed', is_available: false, active_request_id: null },
                    offeredItemUpdates: { status: 'completed', is_available: false, active_request_id: null },
                    requestUpdates: {
                        status: REQUEST_STATUSES.COMPLETED,
                        completed_at: swapNow,
                        [isBorrowerConfirming ? 'borrower_confirmed_at' : 'lender_confirmed_at']: swapNow,
                        [isBorrowerConfirming ? 'requester_confirmed_at' : 'owner_confirmed_at']: swapNow
                    },
                    impactCredit: true,
                    isDualCredit: true
                };
            } else {
                return {
                    nextStatus: REQUEST_STATUSES.APPROVED,
                    eventType: isBorrowerConfirming ? 'swap_confirmed_by_requester' : 'swap_confirmed_by_owner',
                    itemUpdates: {},
                    offeredItemUpdates: {},
                    requestUpdates: {
                        [isBorrowerConfirming ? 'borrower_confirmed_at' : 'lender_confirmed_at']: swapNow,
                        [isBorrowerConfirming ? 'requester_confirmed_at' : 'owner_confirmed_at']: swapNow
                    },
                    impactCredit: false
                };
            }
        }

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

        case ACTIONS.SHIP:
            if (!isLender && !isBorrower) throw new Error('Only transaction participants can mark shipping.');
            if (currentStatus !== REQUEST_STATUSES.APPROVED) {
                throw new Error(`Item must be approved before shipping (current: '${currentStatus}').`);
            }
            return {
                nextStatus: REQUEST_STATUSES.SHIPPED,
                eventType: 'shipped',
                itemUpdates: { status: 'shipped', is_available: false },
                requestUpdates: { status: REQUEST_STATUSES.SHIPPED, shipped_at: new Date() }
            };

        case ACTIONS.DELIVER:
            if (!isBorrower && !isLender) throw new Error('Only transaction participants can mark delivery.');
            if (currentStatus !== REQUEST_STATUSES.SHIPPED) {
                throw new Error(`Item must be shipped before delivery (current: '${currentStatus}').`);
            }
            return {
                nextStatus: REQUEST_STATUSES.DELIVERED,
                eventType: 'delivered',
                itemUpdates: { status: 'delivered', is_available: false },
                requestUpdates: { status: REQUEST_STATUSES.DELIVERED, delivered_at: new Date() }
            };

        case ACTIONS.RETURN:
            if (!isBorrower) throw new Error('Only the borrower can mark an item as returned.');
            if (type === TRANSACTION_TYPES.GIVEAWAY) {
                throw new Error('Giveaway items are permanent transfers and cannot be marked returned.');
            }
            if (currentStatus !== REQUEST_STATUSES.BORROWED && currentStatus !== REQUEST_STATUSES.DELIVERED) {
                throw new Error(`Only borrowed or delivered items can be marked returned (current: '${currentStatus}').`);
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
                if (currentStatus !== REQUEST_STATUSES.APPROVED && currentStatus !== REQUEST_STATUSES.BORROWED && currentStatus !== REQUEST_STATUSES.DELIVERED && currentStatus !== REQUEST_STATUSES.SHIPPED) {
                    throw new Error(`Giveaway must be approved, borrowed, or delivered before completion (current: '${currentStatus}').`);
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
            } else if (currentStatus === REQUEST_STATUSES.DELIVERED) {
                if (!isBorrower && !isLender) throw new Error('Only participants can undo delivery.');
                return {
                    nextStatus: REQUEST_STATUSES.SHIPPED,
                    eventType: 'reversal_undo_delivered',
                    itemUpdates: { status: 'shipped' },
                    requestUpdates: { status: REQUEST_STATUSES.SHIPPED, delivered_at: null }
                };
            } else if (currentStatus === REQUEST_STATUSES.SHIPPED) {
                if (!isBorrower && !isLender) throw new Error('Only participants can undo shipping.');
                return {
                    nextStatus: REQUEST_STATUSES.APPROVED,
                    eventType: 'reversal_undo_shipped',
                    itemUpdates: { status: 'approved' },
                    requestUpdates: { status: REQUEST_STATUSES.APPROVED, shipped_at: null }
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
