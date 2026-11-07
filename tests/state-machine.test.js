import assert from 'assert';
import {
    validateTransition,
    ACTIONS,
    REQUEST_STATUSES,
    TRANSACTION_TYPES
} from '../functions/state-machine.js';

console.log('Testing transaction state machine...');

const ALICE = 'alice-lender';
const BOB = 'bob-borrower';
const STRANGER = 'charlie-stranger';

// 1. Borrow Lifecycle
{
    const req = { id: 'req1', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.PENDING, type: 'borrow' };
    const item = { id: 'item1', owner_id: ALICE, is_available: true };

    // Approve
    const approveRes = validateTransition({ action: ACTIONS.APPROVE, requestData: req, itemData: item, actorId: ALICE });
    assert.strictEqual(approveRes.nextStatus, REQUEST_STATUSES.APPROVED);
    assert.strictEqual(approveRes.eventType, 'approved');

    // Stranger cannot approve
    assert.throws(() => validateTransition({ action: ACTIONS.APPROVE, requestData: req, itemData: item, actorId: STRANGER }), /Only the lender/);

    // Borrower cannot approve
    assert.throws(() => validateTransition({ action: ACTIONS.APPROVE, requestData: req, itemData: item, actorId: BOB }), /Only the lender/);

    // Pickup
    req.status = REQUEST_STATUSES.APPROVED;
    const pickupRes = validateTransition({ action: ACTIONS.PICKUP, requestData: req, itemData: item, actorId: BOB });
    assert.strictEqual(pickupRes.nextStatus, REQUEST_STATUSES.BORROWED);
    assert.strictEqual(pickupRes.eventType, 'picked_up');

    // Return
    req.status = REQUEST_STATUSES.BORROWED;
    const returnRes = validateTransition({ action: ACTIONS.RETURN, requestData: req, itemData: item, actorId: BOB });
    assert.strictEqual(returnRes.nextStatus, REQUEST_STATUSES.RETURNED);
    assert.strictEqual(returnRes.eventType, 'returned');

    // Lender cannot mark returned
    assert.throws(() => validateTransition({ action: ACTIONS.RETURN, requestData: req, itemData: item, actorId: ALICE }), /Only the borrower/);

    // Complete Borrow
    req.status = REQUEST_STATUSES.RETURNED;
    const completeRes = validateTransition({ action: ACTIONS.COMPLETE, requestData: req, itemData: item, actorId: ALICE });
    assert.strictEqual(completeRes.nextStatus, REQUEST_STATUSES.COMPLETED);
    assert.strictEqual(completeRes.eventType, 'borrow_completed');
    assert.strictEqual(completeRes.impactCredit, true);

    // Cannot complete before return
    req.status = REQUEST_STATUSES.BORROWED;
    assert.throws(() => validateTransition({ action: ACTIONS.COMPLETE, requestData: req, itemData: item, actorId: ALICE }), /Return must be marked/);
}

// 2. Giveaway Lifecycle (direct completion from approved without pretending return)
{
    const req = { id: 'req2', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.PENDING, type: 'giveaway' };
    const item = { id: 'item2', owner_id: ALICE, is_available: true, listing_type: 'giveaway' };

    // Approve
    const approveRes = validateTransition({ action: ACTIONS.APPROVE, requestData: req, itemData: item, actorId: ALICE });
    assert.strictEqual(approveRes.nextStatus, REQUEST_STATUSES.APPROVED);

    // Complete Giveaway from approved
    req.status = REQUEST_STATUSES.APPROVED;
    const completeRes = validateTransition({ action: ACTIONS.COMPLETE, requestData: req, itemData: item, actorId: ALICE });
    assert.strictEqual(completeRes.nextStatus, REQUEST_STATUSES.COMPLETED);
    assert.strictEqual(completeRes.eventType, 'giveaway_completed');
    assert.strictEqual(completeRes.impactCredit, true);
    assert.strictEqual(completeRes.itemUpdates.status, 'transferred');

    // Cannot mark giveaway as returned
    req.status = REQUEST_STATUSES.BORROWED;
    assert.throws(() => validateTransition({ action: ACTIONS.RETURN, requestData: req, itemData: item, actorId: BOB }), /Giveaway items are permanent transfers/);
}

// 3. Undos & Reversals
{
    // Undo completed borrow
    const reqBorrow = { id: 'req3', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.COMPLETED, type: 'borrow' };
    const undoCompBorrow = validateTransition({ action: ACTIONS.UNDO, requestData: reqBorrow, actorId: ALICE });
    assert.strictEqual(undoCompBorrow.nextStatus, REQUEST_STATUSES.RETURNED);
    assert.strictEqual(undoCompBorrow.reversalImpact, true);

    // Undo completed giveaway reverts to approved
    const reqGiveaway = { id: 'req4', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.COMPLETED, type: 'giveaway' };
    const undoCompGiveaway = validateTransition({ action: ACTIONS.UNDO, requestData: reqGiveaway, actorId: ALICE });
    assert.strictEqual(undoCompGiveaway.nextStatus, REQUEST_STATUSES.APPROVED);
    assert.strictEqual(undoCompGiveaway.reversalImpact, true);

    // Undo returned -> borrowed
    const reqRet = { id: 'req5', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.RETURNED, type: 'borrow' };
    const undoRet = validateTransition({ action: ACTIONS.UNDO, requestData: reqRet, actorId: BOB });
    assert.strictEqual(undoRet.nextStatus, REQUEST_STATUSES.BORROWED);

    // Undo borrowed -> approved
    const reqBow = { id: 'req6', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.BORROWED, type: 'borrow' };
    const undoBow = validateTransition({ action: ACTIONS.UNDO, requestData: reqBow, actorId: BOB });
    assert.strictEqual(undoBow.nextStatus, REQUEST_STATUSES.APPROVED);

    // Undo approved -> pending
    const reqApp = { id: 'req7', lender_id: ALICE, borrower_id: BOB, status: REQUEST_STATUSES.APPROVED, type: 'borrow' };
    const undoApp = validateTransition({ action: ACTIONS.UNDO, requestData: reqApp, actorId: ALICE });
    assert.strictEqual(undoApp.nextStatus, REQUEST_STATUSES.PENDING);
    assert.strictEqual(undoApp.itemUpdates.is_available, true);
}

// 4. Extended Transaction Model & Payload Builders (Issue #13)
{
    const { buildTransactionPayload, buildTransactionEventPayload, FULFILLMENT_METHODS, SHIPPING_PAYERS } = await import('../functions/state-machine.js');

    // Borrow transaction payload
    const borrowItem = { id: 'item_gatsby', book_id: 'book_gatsby', owner_id: ALICE, circle_id: 'circle_books' };
    const borrowPayload = buildTransactionPayload({
        fulfillment_method: FULFILLMENT_METHODS.PICKUP,
        duration: '2 weeks'
    }, { itemData: borrowItem, actorId: BOB });

    assert.strictEqual(borrowPayload.type, 'borrow');
    assert.strictEqual(borrowPayload.item_id, 'item_gatsby');
    assert.strictEqual(borrowPayload.book_id, 'book_gatsby');
    assert.strictEqual(borrowPayload.borrower_id, BOB);
    assert.strictEqual(borrowPayload.lender_id, ALICE);
    assert.deepStrictEqual(borrowPayload.participant_ids, [BOB, ALICE]);
    assert.strictEqual(borrowPayload.status, REQUEST_STATUSES.PENDING);
    assert.strictEqual(borrowPayload.fulfillment_method, 'pickup');
    assert.strictEqual(borrowPayload.timeline.length, 1);
    assert.strictEqual(borrowPayload.last_event_type, 'requested');

    // Swap transaction payload
    const swapTargetItem = { id: 'item_hobbit', book_id: 'book_hobbit', owner_id: ALICE, listing_type: 'swap' };
    const offeredSwapItem = { id: 'item_1984', book_id: 'book_1984', owner_id: BOB, listing_type: 'swap' };

    const swapPayload = buildTransactionPayload({
        type: 'swap',
        offered_item_id: offeredSwapItem.id,
        fulfillment_method: FULFILLMENT_METHODS.SHIPPING,
        shipping_payer: SHIPPING_PAYERS.SPLIT,
        shipping_notes: 'USPS Media Mail with tracking'
    }, { itemData: swapTargetItem, offeredItemData: offeredSwapItem, actorId: BOB });

    assert.strictEqual(swapPayload.type, 'swap');
    assert.strictEqual(swapPayload.item_id, 'item_hobbit');
    assert.strictEqual(swapPayload.book_id, 'book_hobbit');
    assert.strictEqual(swapPayload.offered_item_id, 'item_1984');
    assert.strictEqual(swapPayload.offered_book_id, 'book_1984');
    assert.strictEqual(swapPayload.fulfillment_method, 'shipping');
    assert.strictEqual(swapPayload.shipping_payer, 'split');
    assert.strictEqual(swapPayload.shipping_notes, 'USPS Media Mail with tracking');

    // Reject swap without offered item
    assert.throws(() => {
        buildTransactionPayload({ type: 'swap' }, { itemData: swapTargetItem, actorId: BOB });
    }, /A swap request requires an offered item/);

    // Reject swap offering someone else's item
    const strangerItem = { id: 'item_stranger', owner_id: STRANGER };
    assert.throws(() => {
        buildTransactionPayload({ type: 'swap', offered_item_id: 'item_stranger' }, {
            itemData: swapTargetItem,
            offeredItemData: strangerItem,
            actorId: BOB
        });
    }, /You can only offer items you own/);

    // Transaction event payload builder
    const eventPayload = buildTransactionEventPayload({
        request_id: 'req_123',
        actor_id: BOB,
        borrower_id: BOB,
        lender_id: ALICE,
        item_id: 'item_gatsby',
        book_id: 'book_gatsby',
        circle_id: 'circle_books',
        event_type: 'requested',
        to_status: 'pending',
        transaction_type: 'borrow',
        fulfillment_method: 'pickup'
    });

    assert.strictEqual(eventPayload.request_id, 'req_123');
    assert.strictEqual(eventPayload.actor_id, BOB);
    assert.deepStrictEqual(eventPayload.participant_ids, [BOB, ALICE]);
    assert.strictEqual(eventPayload.book_id, 'book_gatsby');
    assert.strictEqual(eventPayload.circle_id, 'circle_books');
}

console.log('[PASS] State machine validation passed all tests.');
