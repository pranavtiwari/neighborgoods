/**
 * Universal Library - Book Metadata Lookup Module
 * 
 * Provides server-side metadata lookup with Open Library as primary
 * and Google Books as fallback, with normalization, in-memory/Firestore caching,
 * rate limiting, and graceful manual entry fallback.
 */

import {
    cleanIsbn,
    normalizeIsbn,
    normalizeTitle,
    normalizeAuthors,
    buildCanonicalBookPayload
} from './catalog.js';

// In-memory LRU / TTL cache for lookups (1 hour TTL)
const MEMORY_CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

// Rate limiting: max 30 requests per minute per user/IP
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 30;
const USER_RATE_LIMITS = new Map();

/**
 * Checks and updates rate limit for an actor.
 * @param {string} actorId 
 * @returns {boolean} true if allowed, false if rate limited
 */
export function checkRateLimit(actorId) {
    if (!actorId) return true;
    const now = Date.now();
    const timestamps = USER_RATE_LIMITS.get(actorId) || [];
    const validTimestamps = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

    if (validTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
        return false;
    }

    validTimestamps.push(now);
    USER_RATE_LIMITS.set(actorId, validTimestamps);
    return true;
}

/**
 * Extracts a 4-digit publication year from various date string formats.
 * @param {string|number} dateVal 
 * @returns {number|null}
 */
export function parsePublishedYear(dateVal) {
    if (!dateVal) return null;
    if (typeof dateVal === 'number' && dateVal > 1000 && dateVal < 3000) return dateVal;
    const match = String(dateVal).match(/\b(1[4-9]\d{2}|20\d{2})\b/);
    return match ? parseInt(match[0], 10) : null;
}

/**
 * Ensures image URLs are https to prevent mixed-content warnings.
 * @param {string} url 
 * @returns {string|null}
 */
export function sanitizeCoverUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let clean = url.trim();
    if (clean.startsWith('http://')) {
        clean = 'https://' + clean.substring(7);
    }
    return clean.startsWith('https://') ? clean : null;
}

/**
 * Fetches book metadata from Open Library by ISBN.
 * @param {string} cleanIsbn 
 * @param {Function} fetchFn 
 * @returns {Promise<Object|null>}
 */
export async function fetchOpenLibraryByIsbn(cleanIsbn, fetchFn = globalThis.fetch) {
    try {
        const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const res = await fetchFn(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) return null;
        const data = await res.json();
        const key = `ISBN:${cleanIsbn}`;
        const item = data[key];
        if (!item || !item.title) return null;

        const authors = (item.authors || []).map(a => a.name).filter(Boolean);
        const publishers = (item.publishers || []).map(p => p.name).filter(Boolean);
        const publishedYear = parsePublishedYear(item.publish_date);

        let coverUrl = null;
        if (item.cover) {
            coverUrl = item.cover.large || item.cover.medium || item.cover.small || null;
        }
        if (!coverUrl) {
            coverUrl = `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`;
        }

        const isbns = [cleanIsbn];
        if (item.identifiers) {
            if (Array.isArray(item.identifiers.isbn_10)) isbns.push(...item.identifiers.isbn_10);
            if (Array.isArray(item.identifiers.isbn_13)) isbns.push(...item.identifiers.isbn_13);
        }

        const normIsbn = normalizeIsbn(cleanIsbn);
        if (normIsbn.isbn10 && !isbns.includes(normIsbn.isbn10)) isbns.push(normIsbn.isbn10);
        if (normIsbn.isbn13 && !isbns.includes(normIsbn.isbn13)) isbns.push(normIsbn.isbn13);

        const description = typeof item.notes === 'string' 
            ? item.notes 
            : (typeof item.description === 'string' ? item.description : null);

        return {
            title: item.title,
            authors: authors.length > 0 ? authors : ['Unknown Author'],
            isbn: cleanIsbn,
            isbn_10: normIsbn.isbn10 || null,
            isbn_13: normIsbn.isbn13 || null,
            isbns,
            publisher: publishers[0] || null,
            published_year: publishedYear,
            language: 'en',
            cover_url: sanitizeCoverUrl(coverUrl),
            description: description,
            source: 'open_library',
            source_identifiers: {
                open_library_key: item.key || null
            }
        };
    } catch (err) {
        return null;
    }
}

/**
 * Searches Open Library by title or general query.
 * @param {string} query 
 * @param {Function} fetchFn 
 * @returns {Promise<Array>}
 */
export async function searchOpenLibrary(query, fetchFn = globalThis.fetch) {
    try {
        const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const res = await fetchFn(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) return [];
        const data = await res.json();
        if (!data || !Array.isArray(data.docs) || data.docs.length === 0) return [];

        const results = [];
        for (const doc of data.docs) {
            if (!doc.title) continue;
            const authors = Array.isArray(doc.author_name) && doc.author_name.length > 0 
                ? doc.author_name 
                : ['Unknown Author'];
            const year = doc.first_publish_year || parsePublishedYear(doc.publish_date?.[0]);
            const isbns = Array.isArray(doc.isbn) ? doc.isbn.slice(0, 5) : [];
            const primaryIsbn = isbns[0] || '';
            const normIsbn = normalizeIsbn(primaryIsbn);

            let coverUrl = null;
            if (doc.cover_i) {
                coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
            } else if (primaryIsbn) {
                coverUrl = `https://covers.openlibrary.org/b/isbn/${primaryIsbn}-L.jpg`;
            }

            results.push({
                title: doc.title,
                authors,
                isbn: primaryIsbn,
                isbn_10: normIsbn.isbn10 || null,
                isbn_13: normIsbn.isbn13 || null,
                isbns,
                publisher: Array.isArray(doc.publisher) ? doc.publisher[0] : null,
                published_year: year || null,
                language: Array.isArray(doc.language) ? doc.language[0] : 'en',
                cover_url: sanitizeCoverUrl(coverUrl),
                description: null,
                source: 'open_library',
                source_identifiers: {
                    open_library_work: doc.key || null
                }
            });
        }
        return results;
    } catch (err) {
        return [];
    }
}

/**
 * Searches Google Books API by query or ISBN.
 * @param {string} query 
 * @param {boolean} isIsbn 
 * @param {Function} fetchFn 
 * @returns {Promise<Array>}
 */
export async function searchGoogleBooks(query, isIsbn = false, fetchFn = globalThis.fetch) {
    try {
        const qParam = isIsbn ? `isbn:${query}` : encodeURIComponent(query);
        const url = `https://www.googleapis.com/books/v1/volumes?q=${qParam}&maxResults=5`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const res = await fetchFn(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) return [];
        const data = await res.json();
        if (!data || !Array.isArray(data.items) || data.items.length === 0) return [];

        const results = [];
        for (const item of data.items) {
            const vi = item.volumeInfo || {};
            if (!vi.title) continue;

            const authors = Array.isArray(vi.authors) && vi.authors.length > 0 
                ? vi.authors 
                : ['Unknown Author'];
            const year = parsePublishedYear(vi.publishedDate);

            let isbn10 = null;
            let isbn13 = null;
            const isbns = [];

            if (Array.isArray(vi.industryIdentifiers)) {
                for (const ident of vi.industryIdentifiers) {
                    if (ident.type === 'ISBN_10') isbn10 = ident.identifier;
                    if (ident.type === 'ISBN_13') isbn13 = ident.identifier;
                    if (ident.identifier) isbns.push(ident.identifier);
                }
            }

            let coverUrl = null;
            if (vi.imageLinks) {
                coverUrl = vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail || null;
            }

            results.push({
                title: vi.title + (vi.subtitle ? `: ${vi.subtitle}` : ''),
                authors,
                isbn: isbn13 || isbn10 || '',
                isbn_10: isbn10,
                isbn_13: isbn13,
                isbns,
                publisher: vi.publisher || null,
                published_year: year || null,
                language: vi.language || 'en',
                cover_url: sanitizeCoverUrl(coverUrl),
                description: vi.description || null,
                source: 'google_books',
                source_identifiers: {
                    google_books_id: item.id || null
                }
            });
        }
        return results;
    } catch (err) {
        return [];
    }
}

/**
 * Main orchestrator: Look up book metadata with Open Library as primary
 * and Google Books as fallback, cached and rate-limited.
 * 
 * @param {Object} params
 * @param {string} [params.isbn]
 * @param {string} [params.query]
 * @param {string} [params.actorId]
 * @param {Object} [options]
 * @param {Function} [options.fetchFn]
 * @param {Object} [options.db] Firestore database for persistent cache
 * @returns {Promise<{ found: boolean, source: string|null, book: Object|null, candidates: Array, error?: string }>}
 */
export async function lookupBookMetadata({ isbn, query, actorId }, { fetchFn = globalThis.fetch, db = null } = {}) {
    // 1. Rate Limiting Check
    if (actorId && !checkRateLimit(actorId)) {
        return {
            found: false,
            source: null,
            book: null,
            candidates: [],
            error: 'Rate limit exceeded. Please wait a moment before looking up another book.'
        };
    }

    const cleanInputIsbn = cleanIsbn(isbn || '');
    const cleanQuery = (query || '').trim();

    if (!cleanInputIsbn && !cleanQuery) {
        return {
            found: false,
            source: null,
            book: null,
            candidates: [],
            error: 'Please provide an ISBN or search query.'
        };
    }

    const cacheKey = cleanInputIsbn ? `isbn_${cleanInputIsbn}` : `query_${normalizeTitle(cleanQuery)}`;

    // 2. Check In-Memory Cache
    const memCached = MEMORY_CACHE.get(cacheKey);
    if (memCached && (Date.now() - memCached.timestamp < CACHE_TTL_MS)) {
        return memCached.data;
    }

    // 3. Check Firestore Cache (if provided)
    if (db) {
        try {
            const cacheDoc = await db.collection('book_lookup_cache').doc(cacheKey).get();
            if (cacheDoc.exists) {
                const cachedData = cacheDoc.data();
                if (cachedData && cachedData.result) {
                    MEMORY_CACHE.set(cacheKey, { timestamp: Date.now(), data: cachedData.result });
                    return cachedData.result;
                }
            }
        } catch (e) {
            // Non-blocking cache read error
        }
    }

    let response = {
        found: false,
        source: null,
        book: null,
        candidates: []
    };

    // 4. ISBN Lookup Flow
    if (cleanInputIsbn) {
        // Step A: Open Library ISBN lookup (Primary)
        const olBook = await fetchOpenLibraryByIsbn(cleanInputIsbn, fetchFn);
        if (olBook) {
            const normalized = buildCanonicalBookPayload(olBook, actorId || 'system');
            response = {
                found: true,
                source: 'open_library',
                book: { ...olBook, ...normalized },
                candidates: [{ ...olBook, ...normalized }]
            };
        } else {
            // Step B: Google Books ISBN fallback
            const gbResults = await searchGoogleBooks(cleanInputIsbn, true, fetchFn);
            if (gbResults.length > 0) {
                const gbBook = gbResults[0];
                const normalized = buildCanonicalBookPayload(gbBook, actorId || 'system');
                response = {
                    found: true,
                    source: 'google_books',
                    book: { ...gbBook, ...normalized },
                    candidates: [{ ...gbBook, ...normalized }]
                };
            }
        }
    } 
    // 5. Query / Title Search Flow
    else if (cleanQuery) {
        // Step A: Open Library search (Primary)
        let candidates = await searchOpenLibrary(cleanQuery, fetchFn);

        // Step B: If Open Library returns no candidates, fallback to Google Books
        if (candidates.length === 0) {
            candidates = await searchGoogleBooks(cleanQuery, false, fetchFn);
        }

        if (candidates.length > 0) {
            const normalizedCandidates = candidates.map(c => {
                try {
                    const norm = buildCanonicalBookPayload(c, actorId || 'system');
                    return { ...c, ...norm };
                } catch {
                    return c;
                }
            });

            response = {
                found: true,
                source: candidates[0].source,
                book: normalizedCandidates[0],
                candidates: normalizedCandidates
            };
        }
    }

    // 6. Cache Response
    MEMORY_CACHE.set(cacheKey, { timestamp: Date.now(), data: response });

    if (db && response.found) {
        try {
            await db.collection('book_lookup_cache').doc(cacheKey).set({
                result: response,
                cached_at: new Date()
            });
        } catch (e) {
            // Non-blocking cache write error
        }
    }

    return response;
}
