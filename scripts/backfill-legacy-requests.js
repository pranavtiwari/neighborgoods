/**
 * Migration Script: Backfill legacy requests (Issue #5)
 * Backfills lender_id, type, and best-effort transaction_events for legacy requests.
 * Supports --dry-run (default) and --apply.
 * 
 * Usage:
 *   node scripts/backfill-legacy-requests.js [--apply] [--project=demo-rules]
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const isApply = process.argv.includes('--apply');
const isDryRun = !isApply;

if (getApps().length === 0) {
    initializeApp({
        projectId: process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || 'demo-rules'
    });
}

const db = getFirestore();

export async function runBackfill(customDb = db, dryRun = isDryRun) {
    console.log(`Starting legacy requests backfill (Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'})...`);

    const report = {
        totalScanned: 0,
        updatedCount: 0,
        skippedCount: 0,
        unresolvedCount: 0,
        eventsCreated: 0,
        records: []
    };

    const requestsSnap = await customDb.collection('requests').get();
    report.totalScanned = requestsSnap.size;

    for (const doc of requestsSnap.docs) {
        const req = { id: doc.id, ...doc.data() };

        // Skip requests already marked legacy/quarantined in a previous run
        if (req.is_legacy) {
            report.skippedCount++;
            continue;
        }

        let needsUpdate = false;
        const updates = {};
        const eventsToCreate = [];
        let statusNotes = [];

        // 1. Backfill lender_id if missing
        if (!req.lender_id) {
            if (req.item_id) {
                const itemDoc = await customDb.collection('items').doc(req.item_id).get();
                if (itemDoc.exists && itemDoc.data().owner_id) {
                    updates.lender_id = itemDoc.data().owner_id;
                    needsUpdate = true;
                    statusNotes.push(`lender_id backfilled to '${updates.lender_id}'`);
                } else {
                    updates.is_legacy = true;
                    updates.legacy_status = 'unresolved_missing_item_or_owner';
                    needsUpdate = true;
                    report.unresolvedCount++;
                    statusNotes.push('marked legacy: item or owner not found');
                }
            } else {
                updates.is_legacy = true;
                updates.legacy_status = 'unresolved_no_item_id';
                needsUpdate = true;
                report.unresolvedCount++;
                statusNotes.push('marked legacy: missing item_id');
            }
        }

        // 2. Backfill transaction type if missing
        if (!req.type) {
            let derivedType = 'borrow';
            if (req.item_id) {
                const itemDoc = await customDb.collection('items').doc(req.item_id).get();
                if (itemDoc.exists) {
                    const itemData = itemDoc.data();
                    if (itemData.listing_type === 'giveaway' || itemData.intent === 'donate') {
                        derivedType = 'giveaway';
                    }
                }
            }
            updates.type = derivedType;
            needsUpdate = true;
            statusNotes.push(`type backfilled to '${derivedType}'`);
        }

        // 3. Reconstruct best-effort event history if no events exist
        const existingEventsSnap = await customDb.collection('transaction_events')
            .where('request_id', '==', req.id)
            .get();

        if (existingEventsSnap.empty) {
            const reqType = updates.type || req.type || 'borrow';
            const actorId = req.borrower_id || 'legacy_borrower';
            const lenderId = updates.lender_id || req.lender_id || 'legacy_lender';

            eventsToCreate.push({
                request_id: req.id,
                item_id: req.item_id || 'unknown',
                actor_id: actorId,
                event_type: 'requested',
                from_status: null,
                to_status: 'pending',
                created_at: req.created_at || new Date(0),
                is_backfilled: true
            });

            if (req.confirmed_at || ['approved', 'borrowed', 'returned', 'completed'].includes(req.status)) {
                eventsToCreate.push({
                    request_id: req.id,
                    item_id: req.item_id || 'unknown',
                    actor_id: lenderId,
                    event_type: 'approved',
                    from_status: 'pending',
                    to_status: 'approved',
                    created_at: req.confirmed_at || req.created_at || new Date(0),
                    is_backfilled: true
                });
            }

            if (req.picked_up_at || ['borrowed', 'returned', 'completed'].includes(req.status)) {
                eventsToCreate.push({
                    request_id: req.id,
                    item_id: req.item_id || 'unknown',
                    actor_id: actorId,
                    event_type: 'picked_up',
                    from_status: 'approved',
                    to_status: 'borrowed',
                    created_at: req.picked_up_at || req.confirmed_at || new Date(0),
                    is_backfilled: true
                });
            }

            if (req.returned_at || (reqType === 'borrow' && ['returned', 'completed'].includes(req.status))) {
                eventsToCreate.push({
                    request_id: req.id,
                    item_id: req.item_id || 'unknown',
                    actor_id: actorId,
                    event_type: 'returned',
                    from_status: 'borrowed',
                    to_status: 'returned',
                    created_at: req.returned_at || req.picked_up_at || new Date(0),
                    is_backfilled: true
                });
            }

            if (req.completed_at || req.status === 'completed') {
                eventsToCreate.push({
                    request_id: req.id,
                    item_id: req.item_id || 'unknown',
                    actor_id: lenderId,
                    event_type: reqType === 'giveaway' ? 'giveaway_completed' : 'borrow_completed',
                    from_status: reqType === 'giveaway' ? 'approved' : 'returned',
                    to_status: 'completed',
                    created_at: req.completed_at || req.returned_at || new Date(0),
                    is_backfilled: true
                });
            }

            if (req.declined_at || req.status === 'declined') {
                eventsToCreate.push({
                    request_id: req.id,
                    item_id: req.item_id || 'unknown',
                    actor_id: lenderId,
                    event_type: 'declined',
                    from_status: 'pending',
                    to_status: 'declined',
                    created_at: req.declined_at || req.created_at || new Date(0),
                    is_backfilled: true
                });
            }

            if (req.status === 'cancelled') {
                eventsToCreate.push({
                    request_id: req.id,
                    item_id: req.item_id || 'unknown',
                    actor_id: actorId,
                    event_type: 'cancelled',
                    from_status: 'pending',
                    to_status: 'cancelled',
                    created_at: req.updated_at || req.created_at || new Date(0),
                    is_backfilled: true
                });
            }
        }

        if (needsUpdate || eventsToCreate.length > 0) {
            report.updatedCount++;
            report.eventsCreated += eventsToCreate.length;
            report.records.push({
                requestId: req.id,
                changes: updates,
                eventsCount: eventsToCreate.length,
                notes: statusNotes.join('; ')
            });

            if (!dryRun) {
                if (needsUpdate) {
                    await customDb.collection('requests').doc(req.id).update({
                        ...updates,
                        updated_at: new Date()
                    });
                }
                for (const ev of eventsToCreate) {
                    await customDb.collection('transaction_events').add(ev);
                }
            }
        } else {
            report.skippedCount++;
        }
    }

    console.log(`\nBackfill Summary:`);
    console.log(`- Scanned: ${report.totalScanned}`);
    console.log(`- Updated: ${report.updatedCount}`);
    console.log(`- Unresolved/Legacy: ${report.unresolvedCount}`);
    console.log(`- Events Created: ${report.eventsCreated}`);
    console.log(`- Skipped: ${report.skippedCount}`);
    console.log(`Mode was: ${dryRun ? 'DRY-RUN (no writes made)' : 'APPLIED'}`);

    return report;
}

if (process.argv[1]?.endsWith('backfill-legacy-requests.js')) {
    runBackfill()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Migration failed:', err);
            process.exit(1);
        });
}
