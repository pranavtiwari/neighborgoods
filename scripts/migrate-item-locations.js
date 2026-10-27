/**
 * Migration Script: Migrate item locations (Issue #6)
 * Splits public area-level location from private exact addresses.
 * Exact addresses are stored under `items/{itemId}/private/location`.
 * 
 * Usage:
 *   node scripts/migrate-item-locations.js [--apply] [--project=demo-rules]
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

/**
 * Derives an area-level string from a full street address.
 * E.g. "123 Main St, Apt 4B, Springfield, IL 62701" -> "Springfield, IL 62701"
 */
export function deriveAreaFromAddress(address) {
    if (!address || typeof address !== 'string') return '';
    const parts = address.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) return address;
    if (parts.length >= 3) {
        return `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`;
    }
    return parts[parts.length - 1];
}

export async function runLocationMigration(customDb = db, dryRun = isDryRun) {
    console.log(`Starting item location privacy migration (Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'})...`);

    const report = {
        totalScanned: 0,
        migratedCount: 0,
        alreadySplitCount: 0,
        records: []
    };

    const itemsSnap = await customDb.collection('items').get();
    report.totalScanned = itemsSnap.size;

    for (const doc of itemsSnap.docs) {
        const item = { id: doc.id, ...doc.data() };
        const rawLocation = item.location || '';
        const hasPrivateLocDoc = (await customDb.collection('items').doc(item.id).collection('private').doc('location').get()).exists;

        if (rawLocation && !hasPrivateLocDoc) {
            const area = deriveAreaFromAddress(rawLocation);
            report.migratedCount++;
            report.records.push({
                itemId: item.id,
                originalLocation: rawLocation,
                derivedArea: area
            });

            if (!dryRun) {
                // 1. Write private location doc
                await customDb.collection('items').doc(item.id).collection('private').doc('location').set({
                    exact_address: rawLocation,
                    pickup_instructions: item.pickup_instructions || '',
                    created_at: new Date()
                });

                // 2. Update public item document with area only
                await customDb.collection('items').doc(item.id).update({
                    location_area: area,
                    location: area, // sanitized public representation
                    updated_at: new Date()
                });
            }
        } else {
            report.alreadySplitCount++;
        }
    }

    console.log(`\nLocation Migration Summary:`);
    console.log(`- Total Scanned: ${report.totalScanned}`);
    console.log(`- Migrated to Private Subcollection: ${report.migratedCount}`);
    console.log(`- Already Split/No Location: ${report.alreadySplitCount}`);
    console.log(`Mode was: ${dryRun ? 'DRY-RUN (no writes made)' : 'APPLIED'}`);

    return report;
}

if (process.argv[1]?.endsWith('migrate-item-locations.js')) {
    runLocationMigration()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Location migration failed:', err);
            process.exit(1);
        });
}
