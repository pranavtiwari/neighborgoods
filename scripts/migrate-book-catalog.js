/**
 * Migration Script: Migrate existing book listings into canonical books and copies (Issue #11)
 * 
 * - Identifies existing book items (kind: 'book', category: 'books', book circles, etc.)
 * - Groups them by likely title/author/ISBN
 * - Merges duplicate titles/ISBNs into canonical `books` records
 * - Sets `book_id`, `kind: 'book'`, and normalized listing types on each copy
 * - Preserves `circle_id`, `circle_ids`, `owner_id`, `photos`, and `status`
 * - Produces a review list for ambiguous or missing metadata
 * - Provides a dry-run report (default) and an idempotent apply step
 * - Leaves `requests` and transactions untouched
 * 
 * Usage:
 *   node scripts/migrate-book-catalog.js [--apply] [--project=demo-rules]
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
    cleanIsbn,
    normalizeIsbn,
    normalizeTitle,
    normalizeAuthor,
    normalizeAuthors,
    buildCanonicalBookPayload,
    normalizeListingType
} from '../functions/catalog.js';

const isApply = process.argv.includes('--apply');
const isDryRun = !isApply;

if (getApps().length === 0) {
    initializeApp({
        projectId: process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || 'demo-rules'
    });
}

const db = getFirestore();

/**
 * Attempts to extract an ISBN from freeform text (name or description).
 * @param {string} text 
 * @returns {{ valid: boolean, isbn10: string|null, isbn13: string|null, isbns: string[] }|null}
 */
export function extractIsbnFromText(text) {
    if (!text || typeof text !== 'string') return null;
    
    // Look for ISBN-10 or ISBN-13 patterns
    const isbnRegex = /(?:ISBN(?:-1[03])?:?\s*)?([0-9Xx\s-]{10,17})/gi;
    let match;
    while ((match = isbnRegex.exec(text)) !== null) {
        const candidate = match[1].replace(/[^0-9Xx]/g, '');
        if (candidate.length === 10 || candidate.length === 13) {
            const norm = normalizeIsbn(candidate);
            if (norm.valid) return norm;
        }
    }
    return null;
}

/**
 * Cleans bracketed format or edition notes from a book title.
 * e.g. "The Hobbit (Paperback)" -> { cleanTitle: "The Hobbit", editionNotes: "Paperback" }
 * @param {string} rawTitle 
 * @returns {{ cleanTitle: string, editionNotes: string }}
 */
export function stripFormatNotes(rawTitle) {
    if (!rawTitle) return { cleanTitle: '', editionNotes: '' };
    let clean = rawTitle.trim();
    let editionNotes = '';

    const formatRegex = /\s*[\(\[]\s*(paperback|hardcover|mass market|audiobook|ebook|book|1st edition|first edition|2nd edition|illustrated)\s*[\)\]]\s*$/i;
    const match = clean.match(formatRegex);
    if (match) {
        editionNotes = match[1].trim();
        clean = clean.replace(formatRegex, '').trim();
    }
    return { cleanTitle: clean, editionNotes };
}

/**
 * Parses and separates Title, Author, and ISBN from an item's fields.
 * Supports delimiters like "Title by Author", "Title - Author", "Title (Author)", "Title | Author".
 * @param {Object} item 
 * @returns {Object} parsed metadata and ambiguity flag
 */
export function parseBookMetadata(item) {
    let rawTitle = String(item.name || item.title || '').trim();
    let rawAuthor = item.author || (Array.isArray(item.authors) ? item.authors.join(', ') : '') || '';
    let rawIsbn = item.isbn || item.isbn_13 || item.isbn_10 || '';
    let parsedEdition = '';

    // 1. Check for ISBN in explicit field or text
    let isbnData = normalizeIsbn(rawIsbn);
    if (!isbnData.valid) {
        const fromDesc = extractIsbnFromText(item.description);
        if (fromDesc && fromDesc.valid) {
            isbnData = fromDesc;
        } else {
            const fromName = extractIsbnFromText(rawTitle);
            if (fromName && fromName.valid) {
                isbnData = fromName;
            }
        }
    }

    // 2. Strip format notes (Paperback, Hardcover, etc.)
    const stripped = stripFormatNotes(rawTitle);
    rawTitle = stripped.cleanTitle;
    parsedEdition = stripped.editionNotes;

    // 3. Extract author from title if not explicitly provided
    if (!rawAuthor && rawTitle) {
        // Pattern 1: "Title by Author"
        const byMatch = rawTitle.match(/^(.+?)\s+by\s+([^,]+(?:,\s*[^,]+)*)$/i);
        if (byMatch) {
            rawTitle = byMatch[1].trim();
            rawAuthor = byMatch[2].trim();
        } else {
            // Pattern 2: "Title - Author"
            const dashMatch = rawTitle.match(/^([^-]+)\s*-\s*([^-]+)$/);
            if (dashMatch && dashMatch[1].trim().length > 2 && dashMatch[2].trim().length > 2) {
                // Heuristic: only treat RHS as author if it doesn't look like a subtitle (e.g. "Clean Code - A Handbook")
                const rhs = dashMatch[2].trim();
                const looksLikeSubtitle = /^(a|an|the|vol|part|guide|handbook|edition)\b/i.test(rhs);
                if (!looksLikeSubtitle) {
                    rawTitle = dashMatch[1].trim();
                    rawAuthor = rhs;
                }
            } else {
                // Pattern 3: "Title (Author)"
                const parenMatch = rawTitle.match(/^([^(]+)\s*\(([^)]+)\)$/);
                if (parenMatch && parenMatch[1].trim().length > 2) {
                    const inner = parenMatch[2].trim();
                    // If inner isn't format/year, treat as author
                    if (!/^\d{4}$/.test(inner) && !/^(paperback|hardcover|book)$/i.test(inner)) {
                        rawTitle = parenMatch[1].trim();
                        rawAuthor = inner;
                    }
                } else {
                    // Pattern 4: "Title | Author"
                    const pipeMatch = rawTitle.match(/^([^|]+)\s*\|\s*([^|]+)$/);
                    if (pipeMatch) {
                        rawTitle = pipeMatch[1].trim();
                        rawAuthor = pipeMatch[2].trim();
                    }
                }
            }
        }
    }

    const { authors, authors_normalized } = normalizeAuthors(rawAuthor ? [rawAuthor] : []);
    const title_normalized = normalizeTitle(rawTitle);

    // 4. Quality & Ambiguity Checks
    let ambiguous = false;
    let reason = null;

    if (!title_normalized || title_normalized.length < 2) {
        ambiguous = true;
        reason = 'missing_or_invalid_title';
    } else {
        const genericTitles = ['book', 'books', 'textbook', 'novel', 'unknown', 'untitled', 'misc', 'item'];
        if (genericTitles.includes(title_normalized) && authors.length === 0 && !isbnData.valid) {
            ambiguous = true;
            reason = 'generic_title_no_author_or_isbn';
        }
    }

    return {
        title: rawTitle,
        title_normalized,
        authors,
        authors_normalized,
        isbnData,
        editionNotes: parsedEdition,
        ambiguous,
        reason
    };
}

/**
 * Determines whether an item document is a candidate for the book catalog migration.
 * @param {Object} item 
 * @param {Map<string, Object>} circlesMap 
 * @returns {boolean}
 */
export function isCandidateBookItem(item, circlesMap = new Map()) {
    if (!item) return false;

    // Explicit kind or book_id
    if (item.kind === 'book' || item.book_id) return true;

    // Category check
    const cat = String(item.category || '').toLowerCase().trim();
    if (cat === 'books' || cat === 'book' || cat === 'literature' || cat === 'reading') return true;

    if (Array.isArray(item.categories)) {
        if (item.categories.some(c => {
            const lc = String(c || '').toLowerCase().trim();
            return lc === 'books' || lc === 'book' || lc === 'literature';
        })) {
            return true;
        }
    }

    // Has explicit ISBN
    if (item.isbn || item.isbn_13 || item.isbn_10) return true;

    // Associated with a book circle (e.g. "A World of Books" or category 'books')
    const circleIds = [item.circle_id, ...(Array.isArray(item.circle_ids) ? item.circle_ids : [])].filter(Boolean);
    for (const cid of circleIds) {
        if (cid === 'a-world-of-books' || cid === 'world-of-books') return true;
        const circle = circlesMap.get(cid);
        if (circle) {
            const circleCat = String(circle.category || '').toLowerCase().trim();
            const circleName = String(circle.name || '').toLowerCase();
            if (circleCat === 'books' || circleCat === 'book' || circleName.includes('book') || circleName.includes('library')) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Runs the book catalog migration.
 * @param {Object} customDb Firestore DB instance
 * @param {boolean} dryRun If true, produces dry-run report without database writes
 * @returns {Promise<Object>} Migration report
 */
export async function runBookCatalogMigration(customDb = db, dryRun = isDryRun) {
    console.log(`Starting Book Catalog Migration (Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'})...`);

    const report = {
        totalScanned: 0,
        candidateBookCount: 0,
        migratedCount: 0,
        alreadyMigratedCount: 0,
        booksCreatedCount: 0,
        booksMergedCount: 0,
        reviewCount: 0,
        reviewList: [],
        records: []
    };

    // 1. Preload circles to resolve circle categories and names
    const circlesMap = new Map();
    try {
        const circlesSnap = await customDb.collection('circles').get();
        circlesSnap.docs.forEach(doc => {
            circlesMap.set(doc.id, { id: doc.id, ...doc.data() });
        });
    } catch (e) {
        // Non-fatal if circles collection empty
    }

    // 2. Preload existing canonical books
    const existingBooksMap = new Map(); // id -> book
    const booksByIsbn = new Map();      // cleanIsbn -> book
    const booksByTitleAuthor = new Map(); // title_normalized:::author_normalized -> book
    const booksByTitle = new Map();     // title_normalized -> book[]
    const bookCopyCounts = new Map();   // id -> { total: number, available: number, touched: boolean }

    const booksSnap = await customDb.collection('books').get();
    for (const doc of booksSnap.docs) {
        const b = { id: doc.id, ...doc.data() };
        existingBooksMap.set(b.id, b);
        bookCopyCounts.set(b.id, {
            total: typeof b.copies_count === 'number' ? b.copies_count : 0,
            available: typeof b.available_copies_count === 'number' ? b.available_copies_count : 0,
            touched: false
        });

        // Index ISBNs
        if (Array.isArray(b.isbns)) {
            b.isbns.forEach(isbn => {
                const c = cleanIsbn(isbn);
                if (c) booksByIsbn.set(c, b);
            });
        }
        if (b.isbn_13) booksByIsbn.set(cleanIsbn(b.isbn_13), b);
        if (b.isbn_10) booksByIsbn.set(cleanIsbn(b.isbn_10), b);

        // Index Title + Author
        const normTitle = b.title_normalized || normalizeTitle(b.title);
        const normAuthors = b.authors_normalized || [];
        if (normTitle) {
            if (normAuthors.length > 0) {
                normAuthors.forEach(a => {
                    booksByTitleAuthor.set(`${normTitle}:::${a}`, b);
                });
            } else {
                booksByTitleAuthor.set(`${normTitle}:::`, b);
            }

            if (!booksByTitle.has(normTitle)) {
                booksByTitle.set(normTitle, []);
            }
            booksByTitle.get(normTitle).push(b);
        }
    }

    // 3. Scan all items
    const itemsSnap = await customDb.collection('items').get();
    report.totalScanned = itemsSnap.size;

    const itemsToUpdate = [];
    const booksToWrite = new Map(); // id -> bookData

    for (const doc of itemsSnap.docs) {
        const item = { id: doc.id, ...doc.data() };

        if (!isCandidateBookItem(item, circlesMap)) {
            continue;
        }

        report.candidateBookCount++;

        // 3a. Check if already migrated
        if (item.book_id && existingBooksMap.has(item.book_id)) {
            report.alreadyMigratedCount++;
            report.records.push({
                itemId: item.id,
                itemName: item.name,
                bookId: item.book_id,
                bookTitle: existingBooksMap.get(item.book_id).title,
                status: 'already_migrated',
                isNewBook: false,
                wasMerged: false
            });
            continue;
        }

        // 3b. Parse book metadata
        const parsed = parseBookMetadata(item);

        // 3c. Ambiguous / review list handling
        if (parsed.ambiguous) {
            report.reviewCount++;
            report.reviewList.push({
                itemId: item.id,
                itemName: item.name,
                reason: parsed.reason,
                rawData: {
                    name: item.name,
                    category: item.category,
                    categories: item.categories,
                    circle_id: item.circle_id
                }
            });
            continue;
        }

        // 3d. Find matching canonical book
        let matchedBook = null;

        // Criterion 1: Match by valid ISBN
        if (parsed.isbnData && parsed.isbnData.valid && parsed.isbnData.isbns.length > 0) {
            for (const isbn of parsed.isbnData.isbns) {
                const c = cleanIsbn(isbn);
                if (booksByIsbn.has(c)) {
                    matchedBook = booksByIsbn.get(c);
                    break;
                }
            }
        }

        // Criterion 2: Match by Title + Author
        if (!matchedBook && parsed.title_normalized) {
            if (parsed.authors_normalized.length > 0) {
                for (const auth of parsed.authors_normalized) {
                    const key = `${parsed.title_normalized}:::${auth}`;
                    if (booksByTitleAuthor.has(key)) {
                        matchedBook = booksByTitleAuthor.get(key);
                        break;
                    }
                }
            } else {
                // If candidate has no author, check if there is an author-less book with same title
                const key = `${parsed.title_normalized}:::`;
                if (booksByTitleAuthor.has(key)) {
                    matchedBook = booksByTitleAuthor.get(key);
                }
            }
        }

        // Criterion 3: Unambiguous Title-only match
        if (!matchedBook && parsed.title_normalized && booksByTitle.has(parsed.title_normalized)) {
            const candidates = booksByTitle.get(parsed.title_normalized);
            if (candidates.length === 1) {
                matchedBook = candidates[0];
            }
        }

        let targetBook;
        let isNewBook = false;
        let wasMerged = false;

        if (matchedBook) {
            targetBook = matchedBook;
            wasMerged = true;
            report.booksMergedCount++;

            // Enrich canonical book with missing metadata if candidate has it
            let enriched = false;
            if (parsed.isbnData.valid && (!targetBook.isbns || targetBook.isbns.length === 0)) {
                targetBook.isbns = parsed.isbnData.isbns;
                targetBook.isbn_10 = parsed.isbnData.isbn10;
                targetBook.isbn_13 = parsed.isbnData.isbn13;
                enriched = true;
            }
            if (!targetBook.cover_url && (item.image_url || item.photo_url || (Array.isArray(item.photos) && item.photos[0]))) {
                targetBook.cover_url = item.image_url || item.photo_url || item.photos[0];
                enriched = true;
            }
            if (!targetBook.description && item.description) {
                targetBook.description = item.description;
                enriched = true;
            }
            if (enriched) {
                booksToWrite.set(targetBook.id, targetBook);
            }
        } else {
            // Create new canonical book document
            isNewBook = true;
            report.booksCreatedCount++;

            const newDocId = (parsed.isbnData.valid && parsed.isbnData.isbn13)
                ? 'isbn_' + parsed.isbnData.isbn13
                : (customDb.collection('books').doc().id || `book_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`);

            const coverUrl = item.image_url || item.photo_url || (Array.isArray(item.photos) ? item.photos[0] : null);
            const bookPayload = buildCanonicalBookPayload({
                title: parsed.title,
                authors: parsed.authors,
                isbn_10: parsed.isbnData.isbn10,
                isbn_13: parsed.isbnData.isbn13,
                isbns: parsed.isbnData.isbns,
                cover_url: coverUrl,
                description: item.description || null,
                copies_count: 0,
                available_copies_count: 0
            }, 'migration');

            targetBook = { id: newDocId, ...bookPayload };
            existingBooksMap.set(targetBook.id, targetBook);
            booksToWrite.set(targetBook.id, targetBook);

            // Register into in-memory lookup indexes
            if (Array.isArray(targetBook.isbns)) {
                targetBook.isbns.forEach(isbn => {
                    const c = cleanIsbn(isbn);
                    if (c) booksByIsbn.set(c, targetBook);
                });
            }
            if (targetBook.title_normalized) {
                if (targetBook.authors_normalized && targetBook.authors_normalized.length > 0) {
                    targetBook.authors_normalized.forEach(a => {
                        booksByTitleAuthor.set(`${targetBook.title_normalized}:::${a}`, targetBook);
                    });
                } else {
                    booksByTitleAuthor.set(`${targetBook.title_normalized}:::`, targetBook);
                }

                if (!booksByTitle.has(targetBook.title_normalized)) {
                    booksByTitle.set(targetBook.title_normalized, []);
                }
                booksByTitle.get(targetBook.title_normalized).push(targetBook);
            }

            bookCopyCounts.set(targetBook.id, { total: 0, available: 0, touched: true });
        }

        // Track copy counts
        const copyMeta = bookCopyCounts.get(targetBook.id) || { total: 0, available: 0, touched: true };
        copyMeta.total++;
        if (item.is_available !== false && (!item.status || item.status === 'available')) {
            copyMeta.available++;
        }
        copyMeta.touched = true;
        bookCopyCounts.set(targetBook.id, copyMeta);

        // Prepare item update
        const rawCats = Array.isArray(item.categories) ? item.categories : (item.category ? [item.category] : []);
        const mergedCategories = Array.from(new Set([...rawCats, 'books']));

        const itemUpdatePayload = {
            kind: 'book',
            book_id: targetBook.id,
            condition: item.condition || 'good',
            condition_notes: item.condition_notes || '',
            edition_notes: item.edition_notes || parsed.editionNotes || '',
            fulfillment_method: item.fulfillment_method || 'pickup',
            listing_type: normalizeListingType(item.listing_type, item.intent),
            category: 'books',
            categories: mergedCategories,
            migrated_at: new Date(),
            migrated_to_book_id: targetBook.id
        };

        itemsToUpdate.push({
            itemId: item.id,
            updates: itemUpdatePayload
        });

        report.migratedCount++;
        report.records.push({
            itemId: item.id,
            itemName: item.name,
            bookId: targetBook.id,
            bookTitle: targetBook.title,
            status: 'migrated',
            isNewBook,
            wasMerged
        });
    }

    // 4. Update canonical book copy counts in the write batch
    for (const [bookId, counts] of bookCopyCounts.entries()) {
        if (counts.touched) {
            const existingBook = existingBooksMap.get(bookId) || booksToWrite.get(bookId);
            if (existingBook) {
                existingBook.copies_count = counts.total;
                existingBook.available_copies_count = counts.available;
                existingBook.updated_at = new Date();
                booksToWrite.set(bookId, existingBook);
            }
        }
    }

    // 5. Apply writes if not in dry-run mode
    if (!dryRun) {
        console.log(`Applying writes: creating/updating ${booksToWrite.size} books and ${itemsToUpdate.length} items...`);

        // 5a. Write canonical books
        for (const [bookId, bookData] of booksToWrite.entries()) {
            await customDb.collection('books').doc(bookId).set(bookData, { merge: true });
        }

        // 5b. Update item copies
        for (const { itemId, updates } of itemsToUpdate) {
            await customDb.collection('items').doc(itemId).update(updates);
        }

        // 5c. Tag flagged review items in DB for visibility
        for (const reviewItem of report.reviewList) {
            try {
                await customDb.collection('items').doc(reviewItem.itemId).update({
                    migration_review_needed: true,
                    migration_review_reason: reviewItem.reason
                });
            } catch (e) {
                // Non-fatal if review tagging fails
            }
        }
    }

    // Summary Logging
    console.log(`\n==========================================`);
    console.log(`Book Catalog Migration Summary (${dryRun ? 'DRY-RUN' : 'APPLIED'})`);
    console.log(`==========================================`);
    console.log(`- Total Items Scanned:      ${report.totalScanned}`);
    console.log(`- Candidate Book Listings:  ${report.candidateBookCount}`);
    console.log(`- Successfully Migrated:    ${report.migratedCount}`);
    console.log(`- Already Migrated (Skip):  ${report.alreadyMigratedCount}`);
    console.log(`- Canonical Books Created:  ${report.booksCreatedCount}`);
    console.log(`- Copies Merged to Books:   ${report.booksMergedCount}`);
    console.log(`- Flagged for Review:       ${report.reviewCount}`);
    console.log(`==========================================\n`);

    return report;
}

if (process.argv[1]?.endsWith('migrate-book-catalog.js')) {
    runBookCatalogMigration()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Book catalog migration failed:', err);
            process.exit(1);
        });
}
