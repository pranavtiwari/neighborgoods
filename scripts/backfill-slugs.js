/**
 * Migration Script: Backfill unique kebab-case slugs for all entities
 * Backfills `slug` fields on `circles`, `items`, `books`, `help_requests`, and `profiles`,
 * and writes corresponding lookup docs in `slugs/{entityType}_{slug}`.
 * Supports --dry-run (default) and --apply.
 *
 * Usage:
 *   node scripts/backfill-slugs.js [--apply] [--project=<project-id>]
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const isApply = process.argv.includes('--apply');
const isDryRun = !isApply;
const projectArg = process.argv.find(a => a.startsWith('--project='));
const projectId = (projectArg && projectArg.split('=')[1])
    || process.env.GCLOUD_PROJECT
    || process.env.FIREBASE_PROJECT
    || 'shareinstead';

export function slugifyName(text, fallback = 'entity') {
    if (!text || typeof text !== 'string') return fallback;
    const slug = text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
        .replace(/-+$/, '');
    return slug || fallback;
}

const ENTITY_SPECS = [
    { type: 'circle', collection: 'circles', getName: d => d.name, getOwner: d => d.created_by || 'system' },
    { type: 'item', collection: 'items', getName: d => d.name, getOwner: d => d.owner_id || 'system' },
    { type: 'book', collection: 'books', getName: d => d.title, getOwner: d => d.created_by || 'system' },
    { type: 'help', collection: 'help_requests', getName: d => d.title || d.description, getOwner: d => d.requester_id || 'system' },
    { type: 'profile', collection: 'profiles', getName: d => d.full_name, getOwner: (_d, id) => id }
];

export async function runSlugBackfill(customDb, dryRun = isDryRun) {
    console.log(`Starting entity slug backfill (Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'})...`);

    // Preload existing slug claims to avoid collisions
    const existingSlugsSnap = await customDb.collection('slugs').get();
    const claimed = new Map(); // slugKey -> entity_id
    existingSlugsSnap.forEach(doc => {
        const data = doc.data();
        if (data && data.entity_id) claimed.set(doc.id, data.entity_id);
    });

    const summary = {};

    for (const spec of ENTITY_SPECS) {
        const snap = await customDb.collection(spec.collection).get();
        let updated = 0;
        let skipped = 0;

        for (const doc of snap.docs) {
            const data = doc.data();
            const rawName = spec.getName(data, doc.id);
            const base = data.slug ? slugifyName(data.slug, spec.type) : slugifyName(rawName, spec.type);

            let candidate = base;
            let attempt = 1;
            while (attempt <= 100) {
                candidate = attempt === 1 ? base : `${base}-${attempt}`;
                const key = `${spec.type}_${candidate}`;
                const holder = claimed.get(key);
                if (!holder || holder === doc.id) break;
                attempt++;
            }

            const slugKey = `${spec.type}_${candidate}`;
            const needsDocUpdate = data.slug !== candidate;
            const needsSlugRegistry = claimed.get(slugKey) !== doc.id;

            if (!needsDocUpdate && !needsSlugRegistry) {
                skipped++;
                continue;
            }

            claimed.set(slugKey, doc.id);
            updated++;

            if (dryRun) {
                console.log(`[DRY-RUN] ${spec.collection}/${doc.id} -> slug="${candidate}" (${slugKey})`);
            } else {
                const batch = customDb.batch();
                if (needsDocUpdate) {
                    batch.update(doc.ref, { slug: candidate });
                }
                if (needsSlugRegistry) {
                    batch.set(customDb.collection('slugs').doc(slugKey), {
                        entity_type: spec.type,
                        entity_id: doc.id,
                        slug: candidate,
                        created_by: spec.getOwner(data, doc.id),
                        created_at: FieldValue.serverTimestamp()
                    });
                }
                await batch.commit();
            }
        }

        summary[spec.collection] = { scanned: snap.size, updated, skipped };
        console.log(`  ${spec.collection}: scanned=${snap.size}, updated=${updated}, skipped=${skipped}`);
    }

    return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    if (getApps().length === 0) {
        initializeApp({ projectId });
    }
    const db = getFirestore();
    runSlugBackfill(db, isDryRun)
        .then(() => {
            console.log('Done.');
            process.exit(0);
        })
        .catch(err => {
            console.error('Backfill failed:', err);
            process.exit(1);
        });
}
