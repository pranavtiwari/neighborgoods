/**
 * Superadmin Management Script
 *
 * Adds, removes, or lists app-wide Superadmins in Firebase Auth (custom claims)
 * and Firestore (`superadmins/{uid}`).
 *
 * Authentication:
 *   Uses Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS or
 *   `gcloud auth application-default login`), or pass `--service-account=/path/to/key.json`.
 *
 * Usage:
 *   node scripts/manage-superadmins.js add --email=admin@example.com [--project=shareinstead] [--dry-run]
 *   node scripts/manage-superadmins.js add --uid=<firebase-uid> [--project=shareinstead] [--dry-run]
 *   node scripts/manage-superadmins.js remove --email=admin@example.com [--project=shareinstead] [--dry-run]
 *   node scripts/manage-superadmins.js remove --uid=<firebase-uid> [--project=shareinstead] [--dry-run]
 *   node scripts/manage-superadmins.js list [--project=shareinstead]
 *
 * npm shortcut:
 *   npm run superadmin -- add --email=admin@example.com
 */

import fs from 'fs';
import { pathToFileURL } from 'url';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export function parseArgs(argv = process.argv.slice(2)) {
    const command = argv.find(a => !a.startsWith('-')) || 'help';
    const getFlag = (name) => {
        const prefix = `--${name}=`;
        const hit = argv.find(a => a.startsWith(prefix));
        if (hit) return hit.slice(prefix.length).trim();
        const idx = argv.indexOf(`--${name}`);
        if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('-')) {
            return argv[idx + 1].trim();
        }
        return null;
    };

    return {
        command,
        email: getFlag('email'),
        uid: getFlag('uid'),
        project: getFlag('project')
            || process.env.GCLOUD_PROJECT
            || process.env.FIREBASE_PROJECT
            || 'shareinstead',
        serviceAccount: getFlag('service-account') || process.env.GOOGLE_APPLICATION_CREDENTIALS || null,
        dryRun: argv.includes('--dry-run'),
        help: argv.includes('--help') || argv.includes('-h') || command === 'help'
    };
}

function printUsage() {
    console.log(`
NeighborGoods / Share, Instead. — Superadmin CLI

Usage:
  node scripts/manage-superadmins.js add --email=<email> [options]
  node scripts/manage-superadmins.js add --uid=<uid> [options]
  node scripts/manage-superadmins.js remove --email=<email> [options]
  node scripts/manage-superadmins.js remove --uid=<uid> [options]
  node scripts/manage-superadmins.js list [options]

Options:
  --project=<project-id>          Firebase project ID (default: shareinstead)
  --service-account=<key.json>    Path to Firebase service account JSON key
  --dry-run                       Preview changes without writing to Auth or Firestore
  --help, -h                      Show this help message

Examples:
  node scripts/manage-superadmins.js add --email=founder@example.com
  node scripts/manage-superadmins.js list
  node scripts/manage-superadmins.js remove --uid=abc123xyz
`);
}

function initAdmin({ project, serviceAccount }) {
    if (getApps().length === 0) {
        const options = { projectId: project };
        if (serviceAccount && fs.existsSync(serviceAccount)) {
            const raw = JSON.parse(fs.readFileSync(serviceAccount, 'utf8'));
            options.credential = cert(raw);
        }
        initializeApp(options);
    }
    return {
        auth: getAuth(),
        db: getFirestore()
    };
}

async function resolveUser(auth, { uid, email }) {
    if (!uid && !email) {
        throw new Error('Provide either --email=<email> or --uid=<uid>.');
    }
    if (uid) {
        return await auth.getUser(uid);
    }
    return await auth.getUserByEmail(email);
}

export async function addSuperAdmin(auth, db, { uid, email, dryRun = false, grantedBy = 'cli-script' }) {
    const userRecord = await resolveUser(auth, { uid, email });
    const targetUid = userRecord.uid;
    const targetEmail = userRecord.email || email || null;

    // Fetch display name from Firestore profile if available
    let fullName = userRecord.displayName || null;
    try {
        const profileSnap = await db.collection('profiles').doc(targetUid).get();
        if (profileSnap.exists && profileSnap.data()?.full_name) {
            fullName = profileSnap.data().full_name;
        }
    } catch (_) {
        // Non-fatal if profile doesn't exist yet
    }

    const existingClaims = userRecord.customClaims || {};
    const nextClaims = {
        ...existingClaims,
        superadmin: true,
        admin: true
    };

    const superadminDoc = {
        uid: targetUid,
        email: targetEmail,
        full_name: fullName,
        role: 'superadmin',
        is_active: true,
        granted_by: grantedBy,
        granted_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp()
    };

    if (dryRun) {
        console.log(`[DRY-RUN] Would grant superadmin to uid=${targetUid} email=${targetEmail || '(none)'}`);
        console.log(`[DRY-RUN] Custom claims:`, nextClaims);
        console.log(`[DRY-RUN] Firestore doc superadmins/${targetUid}:`, {
            ...superadminDoc,
            granted_at: '<serverTimestamp>',
            updated_at: '<serverTimestamp>'
        });
        return { uid: targetUid, email: targetEmail, full_name: fullName, dryRun: true };
    }

    await auth.setCustomUserClaims(targetUid, nextClaims);
    await db.collection('superadmins').doc(targetUid).set(superadminDoc, { merge: true });

    try {
        await db.collection('moderation_events').add({
            action: 'grant_superadmin',
            actor_id: grantedBy,
            target_type: 'user',
            target_id: targetUid,
            target_email: targetEmail,
            created_at: FieldValue.serverTimestamp()
        });
    } catch (err) {
        console.warn('Warning: could not write moderation_events audit entry:', err.message);
    }

    console.log(`Superadmin granted to ${fullName || targetEmail || targetUid} (uid: ${targetUid}).`);
    console.log('Note: If the user is currently signed in, they may need to refresh their session to pick up updated Auth claims.');
    return { uid: targetUid, email: targetEmail, full_name: fullName, dryRun: false };
}

export async function removeSuperAdmin(auth, db, { uid, email, dryRun = false, revokedBy = 'cli-script' }) {
    const userRecord = await resolveUser(auth, { uid, email });
    const targetUid = userRecord.uid;
    const targetEmail = userRecord.email || email || null;

    const existingClaims = userRecord.customClaims || {};
    const nextClaims = {
        ...existingClaims,
        superadmin: false,
        admin: false
    };

    if (dryRun) {
        console.log(`[DRY-RUN] Would revoke superadmin from uid=${targetUid} email=${targetEmail || '(none)'}`);
        console.log(`[DRY-RUN] Custom claims:`, nextClaims);
        console.log(`[DRY-RUN] Would mark superadmins/${targetUid} as is_active=false`);
        return { uid: targetUid, email: targetEmail, dryRun: true };
    }

    await auth.setCustomUserClaims(targetUid, nextClaims);
    await db.collection('superadmins').doc(targetUid).set({
        uid: targetUid,
        email: targetEmail,
        role: 'superadmin',
        is_active: false,
        revoked_by: revokedBy,
        revoked_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp()
    }, { merge: true });

    try {
        await db.collection('moderation_events').add({
            action: 'revoke_superadmin',
            actor_id: revokedBy,
            target_type: 'user',
            target_id: targetUid,
            target_email: targetEmail,
            created_at: FieldValue.serverTimestamp()
        });
    } catch (err) {
        console.warn('Warning: could not write moderation_events audit entry:', err.message);
    }

    console.log(`Superadmin revoked from ${targetEmail || targetUid} (uid: ${targetUid}).`);
    return { uid: targetUid, email: targetEmail, dryRun: false };
}

export async function listSuperAdmins(db) {
    const snap = await db.collection('superadmins').get();
    const admins = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(a => a.is_active !== false);

    if (admins.length === 0) {
        console.log('No active superadmins found.');
        return [];
    }

    console.log(`Active superadmins (${admins.length}):`);
    for (const admin of admins) {
        console.log(`  - ${admin.uid} | ${admin.full_name || '(no name)'} | ${admin.email || '(no email)'} | granted_by=${admin.granted_by || 'unknown'}`);
    }
    return admins;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
    const args = parseArgs();
    if (args.help) {
        printUsage();
        process.exit(0);
    }

    const { auth, db } = initAdmin(args);

    (async () => {
        if (args.command === 'add') {
            await addSuperAdmin(auth, db, args);
        } else if (args.command === 'remove' || args.command === 'revoke') {
            await removeSuperAdmin(auth, db, args);
        } else if (args.command === 'list') {
            await listSuperAdmins(db);
        } else {
            console.error(`Unknown command: "${args.command}"`);
            printUsage();
            process.exit(1);
        }
        process.exit(0);
    })().catch(err => {
        console.error('Superadmin script failed:', err.message || err);
        process.exit(1);
    });
}
