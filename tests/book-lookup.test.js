import assert from 'assert';
import {
    parsePublishedYear,
    sanitizeCoverUrl,
    checkRateLimit,
    fetchOpenLibraryByIsbn,
    searchGoogleBooks,
    lookupBookMetadata
} from '../functions/book-lookup.js';

console.log('Testing Book Metadata Lookup Module...');

// 1. Year parsing
assert.strictEqual(parsePublishedYear('2010-10-15'), 2010);
assert.strictEqual(parsePublishedYear('Published October 1998'), 1998);
assert.strictEqual(parsePublishedYear(1925), 1925);
assert.strictEqual(parsePublishedYear('ca. 1880?'), 1880);
assert.strictEqual(parsePublishedYear('invalid'), null);
assert.strictEqual(parsePublishedYear(null), null);

// 2. Cover URL sanitization
assert.strictEqual(sanitizeCoverUrl('http://books.google.com/test.jpg'), 'https://books.google.com/test.jpg');
assert.strictEqual(sanitizeCoverUrl('https://covers.openlibrary.org/b/id/123-L.jpg'), 'https://covers.openlibrary.org/b/id/123-L.jpg');
assert.strictEqual(sanitizeCoverUrl('javascript:alert(1)'), null);
assert.strictEqual(sanitizeCoverUrl(''), null);

// 3. Open Library Mock Response
const mockOpenLibraryResponse = {
    'ISBN:9780141439518': {
        title: 'Pride and Prejudice',
        authors: [{ name: 'Jane Austen' }],
        publishers: [{ name: 'Penguin Classics' }],
        publish_date: '2002',
        cover: {
            large: 'https://covers.openlibrary.org/b/id/8231856-L.jpg'
        },
        identifiers: {
            isbn_10: ['0141439513'],
            isbn_13: ['9780141439518']
        }
    }
};

const mockGoogleBooksResponse = {
    items: [
        {
            id: 'gb_123',
            volumeInfo: {
                title: 'Clean Code',
                subtitle: 'A Handbook of Agile Software Craftsmanship',
                authors: ['Robert C. Martin'],
                publisher: 'Prentice Hall',
                publishedDate: '2008-08-01',
                description: 'Even bad code can function...',
                industryIdentifiers: [
                    { type: 'ISBN_10', identifier: '0132350882' },
                    { type: 'ISBN_13', identifier: '9780132350884' }
                ],
                imageLinks: {
                    thumbnail: 'http://books.google.com/clean_code.jpg'
                },
                language: 'en'
            }
        }
    ]
};

// 4. Test Open Library Success (Primary)
let fetchCount = 0;
const mockFetchOLSuccess = async (url) => {
    fetchCount++;
    if (url.includes('openlibrary.org')) {
        return {
            ok: true,
            json: async () => mockOpenLibraryResponse
        };
    }
    return { ok: false, status: 404 };
};

const olResult = await lookupBookMetadata(
    { isbn: '9780141439518', actorId: 'user1' },
    { fetchFn: mockFetchOLSuccess }
);

assert.strictEqual(olResult.found, true);
assert.strictEqual(olResult.source, 'open_library');
assert.strictEqual(olResult.book.title, 'Pride and Prejudice');
assert.deepStrictEqual(olResult.book.authors, ['Jane Austen']);
assert.strictEqual(olResult.book.published_year, 2002);
assert.strictEqual(olResult.book.isbn_13, '9780141439518');
assert.strictEqual(olResult.book.cover_url, 'https://covers.openlibrary.org/b/id/8231856-L.jpg');

// 5. Test Caching (Second call must not invoke fetch)
const beforeCacheFetchCount = fetchCount;
const cachedResult = await lookupBookMetadata(
    { isbn: '9780141439518', actorId: 'user1' },
    { fetchFn: mockFetchOLSuccess }
);
assert.strictEqual(cachedResult.found, true);
assert.strictEqual(fetchCount, beforeCacheFetchCount, 'Cached result must not trigger additional fetch');

// 6. Test Fallback to Google Books when Open Library fails (404/empty)
const mockFetchOLFailGBSuccess = async (url) => {
    if (url.includes('openlibrary.org')) {
        return { ok: true, json: async () => ({}) }; // Empty Open Library response
    }
    if (url.includes('googleapis.com')) {
        return { ok: true, json: async () => mockGoogleBooksResponse };
    }
    return { ok: false };
};

const gbResult = await lookupBookMetadata(
    { isbn: '9780132350884', actorId: 'user2' },
    { fetchFn: mockFetchOLFailGBSuccess }
);

assert.strictEqual(gbResult.found, true);
assert.strictEqual(gbResult.source, 'google_books');
assert.strictEqual(gbResult.book.title, 'Clean Code: A Handbook of Agile Software Craftsmanship');
assert.deepStrictEqual(gbResult.book.authors, ['Robert C. Martin']);
assert.strictEqual(gbResult.book.published_year, 2008);
assert.strictEqual(gbResult.book.cover_url, 'https://books.google.com/clean_code.jpg', 'Must upgrade http to https');

// 7. Test Graceful Fallback when both providers fail (Manual entry unblocked)
const mockFetchAllFail = async () => ({ ok: false, status: 500 });
const failResult = await lookupBookMetadata(
    { isbn: '9780000000000', actorId: 'user3' },
    { fetchFn: mockFetchAllFail }
);

assert.strictEqual(failResult.found, false);
assert.strictEqual(failResult.book, null);
assert.deepStrictEqual(failResult.candidates, []);

// 8. Test Rate Limiting
const spamUser = 'spammer_user';
for (let i = 0; i < 30; i++) {
    assert.strictEqual(checkRateLimit(spamUser), true);
}
assert.strictEqual(checkRateLimit(spamUser), false, '31st request in 1 minute window must be rate limited');

const rateLimitedResult = await lookupBookMetadata(
    { isbn: '9780141439518', actorId: spamUser }
);
assert.strictEqual(rateLimitedResult.found, false);
assert.ok(rateLimitedResult.error.includes('Rate limit exceeded'));

console.log('[PASS] Book metadata lookup tests passed successfully!');
