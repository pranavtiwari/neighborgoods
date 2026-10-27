import assert from 'assert';
import {
    cleanIsbn,
    isValidIsbn10,
    isValidIsbn13,
    isbn10ToIsbn13,
    isbn13ToIsbn10,
    normalizeIsbn,
    normalizeTitle,
    normalizeAuthor,
    normalizeAuthors,
    buildCanonicalBookPayload,
    getBookCopiesStatus
} from '../functions/catalog.js';

console.log('Testing Canonical Catalog Module...');

// 1. ISBN Cleaning
assert.strictEqual(cleanIsbn('978-0-306-40615-7'), '9780306406157');
assert.strictEqual(cleanIsbn('0 306 40615 2'), '0306406152');
assert.strictEqual(cleanIsbn('0-8044-2957-x'), '080442957X');
assert.strictEqual(cleanIsbn(null), '');
assert.strictEqual(cleanIsbn(''), '');

// 2. ISBN Validation
assert.strictEqual(isValidIsbn10('0306406152'), true);
assert.strictEqual(isValidIsbn10('080442957X'), true);
assert.strictEqual(isValidIsbn10('0306406153'), false, 'Bad check digit must fail');
assert.strictEqual(isValidIsbn10('12345'), false, 'Short length must fail');

assert.strictEqual(isValidIsbn13('9780306406157'), true);
assert.strictEqual(isValidIsbn13('9780141439518'), true); // Pride and Prejudice
assert.strictEqual(isValidIsbn13('9780306406158'), false, 'Bad check digit must fail');
assert.strictEqual(isValidIsbn13('978030640615'), false, 'Short length must fail');

// 3. ISBN Conversion
assert.strictEqual(isbn10ToIsbn13('0306406152'), '9780306406157');
assert.strictEqual(isbn13ToIsbn10('9780306406157'), '0306406152');
assert.strictEqual(isbn13ToIsbn10('9791090636071'), null, '979 prefix cannot convert to ISBN-10');

// 4. normalizeIsbn
const norm10 = normalizeIsbn('0-306-40615-2');
assert.strictEqual(norm10.valid, true);
assert.strictEqual(norm10.isbn10, '0306406152');
assert.strictEqual(norm10.isbn13, '9780306406157');
assert.deepStrictEqual(norm10.isbns, ['0306406152', '9780306406157']);

const norm13 = normalizeIsbn('978-0-14-143951-8');
assert.strictEqual(norm13.valid, true);
assert.strictEqual(norm13.isbn13, '9780141439518');
assert.strictEqual(norm13.isbn10, '0141439513');
assert.ok(norm13.isbns.includes('9780141439518'));
assert.ok(norm13.isbns.includes('0141439513'));

const normInvalid = normalizeIsbn('invalid-isbn');
assert.strictEqual(normInvalid.valid, false);
assert.deepStrictEqual(normInvalid.isbns, []);

// 5. Title Normalization
assert.strictEqual(normalizeTitle('The Great Gatsby'), 'great gatsby');
assert.strictEqual(normalizeTitle('A Tale of Two Cities'), 'tale of two cities');
assert.strictEqual(normalizeTitle('An Imperial Affliction'), 'imperial affliction');
assert.strictEqual(normalizeTitle('To Kill a Mockingbird'), 'to kill a mockingbird');
assert.strictEqual(normalizeTitle('  Clean Code: A Handbook!  '), 'clean code a handbook');
assert.strictEqual(normalizeTitle(''), '');

// 6. Author Normalization
assert.strictEqual(normalizeAuthor('J.K. Rowling'), 'jk rowling');
assert.strictEqual(normalizeAuthor('F. Scott Fitzgerald'), 'f scott fitzgerald');
assert.strictEqual(normalizeAuthor('Gabriel García Márquez'), 'gabriel garcía márquez');

const authorsObj = normalizeAuthors('Neil Gaiman, Terry Pratchett');
assert.deepStrictEqual(authorsObj.authors, ['Neil Gaiman', 'Terry Pratchett']);
assert.deepStrictEqual(authorsObj.authors_normalized, ['neil gaiman', 'terry pratchett']);

// 7. Canonical Book Payload Builder
const payload = buildCanonicalBookPayload({
    title: '  The Hobbit  ',
    authors: ['J.R.R. Tolkien'],
    isbn: '9780547928227',
    publisher: 'Houghton Mifflin',
    published_year: 1937,
    description: 'A fantasy novel.'
}, 'user_alice');

assert.strictEqual(payload.title, 'The Hobbit');
assert.strictEqual(payload.title_normalized, 'hobbit');
assert.deepStrictEqual(payload.authors, ['J.R.R. Tolkien']);
assert.deepStrictEqual(payload.authors_normalized, ['jrr tolkien']);
assert.strictEqual(payload.isbn_13, '9780547928227');
assert.strictEqual(payload.published_year, 1937);
assert.strictEqual(payload.copies_count, 0);
assert.strictEqual(payload.available_copies_count, 0);
assert.strictEqual(payload.created_by, 'user_alice');

// Must reject empty title
assert.throws(() => {
    buildCanonicalBookPayload({ title: '   ' });
}, /Book title is required/);

// 8. Zero-Copy and Copies Status Presentation
const zeroCopiesStatus = getBookCopiesStatus({ id: 'book_123', copies_count: 0, available_copies_count: 0 });
assert.strictEqual(zeroCopiesStatus.hasCopies, false);
assert.strictEqual(zeroCopiesStatus.totalCopies, 0);
assert.strictEqual(zeroCopiesStatus.badge, 'No copies yet');
assert.strictEqual(zeroCopiesStatus.actionLabel, 'Be the first to share a copy');
assert.strictEqual(zeroCopiesStatus.ctaUrl, '/add-item.html?book_id=book_123');

const allCheckedOutStatus = getBookCopiesStatus({ id: 'book_123', copies_count: 2, available_copies_count: 0 });
assert.strictEqual(allCheckedOutStatus.hasCopies, true);
assert.strictEqual(allCheckedOutStatus.availableCopies, 0);
assert.strictEqual(allCheckedOutStatus.badge, 'All copies in use');
assert.strictEqual(allCheckedOutStatus.actionLabel, 'Add to Want List');

const availableStatus = getBookCopiesStatus({ id: 'book_123', copies_count: 3, available_copies_count: 2 });
assert.strictEqual(availableStatus.hasCopies, true);
assert.strictEqual(availableStatus.availableCopies, 2);
assert.strictEqual(availableStatus.badge, '2 available');
assert.strictEqual(availableStatus.actionLabel, 'View Copies');

console.log('[PASS] Canonical catalog tests passed successfully!');
