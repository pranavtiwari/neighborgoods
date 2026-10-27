/**
 * Universal Library - Catalog Module
 * 
 * Provides canonical book data modeling, ISBN normalization (ISBN-10 & ISBN-13),
 * check-digit validation, title/author normalization, duplicate detection,
 * and zero-copy availability helpers.
 */

/**
 * Strips formatting characters (dashes, spaces, dots) from an ISBN string.
 * @param {string} raw 
 * @returns {string}
 */
export function cleanIsbn(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw.replace(/[^0-9X]/gi, '').toUpperCase();
}

/**
 * Validates an ISBN-10 string using modulo 11 check digit algorithm.
 * @param {string} str 10-character cleaned ISBN
 * @returns {boolean}
 */
export function isValidIsbn10(str) {
    if (!str || typeof str !== 'string' || str.length !== 10) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) {
        const digit = parseInt(str[i], 10);
        if (isNaN(digit)) return false;
        sum += (10 - i) * digit;
    }
    const checkChar = str[9];
    const checkVal = checkChar === 'X' ? 10 : parseInt(checkChar, 10);
    if (isNaN(checkVal)) return false;
    sum += checkVal;
    return sum % 11 === 0;
}

/**
 * Validates an ISBN-13 string using modulo 10 check digit algorithm.
 * @param {string} str 13-character cleaned ISBN
 * @returns {boolean}
 */
export function isValidIsbn13(str) {
    if (!str || typeof str !== 'string' || str.length !== 13) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) {
        const digit = parseInt(str[i], 10);
        if (isNaN(digit)) return false;
        sum += i % 2 === 0 ? digit : digit * 3;
    }
    const checkDigit = parseInt(str[12], 10);
    if (isNaN(checkDigit)) return false;
    const expectedCheck = (10 - (sum % 10)) % 10;
    return checkDigit === expectedCheck;
}

/**
 * Converts a valid ISBN-10 to an ISBN-13.
 * @param {string} isbn10 
 * @returns {string|null}
 */
export function isbn10ToIsbn13(isbn10) {
    const cleaned = cleanIsbn(isbn10);
    if (!isValidIsbn10(cleaned)) return null;

    const base = '978' + cleaned.substring(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) {
        const digit = parseInt(base[i], 10);
        sum += i % 2 === 0 ? digit : digit * 3;
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    return base + checkDigit.toString();
}

/**
 * Converts a 978-prefixed valid ISBN-13 to an ISBN-10.
 * @param {string} isbn13 
 * @returns {string|null}
 */
export function isbn13ToIsbn10(isbn13) {
    const cleaned = cleanIsbn(isbn13);
    if (!isValidIsbn13(cleaned)) return null;
    if (!cleaned.startsWith('978')) return null; // 979 prefix cannot be converted to ISBN-10

    const base = cleaned.substring(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i++) {
        const digit = parseInt(base[i], 10);
        sum += (10 - i) * digit;
    }
    const remainder = sum % 11;
    const checkVal = (11 - remainder) % 11;
    const checkChar = checkVal === 10 ? 'X' : checkVal.toString();
    return base + checkChar;
}

/**
 * Normalizes and validates any raw ISBN input. Returns both ISBN-10 and ISBN-13
 * where calculable, plus an array of search keys for Firestore queries.
 * @param {string} raw 
 * @returns {{ valid: boolean, isbn10: string|null, isbn13: string|null, isbns: string[] }}
 */
export function normalizeIsbn(raw) {
    const cleaned = cleanIsbn(raw);
    let isbn10 = null;
    let isbn13 = null;
    let valid = false;

    if (cleaned.length === 10 && isValidIsbn10(cleaned)) {
        valid = true;
        isbn10 = cleaned;
        isbn13 = isbn10ToIsbn13(cleaned);
    } else if (cleaned.length === 13 && isValidIsbn13(cleaned)) {
        valid = true;
        isbn13 = cleaned;
        isbn10 = isbn13ToIsbn10(cleaned);
    }

    const isbns = [];
    if (isbn10) isbns.push(isbn10);
    if (isbn13 && !isbns.includes(isbn13)) isbns.push(isbn13);

    return {
        valid,
        isbn10,
        isbn13,
        isbns
    };
}

/**
 * Normalizes a book title for indexing, prefix search, and deduplication.
 * Strips leading articles ("the", "a", "an"), punctuation, and excess whitespace.
 * @param {string} raw 
 * @returns {string}
 */
export function normalizeTitle(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let text = raw.trim().toLowerCase();
    
    // Strip leading English articles
    text = text.replace(/^(the|a|an)\s+/i, '');
    
    // Remove punctuation & symbols, keep letters, numbers, and single spaces
    text = text.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
}

/**
 * Normalizes an author name for indexing and search matching.
 * @param {string} raw 
 * @returns {string}
 */
export function normalizeAuthor(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let text = raw.trim().toLowerCase();
    text = text.replace(/[^\p{L}\p{N}\s]/gu, '');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
}

/**
 * Normalizes a list of author names.
 * @param {string[]|string} authors 
 * @returns {{ authors: string[], authors_normalized: string[] }}
 */
export function normalizeAuthors(authors) {
    let authorList = [];
    if (Array.isArray(authors)) {
        authorList = authors;
    } else if (typeof authors === 'string') {
        authorList = authors.split(/,|&| and /i).map(s => s.trim()).filter(Boolean);
    }

    const cleanedAuthors = [];
    const normalizedAuthors = [];

    for (const a of authorList) {
        if (!a || typeof a !== 'string') continue;
        const trimmed = a.trim();
        if (!trimmed) continue;
        cleanedAuthors.push(trimmed);
        const norm = normalizeAuthor(trimmed);
        if (norm && !normalizedAuthors.includes(norm)) {
            normalizedAuthors.push(norm);
        }
    }

    return {
        authors: cleanedAuthors,
        authors_normalized: normalizedAuthors
    };
}

/**
 * Formats and validates canonical book record payload.
 * @param {Object} input 
 * @param {string} userId 
 * @returns {Object} canonical document
 */
export function buildCanonicalBookPayload(input, userId = 'system') {
    if (!input || !input.title || typeof input.title !== 'string' || !input.title.trim()) {
        throw new Error('Book title is required.');
    }

    const title = input.title.trim();
    const title_normalized = normalizeTitle(title);
    if (!title_normalized) {
        throw new Error('Book title must contain valid characters.');
    }

    const { authors, authors_normalized } = normalizeAuthors(input.authors || []);
    const isbnData = normalizeIsbn(input.isbn || input.isbn_13 || input.isbn_10 || '');

    // Allow preserving explicitly supplied isbns if not fully matched by check digits
    const isbns = [...isbnData.isbns];
    if (input.isbns && Array.isArray(input.isbns)) {
        for (const raw of input.isbns) {
            const c = cleanIsbn(raw);
            if (c && !isbns.includes(c)) isbns.push(c);
        }
    }

    const publishedYear = input.published_year ? parseInt(input.published_year, 10) : null;

    return {
        title,
        title_normalized,
        authors,
        authors_normalized,
        isbn_10: isbnData.isbn10 || input.isbn_10 || null,
        isbn_13: isbnData.isbn13 || input.isbn_13 || null,
        isbns,
        publisher: input.publisher ? String(input.publisher).trim() : null,
        published_year: !isNaN(publishedYear) ? publishedYear : null,
        language: input.language ? String(input.language).trim().toLowerCase() : 'en',
        cover_url: input.cover_url ? String(input.cover_url).trim() : null,
        description: input.description ? String(input.description).trim() : null,
        source_identifiers: input.source_identifiers && typeof input.source_identifiers === 'object' 
            ? input.source_identifiers 
            : {},
        copies_count: typeof input.copies_count === 'number' && input.copies_count >= 0 ? input.copies_count : 0,
        available_copies_count: typeof input.available_copies_count === 'number' && input.available_copies_count >= 0 
            ? input.available_copies_count 
            : 0,
        created_by: userId,
        created_at: input.created_at || new Date(),
        updated_at: input.updated_at || new Date()
    };
}

/**
 * Calculates copy availability status and zero-copy UI presentation metadata.
 * @param {Object} book 
 * @returns {{ hasCopies: boolean, totalCopies: number, availableCopies: number, badge: string, actionLabel: string, ctaUrl: string }}
 */
export function getBookCopiesStatus(book) {
    const totalCopies = typeof book?.copies_count === 'number' ? book.copies_count : 0;
    const availableCopies = typeof book?.available_copies_count === 'number' ? book.available_copies_count : 0;
    const bookId = book?.id || '';

    if (totalCopies === 0) {
        return {
            hasCopies: false,
            totalCopies: 0,
            availableCopies: 0,
            badge: 'No copies yet',
            badgeClass: 'bg-stone-100 text-stone-600 border border-stone-200',
            message: 'No physical copies currently available in your circles or World of Books.',
            actionLabel: 'Be the first to share a copy',
            ctaUrl: bookId ? `/add-item.html?book_id=${encodeURIComponent(bookId)}` : '/add-item.html'
        };
    }

    if (availableCopies === 0) {
        return {
            hasCopies: true,
            totalCopies,
            availableCopies: 0,
            badge: 'All copies in use',
            badgeClass: 'bg-amber-100 text-amber-800 border border-amber-200',
            message: `${totalCopies} copy in circulation, currently checked out.`,
            actionLabel: 'Add to Want List',
            ctaUrl: bookId ? `/book-detail.html?id=${encodeURIComponent(bookId)}#want` : '#'
        };
    }

    return {
        hasCopies: true,
        totalCopies,
        availableCopies,
        badge: `${availableCopies} available`,
        badgeClass: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
        message: `${availableCopies} of ${totalCopies} copies ready to borrow or swap.`,
        actionLabel: 'View Copies',
        ctaUrl: bookId ? `/book-detail.html?id=${encodeURIComponent(bookId)}` : '#'
    };
}
