// Firebase Client Initialization & Database Wrapper
// Loads credentials from config.js

if (!window.ENV || !window.ENV.FIREBASE_API_KEY) {
    console.error('Firebase credentials not found. Please ensure config.js is loaded with correct Firebase configuration.');
} else {
    // Initialize Firebase Compat SDK
    const firebaseConfig = {
        apiKey: window.ENV.FIREBASE_API_KEY,
        authDomain: window.ENV.FIREBASE_AUTH_DOMAIN,
        projectId: window.ENV.FIREBASE_PROJECT_ID,
        storageBucket: window.ENV.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: window.ENV.FIREBASE_MESSAGING_SENDER_ID,
        appId: window.ENV.FIREBASE_APP_ID
    };

    firebase.initializeApp(firebaseConfig);
    console.log('Firebase initialized successfully.');

    // Enable offline persistence
    try {
        const db = firebase.firestore();
        if (typeof firebase.firestore.persistentLocalCache === 'function' &&
            typeof firebase.firestore.persistentMultipleTabManager === 'function') {
            db.settings({
                localCache: firebase.firestore.persistentLocalCache({
                    tabManager: firebase.firestore.persistentMultipleTabManager()
                })
            });
        } else if (typeof db.enablePersistence === 'function') {
            db.enablePersistence().catch((err) => {
                console.warn('Firestore offline persistence fallback failed:', err);
            });
        }
    } catch (err) {
        console.warn('Firestore persistence settings failed:', err);
    }

    // Ensure a Firestore profile exists for an authenticated user
    async function ensureProfile(user) {
        if (!user) return;
        try {
            const profileRef = firebase.firestore().collection('profiles').doc(user.uid);
            const doc = await profileRef.get();
            if (!doc.exists) {
                await profileRef.set({
                    full_name: user.displayName || 'Neighbor',
                    avatar_url: user.photoURL || `https://i.pravatar.cc/150?u=${user.uid}`,
                    bio: '',
                    reputation_score: 5.0,
                    carbon_saved_kg: 0,
                    location: '',
                    created_at: firebase.firestore.FieldValue.serverTimestamp(),
                    updated_at: firebase.firestore.FieldValue.serverTimestamp()
                });
            }
        } catch (profileError) {
            console.warn('Profile fetch/creation failed during Google Auth. User is still authenticated:', profileError);
        }
    }

    // Helper function to handle Google Login
    // Uses the redirect flow instead of popup: Google's OAuth responses now send
    // a Cross-Origin-Opener-Policy header that severs the popup handle, which
    // makes firebase.auth().signInWithPopup() unreliable (auth/cancelled-popup-request).
    const REDIRECT_LOGIN_FLAG = 'pg_login_in_progress';
    const REDIRECT_TARGET_KEY = 'post_auth_redirect';
    window.loginWithGoogle = async function(redirectTo = 'explore.html') {
        sessionStorage.setItem(REDIRECT_LOGIN_FLAG, '1');
        sessionStorage.setItem(REDIRECT_TARGET_KEY, redirectTo || 'explore.html');
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
            await firebase.auth().signInWithRedirect(provider);
        } catch (error) {
            sessionStorage.removeItem(REDIRECT_LOGIN_FLAG);
            sessionStorage.removeItem(REDIRECT_TARGET_KEY);
            console.error('Login error:', error);
            alert('Login failed: ' + error.message);
        }
    };

    // Complete a Google redirect sign-in on the way back from accounts.google.com
    firebase.auth().getRedirectResult().then(async (result) => {
        // Always clear the flag — whether the redirect succeeded, was cancelled, or there was no pending redirect
        const target = sessionStorage.getItem(REDIRECT_TARGET_KEY) || 'explore.html';
        sessionStorage.removeItem(REDIRECT_LOGIN_FLAG);
        sessionStorage.removeItem(REDIRECT_TARGET_KEY);
        if (!result || !result.user) return;
        const user = result.user;
        await ensureProfile(user);
        window.location.href = safeRedirect(target);
    }).catch((error) => {
        sessionStorage.removeItem(REDIRECT_LOGIN_FLAG);
        sessionStorage.removeItem(REDIRECT_TARGET_KEY);
        console.error('Redirect login error:', error);
        alert('Login failed: ' + error.message);
    });

    // Helper function to handle Email/Password Login
    // Allowed post-auth redirect targets (VULN-19: open redirect prevention)
    const ALLOWED_REDIRECTS = new Set([
        'explore.html', 'index.html', 'circles.html', 'profile.html',
        'messages.html', 'activity.html', 'edit-profile.html', 'add-item.html'
    ]);
    function safeRedirect(redirectTo, fallback = 'explore.html') {
        const target = (redirectTo || fallback).split('?')[0].split('#')[0];
        return ALLOWED_REDIRECTS.has(target) ? redirectTo : fallback;
    }

    window.loginWithEmail = async function(email, password, redirectTo = 'explore.html') {
        try {
            await firebase.auth().signInWithEmailAndPassword(email, password);
            window.location.href = safeRedirect(redirectTo);
        } catch (error) {
            console.error('Email login error:', error);
            throw error;
        }
    };

    // Helper function to handle Email/Password Registration
    // VULN-15: Password complexity enforced (min 8 chars, uppercase, digit)
    window.registerWithEmail = async function(email, password, fullName, redirectTo = 'explore.html') {
        // Password complexity check (client-side defence-in-depth)
        if (!password || password.length < 8) {
            throw new Error('Password must be at least 8 characters long.');
        }
        if (!/[A-Z]/.test(password)) {
            throw new Error('Password must contain at least one uppercase letter.');
        }
        if (!/[0-9]/.test(password)) {
            throw new Error('Password must contain at least one number.');
        }
        try {
            const result = await firebase.auth().createUserWithEmailAndPassword(email, password);
            const user = result.user;
            
            // Create profile
            const profileRef = firebase.firestore().collection('profiles').doc(user.uid);
            await profileRef.set({
                full_name: fullName || 'Neighbor',
                avatar_url: `https://i.pravatar.cc/150?u=${user.uid}`,
                bio: '',
                reputation_score: 5.0,
                carbon_saved_kg: 0,
                location: '',
                created_at: firebase.firestore.FieldValue.serverTimestamp(),
                updated_at: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            window.location.href = safeRedirect(redirectTo);
        } catch (error) {
            console.error('Email registration error:', error);
            throw error;
        }
    };

    // Helper function to handle Logout
    window.logout = async function() {
        try {
            await firebase.auth().signOut();
            window.location.href = 'index.html';
        } catch (error) {
            console.error('Logout error:', error.message);
        }
    };

    // VULN-16: Password reset flow (was missing entirely)
    window.resetPassword = async function(email) {
        if (!email || !email.includes('@')) {
            throw new Error('Please enter a valid email address.');
        }
        try {
            await firebase.auth().sendPasswordResetEmail(email);
        } catch (error) {
            console.error('Password reset error:', error);
            throw error;
        }
    };

    // Helper function to protect routes
    window.requireAuth = async function(redirectUrl = 'join-community.html') {
        return new Promise((resolve) => {
            const unsubscribe = firebase.auth().onAuthStateChanged((user) => {
                unsubscribe();
                if (!user) {
                    console.warn('Unauthorized access. Redirecting to login.');
                    window.location.href = redirectUrl;
                    resolve(null);
                } else {
                    user.id = user.uid; // Add compatibility mapping
                    resolve({ user: user });
                }
            });
        });
    };

    // Listen to auth changes globally (to handle sign outs)
    firebase.auth().onAuthStateChanged((user) => {
        const path = window.location.pathname;
        if (!user && 
            !path.includes('join-community') && 
            path !== '/' && 
            !path.includes('index')) {
            window.location.href = 'join-community.html';
        } else if (user) {
            const updateBadges = async () => {
                try {
                    const count = await window.db.getUnreadCount(user.uid);
                    const badges = document.querySelectorAll('.unread-badge-el');
                    badges.forEach(badge => {
                        if (count > 0) {
                            badge.textContent = count;
                            badge.classList.remove('hidden');
                        } else {
                            badge.classList.add('hidden');
                        }
                    });
                } catch (err) {
                    console.error("Error updating unread count badge:", err);
                }
            };
            updateBadges();
            // Update every 30 seconds
            setInterval(updateBadges, 30000);
        }
    });

    // --- Unified Database (Firestore) & Storage API ---
    window.db = {
        profilesCache: {},
        _profilePromises: {},
        _reputationCache: {},

        escapeHtml: function(str) {
            if (!str) return '';
            return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },
        // Escape a string for safe insertion into an HTML attribute value.
        escapeAttr: function(str) {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },
        // Validate a URL is safe to use in a src/href attribute:
        // - Only http:, https:, or data: protocols are allowed (blocks javascript:, vbscript:, etc.)
        // - The URL is then HTML-attribute-escaped to prevent attribute breakout
        // Returns '' if the URL is invalid or uses a dangerous protocol.
        sanitizeUrl: function(url) {
            if (!url) return '';
            try {
                const parsed = new URL(url, window.location.origin);
                if (!['http:', 'https:', 'data:'].includes(parsed.protocol)) return '';
            } catch (e) {
                // Relative URLs are fine; only reject if URL() throws AND it looks dangerous
                if (/^javascript:/i.test(url.trim()) || /^vbscript:/i.test(url.trim())) return '';
            }
            return this.escapeAttr(url);
        },
        // --- Category Taxonomy and Fuzzy Matching ---
        CATEGORY_TAXONOMY: {
            garden: {
                label: 'Garden Tools',
                subcategories: ['lawn mower', 'rake', 'shovel', 'hose', 'shear', 'seeds', 'pots', 'soil', 'gardening', 'lawn', 'plants', 'yard'],
                parents: ['outdoor', 'home maintenance'],
                synonyms: ['garden', 'gardening', 'yardwork', 'yard work', 'landscaping']
            },
            power: {
                label: 'Power Tools',
                subcategories: ['drill', 'saw', 'sander', 'grinder', 'compressor', 'generator', 'nail gun', 'router'],
                parents: ['tools', 'workshop', 'hardware'],
                synonyms: ['power tools', 'machinery', 'electric tools']
            },
            kitchen: {
                label: 'Kitchen Gear',
                subcategories: ['blender', 'mixer', 'air fryer', 'dehydrator', 'slow cooker', 'waffle maker', 'juicer', 'pots', 'pans', 'espresso machine', 'coffee maker', 'toaster', 'food processor'],
                parents: ['home', 'cooking', 'appliances'],
                synonyms: ['kitchen', 'cooking gear', 'baking', 'culinary']
            },
            'electronics/computers': {
                label: 'Electronics & Computers',
                subcategories: ['laptop', 'monitor', 'keyboard', 'mouse', 'printer', 'projector', 'camera', 'headphones', 'speaker', 'charger', 'tablet', 'phone', 'router', 'cable', 'tv', 'television', 'audio'],
                parents: ['electronics', 'technology', 'office', 'entertainment'],
                synonyms: ['electronics', 'computers', 'tech', 'gadgets']
            },
            books: {
                label: 'Books',
                subcategories: ['fiction', 'non-fiction', 'textbook', 'novel', 'biography', 'comic', 'manga', 'cookbook', 'dictionary', 'encyclopedia', 'magazine'],
                parents: ['education', 'reading', 'entertainment'],
                synonyms: ['books', 'literature', 'novels', 'reading material']
            },
            skills: {
                label: 'Experience & Skills',
                subcategories: ['tutoring', 'lessons', 'coaching', 'consulting', 'cooking class', 'music lesson', 'mentoring', 'advising'],
                parents: ['services', 'education'],
                synonyms: ['skills', 'experience', 'services', 'lessons', 'classes']
            },
            'neighbour-helping-neighbour': {
                label: 'Neighbour helping Neighbour',
                subcategories: ['volunteering', 'lending a hand', 'moving help', 'yard work', 'babysitting', 'pet sitting', 'errands', 'dog walking', 'chores'],
                parents: ['services', 'community'],
                synonyms: ['help', 'helping', 'assistance', 'volunteer', 'community service']
            },
            outdoor: {
                label: 'Outdoor Adventure',
                subcategories: ['hiking', 'climbing', 'kayak', 'canoe', 'paddleboard', 'backpack', 'sleeping bag', 'tent', 'binoculars', 'surfboard', 'skis', 'snowboard'],
                parents: ['sports', 'recreation', 'entertainment', 'travel'],
                synonyms: ['outdoor', 'adventure', 'nature', 'recreation', 'sports equipment']
            },
            party: {
                label: 'Party & Event Supplies',
                subcategories: ['tent', 'folding table', 'folding chair', 'speaker', 'lights', 'projector', 'cooler', 'decorations', 'costumes', 'karaoke', 'balloons', 'disco ball'],
                parents: ['entertainment', 'events'],
                synonyms: ['party', 'event', 'supplies', 'celebration', 'gathering']
            },
            baby: {
                label: 'Baby & Kids Gear',
                subcategories: ['stroller', 'car seat', 'crib', 'toys', 'baby carrier', 'high chair', 'playpen', 'baby monitor', 'diaper bag'],
                parents: ['family', 'kids'],
                synonyms: ['baby', 'kids', 'toddler', 'infant', 'children']
            },
            sports: {
                label: 'Sports & Recreation',
                subcategories: ['soccer', 'football', 'basketball', 'tennis', 'badminton', 'hockey', 'golf', 'gym', 'fitness', 'workout', 'weights', 'bicycle', 'skateboard', 'yoga mat', 'dumbbell', 'treadmill', 'sports equipment', 'cleats'],
                parents: ['entertainment', 'recreation', 'fitness', 'outdoor'],
                synonyms: ['sports', 'recreation', 'athletics', 'fitness', 'workout', 'sports equipment', 'exercise']
            },
            camping: {
                label: 'Camping & Travel',
                subcategories: ['tent', 'sleeping bag', 'camping stove', 'backpack', 'cooler', 'lantern', 'luggage', 'sleeping pad', 'tarp', 'compass'],
                parents: ['outdoor', 'travel'],
                synonyms: ['camping', 'travel', 'hiking', 'backpacking']
            },
            games: {
                label: 'Board Games, Toys & Puzzles',
                subcategories: ['board game', 'card game', 'chess', 'puzzle', 'lego', 'action figure', 'doll', 'monopoly', 'catan', 'scrabble', 'jigsaw'],
                parents: ['entertainment', 'toys'],
                synonyms: ['board games', 'toys', 'puzzles', 'games', 'gaming']
            },
            crafts: {
                label: 'Arts, Crafts & Sewing',
                subcategories: ['sewing machine', 'easel', 'knitting', 'yarn', 'paint', 'brushes', 'craft supplies', 'clay', 'canvas', 'thread'],
                parents: ['hobbies', 'art', 'entertainment'],
                synonyms: ['arts', 'crafts', 'sewing', 'diy', 'knitting', 'art supplies']
            },
            automotive: {
                label: 'Automotive Tools & Care',
                subcategories: ['jack', 'wrench', 'car wash', 'jumper cables', 'tire inflator', 'motor oil', 'car vacuum', 'buffer'],
                parents: ['tools', 'vehicles'],
                synonyms: ['automotive', 'car care', 'car tools', 'auto']
            },
            music: {
                label: 'Music & Instruments',
                subcategories: ['guitar', 'keyboard', 'piano', 'violin', 'drums', 'ukulele', 'microphone', 'amplifier', 'synthesizer', 'flute', 'trumpet', 'accordion'],
                parents: ['entertainment', 'art', 'audio'],
                synonyms: ['music', 'instruments', 'musical instruments', 'audio gear']
            },
            other: {
                label: 'Other',
                subcategories: [],
                parents: [],
                synonyms: []
            }
        },

        CATEGORIES: [
            { value: 'garden', label: 'Garden Tools' },
            { value: 'power', label: 'Power Tools' },
            { value: 'kitchen', label: 'Kitchen Gear' },
            { value: 'electronics/computers', label: 'Electronics & Computers' },
            { value: 'books', label: 'Books' },
            { value: 'skills', label: 'Experience & Skills' },
            { value: 'neighbour-helping-neighbour', label: 'Neighbour helping Neighbour' },
            { value: 'outdoor', label: 'Outdoor Adventure' },
            { value: 'party', label: 'Party & Event Supplies' },
            { value: 'baby', label: 'Baby & Kids Gear' },
            { value: 'sports', label: 'Sports & Recreation' },
            { value: 'camping', label: 'Camping & Travel' },
            { value: 'games', label: 'Board Games, Toys & Puzzles' },
            { value: 'crafts', label: 'Arts, Crafts & Sewing' },
            { value: 'automotive', label: 'Automotive Tools & Care' },
            { value: 'music', label: 'Music & Instruments' },
            { value: 'other', label: 'Other' }
        ],

        getParentCategoryKey: function(subcat) {
            if (!subcat) return null;
            const sub = subcat.toLowerCase().trim();
            for (const [key, details] of Object.entries(this.CATEGORY_TAXONOMY)) {
                if (key === sub) return null;
                if (details.subcategories && details.subcategories.map(s => s.toLowerCase()).includes(sub)) {
                    return key;
                }
            }
            return null;
        },

        categoryMatches: function(itemCategories, targetCategory) {
            if (!targetCategory || targetCategory === 'all') return true;
            const target = targetCategory.toLowerCase().trim();
            const cats = Array.isArray(itemCategories) ? itemCategories : [itemCategories];
            
            for (const cat of cats) {
                if (!cat) continue;
                const c = cat.toLowerCase().trim();
                if (c === target) return true;
                
                const details = this.CATEGORY_TAXONOMY[c];
                if (details) {
                    if (details.parents && details.parents.map(p => p.toLowerCase()).includes(target)) {
                        return true;
                    }
                    if (details.synonyms && details.synonyms.map(s => s.toLowerCase()).includes(target)) {
                        return true;
                    }
                } else {
                    const targetDetails = this.CATEGORY_TAXONOMY[target];
                    if (targetDetails) {
                        if (targetDetails.subcategories && targetDetails.subcategories.map(s => s.toLowerCase()).includes(c)) {
                            return true;
                        }
                        if (targetDetails.synonyms && targetDetails.synonyms.map(s => s.toLowerCase()).includes(c)) {
                            return true;
                        }
                    }
                }
            }
            return false;
        },

        getSemanticTerms: function(item) {
            const terms = new Set();
            if (item.name) terms.add(item.name.toLowerCase());
            if (item.description) terms.add(item.description.toLowerCase());
            
            const itemCats = [];
            if (item.category) itemCats.push(item.category.toLowerCase().trim());
            if (item.categories && Array.isArray(item.categories)) {
                item.categories.forEach(c => {
                    if (c) itemCats.push(c.toLowerCase().trim());
                });
            }
            
            itemCats.forEach(cat => {
                terms.add(cat);
                const details = this.CATEGORY_TAXONOMY[cat];
                if (details) {
                    terms.add(details.label.toLowerCase());
                    (details.synonyms || []).forEach(s => terms.add(s.toLowerCase()));
                    (details.subcategories || []).forEach(s => terms.add(s.toLowerCase()));
                    (details.parents || []).forEach(p => terms.add(p.toLowerCase()));
                } else {
                    for (const [key, d] of Object.entries(this.CATEGORY_TAXONOMY)) {
                        if (d.subcategories && d.subcategories.map(s => s.toLowerCase()).includes(cat)) {
                            terms.add(key);
                            terms.add(d.label.toLowerCase());
                            (d.parents || []).forEach(p => terms.add(p.toLowerCase()));
                            (d.synonyms || []).forEach(s => terms.add(s.toLowerCase()));
                        }
                    }
                }
            });
            return Array.from(terms);
        },

        matchesSearchFuzzy: function(item, searchPattern) {
            if (!searchPattern) return true;
            const pattern = searchPattern.toLowerCase().trim();
            if (pattern === '') return true;

            const name = (item.name || '').toLowerCase();
            const desc = (item.description || '').toLowerCase();
            if (name.includes(pattern) || desc.includes(pattern)) return true;

            const terms = this.getSemanticTerms(item);
            return terms.some(term => term.includes(pattern) || pattern.includes(term));
        },

        getCategoryOptions: function() {
            const options = [];
            for (const [key, details] of Object.entries(this.CATEGORY_TAXONOMY)) {
                options.push({ value: key, label: details.label });
                if (details.subcategories) {
                    details.subcategories.forEach(sub => {
                        if (!options.some(opt => opt.value === sub)) {
                            const displayLabel = sub.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                            options.push({
                                value: sub,
                                label: `${details.label} > ${displayLabel}`,
                                parentValue: key
                            });
                        }
                    });
                }
            }
            return options;
        },

        // --- Profiles ---
        getProfile: async function(profileId) {
            if (!profileId) return null;
            if (this.profilesCache[profileId]) {
                return this.profilesCache[profileId];
            }
            if (!this._profilePromises) this._profilePromises = {};
            if (this._profilePromises[profileId]) {
                return this._profilePromises[profileId];
            }
            this._profilePromises[profileId] = (async () => {
                try {
                    const doc = await firebase.firestore().collection('profiles').doc(profileId).get();
                    const profile = doc.exists ? { id: doc.id, ...doc.data() } : null;
                    this.profilesCache[profileId] = profile;
                    return profile;
                } catch (err) {
                    console.error("Error getting profile:", err);
                    return null;
                } finally {
                    delete this._profilePromises[profileId];
                }
            })();
            return this._profilePromises[profileId];
        },

        updateProfile: async function(profileId, profileData) {
            delete this.profilesCache[profileId];
            try {
                await firebase.firestore().collection('profiles').doc(profileId).set({
                    ...profileData,
                    updated_at: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            } catch (err) {
                console.error("Error updating profile:", err);
                throw err;
            }
        },

        // --- Storage ---
        uploadFile: async function(path, file) {
            try {
                const ref = firebase.storage().ref().child(path);
                const snapshot = await ref.put(file);
                return await snapshot.ref.getDownloadURL();
            } catch (err) {
                console.warn("Storage upload failed or is disabled. Falling back to compressed Base64 data URL:", err);
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const img = new Image();
                        img.onload = () => {
                            // Define maximum dimensions (e.g. 800px max width/height)
                            const MAX_WIDTH = 800;
                            const MAX_HEIGHT = 800;
                            let width = img.width;
                            let height = img.height;

                            // Calculate new dimensions while maintaining aspect ratio
                            if (width > height) {
                                if (width > MAX_WIDTH) {
                                    height = Math.round((height * MAX_WIDTH) / width);
                                    width = MAX_WIDTH;
                                }
                            } else {
                                if (height > MAX_HEIGHT) {
                                    width = Math.round((width * MAX_HEIGHT) / height);
                                    height = MAX_HEIGHT;
                                }
                            }

                            // Create an offscreen canvas to perform resizing and compression
                            const canvas = document.createElement('canvas');
                            canvas.width = width;
                            canvas.height = height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0, width, height);

                            // Export as compressed JPEG (quality: 0.7)
                            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                            resolve(dataUrl);
                        };
                        img.onerror = (e) => reject(new Error("Failed to load image for resizing"));
                        img.src = event.target.result;
                    };
                    reader.onerror = (e) => reject(new Error("Failed to read file as data URL: " + e.target.error));
                    reader.readAsDataURL(file);
                });
            }
        },

        // --- Items ---
        // Page size for catalogue reads. Previously this was an unbounded `.get()`
        // over the entire `items` collection followed by in-memory filtering,
        // so cost and latency grew linearly with the whole catalogue and the
        // 1500-read cap silently truncated results.
        ITEMS_PAGE_SIZE: 24,

        /**
         * Paginated catalogue read.
         * @param {string} category    'all' or a category id
         * @param {string|null} userId viewer uid for circle-scoped visibility
         * @param {object} opts        { pageSize, cursor }
         * @returns {{items: Array, nextCursor: any|null, hasMore: boolean}}
         */
        getItemsPage: async function(category = 'all', userId = null, opts = {}) {
            const pageSize = opts.pageSize || this.ITEMS_PAGE_SIZE;
            const cursor = opts.cursor || null;
            try {
                const db = firebase.firestore();

                // Push filtering into Firestore where it is expressible, so the
                // server bounds the result set instead of us reading everything
                // and discarding most of it. `categories` is an array on newer
                // listings and `category` a scalar on older ones.
                // One query shape, reused by the initial read and the refill
                // loop below. The fallback variant simply drops the server-side
                // category filter (and the ordering, if that fails too) while
                // keeping `pageSize + 1` and the cursor, so `hasMore` and
                // `nextCursor` mean the same thing on every path.
                let useServerCategoryFilter = category !== 'all';
                const buildPageQuery = (cursorIn) => {
                    let q = db.collection('items');
                    if (useServerCategoryFilter) {
                        q = q.where('categories', 'array-contains', category);
                    }
                    q = q.orderBy('created_at', 'desc').limit(pageSize + 1);
                    return cursorIn ? q.startAfter(cursorIn) : q;
                };

                let snapshot = null;
                let ordered = true;
                try {
                    snapshot = await buildPageQuery(cursor).get();
                } catch (qErr) {
                    // Only retry when there is a filter left to drop. With
                    // category === 'all' the first attempt was already bare,
                    // so retrying it would just repeat the same failure.
                    if (useServerCategoryFilter) {
                        useServerCategoryFilter = false;
                        try {
                            snapshot = await buildPageQuery(cursor).get();
                        } catch (orderErr) {
                            snapshot = null;
                        }
                    }
                    if (!snapshot) {
                        // Missing composite index (or no created_at values
                        // yet). Read unordered and stop paginating rather than
                        // failing the whole page.
                        ordered = false;
                        let bare = db.collection('items').limit(pageSize + 1);
                        if (cursor) bare = bare.startAfter(cursor);
                        snapshot = await bare.get();
                    }
                }

                const docs = snapshot.docs;
                const hasMore = ordered && docs.length > pageSize;
                const page = docs.slice(0, pageSize);

                let items = page.map(doc => ({ id: doc.id, ...doc.data() }));

                // Legacy listings only carry the scalar `category`.
                if (category !== 'all') {
                    items = items.filter(item =>
                        (item.categories && Array.isArray(item.categories) && item.categories.includes(category))
                        || item.category === category
                    );
                }

                // Circle-scoped visibility filtering.
                // Hoisted: the refill loop below re-applies the same predicate.
                let myCircleIds = null;
                if (userId) {
                    const memberships = await this.getMyMemberships(userId);
                    myCircleIds = new Set(memberships.map(m => m.circle_id));
                }
                const isVisible = item => {
                    if (userId) {
                        if (item.circle_ids && item.circle_ids.length > 0) {
                            return item.circle_ids.some(cid => myCircleIds.has(cid));
                        }
                        return !item.circle_id || myCircleIds.has(item.circle_id);
                    }
                    // Unauthenticated: only show items with no circle scope.
                    return !item.circle_id && (!item.circle_ids || item.circle_ids.length === 0);
                };
                items = items.filter(isVisible);

                // Circle-scoped visibility can empty a page that is otherwise
                // full (or entirely), so keep pulling until we fill the page
                // or run out of documents.
                //
                // This used to be gated on `!usedServerCategoryFilter && hasMore`,
                // which was always false — `hasMore` is forced false on the
                // fallback path — so the refill never ran in either branch and
                // a viewer whose circles hid everything saw a blank grid while
                // `hasMore` still said there was more to load.
                let nextCursor = page.length ? page[page.length - 1] : null;
                let exhausted = !hasMore;
                while (!exhausted && ordered && items.length < pageSize) {
                    let more;
                    try {
                        more = await buildPageQuery(nextCursor).get();
                    } catch (refillErr) {
                        break;
                    }
                    if (more.empty) break;
                    const moreDocs = more.docs.slice(0, pageSize);
                    if (moreDocs.length === 0) break;
                    exhausted = more.docs.length <= pageSize;
                    nextCursor = moreDocs[moreDocs.length - 1];
                    let moreItems = moreDocs.map(doc => ({ id: doc.id, ...doc.data() }));
                    if (category !== 'all') {
                        moreItems = moreItems.filter(item =>
                            (item.categories && Array.isArray(item.categories) && item.categories.includes(category))
                            || item.category === category
                        );
                    }
                    items = items.concat(moreItems.filter(isVisible));
                }

                return {
                    items,
                    nextCursor,
                    hasMore: !exhausted
                };
            } catch (err) {
                console.error("Error getting items:", err);
                return { items: [], nextCursor: null, hasMore: false };
            }
        },

        // Back-compat wrapper: returns just the first page as an array.
        getItems: async function(category = 'all', userId = null) {
            const page = await this.getItemsPage(category, userId, {});
            return page.items;
        },

        getMyItemsPage: async function(ownerId, opts = {}) {
            const pageSize = opts.pageSize || this.ITEMS_PAGE_SIZE;
            const cursor = opts.cursor || null;
            try {
                let query = firebase.firestore().collection('items')
                    .where('owner_id', '==', ownerId)
                    .orderBy('created_at', 'desc')
                    .limit(pageSize + 1);
                if (cursor) query = query.startAfter(cursor);
                const snapshot = await query.get();
                const docs = snapshot.docs;
                const hasMore = docs.length > pageSize;
                const page = hasMore ? docs.slice(0, pageSize) : docs;
                return {
                    items: page.map(doc => ({ id: doc.id, ...doc.data() })),
                    nextCursor: page.length ? page[page.length - 1] : null,
                    hasMore
                };
            } catch (err) {
                console.error("Error getting my items:", err);
                return { items: [], nextCursor: null, hasMore: false };
            }
        },

        getMyItems: async function(ownerId) {
            const page = await this.getMyItemsPage(ownerId, {});
            return page.items;
        },

        getCircleItems: async function(circleId) {
            try {
                const dbRef = firebase.firestore().collection('items');
                const [snap1, snap2] = await Promise.all([
                    dbRef.where('circle_id', '==', circleId).get(),
                    dbRef.where('circle_ids', 'array-contains', circleId).get()
                ]);
                const itemsMap = {};
                snap1.docs.forEach(doc => {
                    itemsMap[doc.id] = { id: doc.id, ...doc.data() };
                });
                snap2.docs.forEach(doc => {
                    itemsMap[doc.id] = { id: doc.id, ...doc.data() };
                });
                return Object.values(itemsMap);
            } catch (err) {
                console.error("Error getting circle items:", err);
                return [];
            }
        },

        getItem: async function(itemId) {
            try {
                const doc = await firebase.firestore().collection('items').doc(itemId).get();
                if (!doc.exists) return null;
                const data = doc.data();
                
                // Emulate join for profiles
                const profile = await this.getProfile(data.owner_id);
                return { id: doc.id, ...data, profiles: profile };
            } catch (err) {
                console.error("Error getting item details:", err);
                return null;
            }
        },

        addItem: async function(itemData) {
            try {
                const user = firebase.auth().currentUser;
                let ownerName = 'Neighbor';
                let ownerAvatar = '';
                if (user) {
                    const profile = await this.getProfile(user.uid);
                    if (profile) {
                        ownerName = profile.full_name || 'Neighbor';
                        ownerAvatar = profile.avatar_url || '';
                    }
                }

                const doc = {
                    ...itemData,
                    owner_name: ownerName,
                    owner_avatar: ownerAvatar,
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                };

                // Book spine fields. `name` is the display title used by the
                // existing item-details/explore UI; metadata is kept alongside
                // so the catalogue can be searched without loading everything.
                if (doc.isbn13) {
                    doc.isbn13 = String(doc.isbn13).replace(/[^0-9Xx]/g, '').toUpperCase();
                }
                if (!doc.root_category && doc.category) {
                    doc.root_category = doc.category;
                }
                doc.status = doc.status || 'available';
                doc.is_available = doc.is_available !== false;

                // A list without an explicit orderBy index (created_at) cannot
                // be queried efficiently, so an explicit doc id lets callers
                // page without a composite index.
                // Split location into public area and private exact address (Issue #6)
                const rawAddress = doc.exact_address || doc.location || '';
                let areaLocation = doc.location_area || '';
                if (rawAddress && !areaLocation) {
                    const parts = rawAddress.split(',').map(s => s.trim()).filter(Boolean);
                    areaLocation = parts.length >= 3 ? `${parts[parts.length - 2]}, ${parts[parts.length - 1]}` : (parts[parts.length - 1] || rawAddress);
                }
                doc.location_area = areaLocation;
                doc.location = areaLocation || rawAddress;
                delete doc.exact_address;

                const ref = firebase.firestore().collection('items').doc();
                await ref.set(doc);

                if (rawAddress) {
                    try {
                        await ref.collection('private').doc('location').set({
                            exact_address: rawAddress,
                            pickup_instructions: itemData.pickup_instructions || '',
                            created_at: firebase.firestore.FieldValue.serverTimestamp()
                        });
                    } catch (locErr) {
                        console.warn("Could not save private location subcollection:", locErr);
                    }
                }
                return { id: ref.id };
            } catch (err) {
                console.error("Error adding item:", err);
                throw err;
            }
        },

        updateItem: async function(itemId, itemData) {
            try {
                await firebase.firestore().collection('items').doc(itemId).set({
                    ...itemData,
                    updated_at: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                return { id: itemId };
            } catch (err) {
                console.error("Error updating item:", err);
                throw err;
            }
        },

        deleteItem: async function(itemId) {
            try {
                const docSnap = await firebase.firestore().collection('items').doc(itemId).get();
                if (docSnap.exists && docSnap.data().active_request_id) {
                    throw new Error("Cannot delete item with an active circulation transaction.");
                }
                await firebase.firestore().collection('items').doc(itemId).delete();
            } catch (err) {
                console.error("Error deleting item:", err);
                throw err;
            }
        },

        getItemPrivateLocation: async function(itemId) {
            if (!itemId) return null;
            try {
                const snap = await firebase.firestore().collection('items').doc(itemId).collection('private').doc('location').get();
                if (snap.exists) {
                    return snap.data();
                }
                return null;
            } catch (err) {
                return null;
            }
        },

        // --- Circles ---
        createCircle: async function(circleData, creatorId) {
            try {
                const db = firebase.firestore();
                const ref = await db.collection('circles').add({
                    ...circleData,
                    allowed_categories: circleData.allowed_categories || [],
                    created_by: creatorId,
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                });
                
                // Add creator as Admin member
                const id = `${ref.id}_${creatorId}`;
                await db.collection('circle_members').doc(id).set({
                    circle_id: ref.id,
                    profile_id: creatorId,
                    role: 'admin',
                    joined_at: new Date().toISOString()
                });
                
                return { id: ref.id };
            } catch (err) {
                console.error("Error creating circle:", err);
                throw err;
            }
        },

        getCircles: async function() {
            try {
                const snapshot = await firebase.firestore().collection('circles').get();
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            } catch (err) {
                console.error("Error getting circles:", err);
                return [];
            }
        },

        getCircle: async function(circleId) {
            try {
                const doc = await firebase.firestore().collection('circles').doc(circleId).get();
                return doc.exists ? { id: doc.id, ...doc.data() } : null;
            } catch (err) {
                console.error("Error getting circle:", err);
                return null;
            }
        },

        getCircleMembers: async function(circleId) {
            try {
                const snapshot = await firebase.firestore().collection('circle_members')
                    .where('circle_id', '==', circleId).get();
                
                const memberships = snapshot.docs.map(doc => doc.data());
                const members = await Promise.all(memberships.map(async (m) => {
                    const profile = await this.getProfile(m.profile_id);
                    if (profile) {
                        return { ...profile, role: m.role, joined_at: m.joined_at };
                    }
                    return null;
                }));
                return members.filter(Boolean);
            } catch (err) {
                console.error("Error getting circle members:", err);
                return [];
            }
        },

        getMyMemberships: async function(profileId) {
            try {
                const snapshot = await firebase.firestore().collection('circle_members')
                    .where('profile_id', '==', profileId).get();
                return snapshot.docs.map(doc => doc.data());
            } catch (err) {
                console.error("Error getting memberships:", err);
                return [];
            }
        },

        joinCircle: async function(circleId, profileId, role = 'member') {
            try {
                const id = `${circleId}_${profileId}`;
                await firebase.firestore().collection('circle_members').doc(id).set({
                    circle_id: circleId,
                    profile_id: profileId,
                    role: role,
                    joined_at: new Date().toISOString()
                });
            } catch (err) {
                console.error("Error joining circle:", err);
                throw err;
            }
        },

        leaveCircle: async function(circleId, profileId) {
            try {
                const id = `${circleId}_${profileId}`;
                await firebase.firestore().collection('circle_members').doc(id).delete();
            } catch (err) {
                console.error("Error leaving circle:", err);
                throw err;
            }
        },

        updateCircle: async function(circleId, data) {
            try {
                await firebase.firestore().collection('circles').doc(circleId).set({
                    ...data,
                    updated_at: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            } catch (err) {
                console.error("Error updating circle:", err);
                throw err;
            }
        },

        requestToJoinCircle: async function(circleId, profileId, message = '') {
            try {
                const id = `${circleId}_${profileId}`;
                await firebase.firestore().collection('circle_join_requests').doc(id).set({
                    circle_id: circleId,
                    profile_id: profileId,
                    status: 'pending',
                    message: message,
                    requested_at: firebase.firestore.FieldValue.serverTimestamp()
                });
            } catch (err) {
                console.error("Error requesting to join circle:", err);
                throw err;
            }
        },

        cancelJoinRequest: async function(circleId, profileId) {
            try {
                const id = `${circleId}_${profileId}`;
                await firebase.firestore().collection('circle_join_requests').doc(id).delete();
            } catch (err) {
                console.error("Error cancelling join request:", err);
                throw err;
            }
        },

        getMyJoinRequest: async function(circleId, profileId) {
            try {
                const id = `${circleId}_${profileId}`;
                const doc = await firebase.firestore().collection('circle_join_requests').doc(id).get();
                return doc.exists ? { id: doc.id, ...doc.data() } : null;
            } catch (err) {
                console.error("Error getting join request:", err);
                return null;
            }
        },

        getJoinRequests: async function(circleId) {
            try {
                const snapshot = await firebase.firestore().collection('circle_join_requests')
                    .where('circle_id', '==', circleId)
                    .get();
                const pendingDocs = snapshot.docs.filter(doc => !doc.data().status || doc.data().status === 'pending');
                const requests = await Promise.all(pendingDocs.map(async (doc) => {
                    const data = doc.data();
                    const profile = await this.getProfile(data.profile_id);
                    return { id: doc.id, ...data, profile };
                }));
                return requests;
            } catch (err) {
                console.error("Error getting join requests:", err);
                return [];
            }
        },

        approveJoinRequest: async function(circleId, profileId) {
            try {
                // Add as member
                await this.joinCircle(circleId, profileId, 'member');
                // Delete the request
                const id = `${circleId}_${profileId}`;
                await firebase.firestore().collection('circle_join_requests').doc(id).delete();
            } catch (err) {
                console.error("Error approving join request:", err);
                throw err;
            }
        },

        denyJoinRequest: async function(circleId, profileId) {
            try {
                const id = `${circleId}_${profileId}`;
                await firebase.firestore().collection('circle_join_requests').doc(id).delete();
            } catch (err) {
                console.error("Error denying join request:", err);
                throw err;
            }
        },

        // --- Borrow Requests ---
        createBorrowRequest: async function(requestData) {
            try {
                const db = firebase.firestore();
                const itemRef = db.collection('items').doc(requestData.item_id);
                
                return await db.runTransaction(async (transaction) => {
                    const itemDoc = await transaction.get(itemRef);
                    if (!itemDoc.exists) {
                        throw new Error("Item does not exist.");
                    }
                    const itemData = itemDoc.data();
                    
                    // Enforce ownership: owner cannot borrow their own item
                    if (itemData.owner_id === requestData.borrower_id) {
                        throw new Error("You cannot borrow your own item.");
                    }

                    // Enforce availability: item cannot be lent if status is approved/borrowed/returned or is_available is false
                    if (itemData.is_available === false || ['approved', 'borrowed', 'returned'].includes(itemData.status)) {
                        throw new Error("This item is currently not available for borrowing.");
                    }

                    // Check for existing pending or approved request from this borrower
                    const existingRequestsSnap = await db.collection('requests')
                        .where('item_id', '==', requestData.item_id)
                        .where('borrower_id', '==', requestData.borrower_id)
                        .get();
                    
                    const hasActiveRequest = existingRequestsSnap.docs.some(doc => 
                        ['pending', 'approved'].includes(doc.data().status)
                    );
                    if (hasActiveRequest) {
                        throw new Error("You already have an active request for this item.");
                    }

                    // Create the request
                    const circleId = itemData.circle_id || null;
                    const circleIds = itemData.circle_ids || [];
                    
                    // lender_id is DERIVED from the item doc, never taken from the
                    // client. firestore.rules requires it to be present and to
                    // differ from the borrower, and getBorrowRequestsForUser /
                    // getRatingsSummary both query on it — so omitting it here
                    // denied every borrow write and starved lenders of
                    // reputation. Strip any client-supplied value first so a
                    // caller cannot spoof a different lender.
                    const { lender_id: _ignoredLenderId, ...safeRequestData } = requestData;

                    const requestType = requestData.type || (
                        (itemData.listing_type === 'giveaway' || itemData.intent === 'donate') ? 'giveaway' : 'borrow'
                    );

                    const newRequestRef = db.collection('requests').doc();
                    transaction.set(newRequestRef, {
                        ...safeRequestData,
                        lender_id: itemData.owner_id,
                        type: requestType,
                        circle_id: circleId,
                        circle_ids: circleIds,
                        status: 'pending',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // Append immutable transaction event (Issue #2 & #3)
                    const eventRef = db.collection('transaction_events').doc();
                    transaction.set(eventRef, {
                        request_id: newRequestRef.id,
                        item_id: requestData.item_id,
                        actor_id: requestData.borrower_id,
                        event_type: 'requested',
                        from_status: null,
                        to_status: 'pending',
                        metadata: { type: requestType, duration: requestData.duration || 'flexible' },
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    
                    return { id: newRequestRef.id };
                });
            } catch (err) {
                console.error("Error creating borrow request:", err);
                throw err;
            }
        },

        getBorrowRequestsForUser: async function(userId, view = 'borrowing') {
            try {
                let requests = [];
                if (view === 'borrowing') {
                    const snap = await firebase.firestore().collection('requests')
                        .where('borrower_id', '==', userId).get();
                    requests = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                } else {
                    const myItems = await this.getMyItems(userId);
                    const myItemIds = myItems.map(item => item.id);
                    if (myItemIds.length > 0) {
                        const chunks = [];
                        for (let i = 0; i < myItemIds.length; i += 10) {
                            chunks.push(myItemIds.slice(i, i + 10));
                        }
                        for (const chunk of chunks) {
                            const snap = await firebase.firestore().collection('requests')
                                .where('item_id', 'in', chunk)
                                .where('lender_id', '==', userId).get();
                            requests.push(...snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
                        }
                    }
                }

                // Populate related details
                await Promise.all(requests.map(async (req) => {
                    const itemDoc = await firebase.firestore().collection('items').doc(req.item_id).get();
                    if (itemDoc.exists) {
                        const itemData = { id: itemDoc.id, ...itemDoc.data() };
                        const ownerProfile = await this.getProfile(itemData.owner_id);
                        itemData.profiles = ownerProfile;
                        req.items = itemData;
                    } else {
                        req.items = { name: 'Unknown Item', image_url: 'https://placehold.co/200x200', profiles: null };
                    }
                    
                    const borrowerProfile = await this.getProfile(req.borrower_id);
                    req.profiles = borrowerProfile;
                }));

                // Sort descending
                requests.sort((a, b) => {
                    const dateA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                    const dateB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                    return dateB - dateA;
                });

                return requests;
            } catch (err) {
                console.error("Error getting borrow requests:", err);
                return [];
            }
        },

        // Confirm (approve) a borrow request.
        // For giveaway listings, the item is automatically deleted after approval.
        confirmBorrowRequest: async function(requestId, itemId, listingType) {
            try {
                const db = firebase.firestore();
                const requestRef = db.collection('requests').doc(requestId);
                const itemRef = db.collection('items').doc(itemId);

                await db.runTransaction(async (transaction) => {
                    const itemDoc = await transaction.get(itemRef);
                    if (!itemDoc.exists) {
                        throw new Error("Item does not exist.");
                    }
                    const itemData = itemDoc.data();
                    
                    // Check if item is already lent/promised (i.e., is_available is false, or status is approved/borrowed/returned)
                    if (itemData.is_available === false || ['approved', 'borrowed', 'returned'].includes(itemData.status)) {
                        throw new Error("This item is already lent or promised to another user.");
                    }

                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) {
                        throw new Error("Request does not exist.");
                    }
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'pending') {
                        throw new Error("This request is no longer pending.");
                    }

                    // Update request status to approved
                    transaction.update(requestRef, {
                        status: 'approved',
                        confirmed_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // Update item status to approved (reserved) and is_available to false
                    //
                    // FIX: firestore.rules can only authorise a borrower's
                    // later item writes (markPickedUp / markReturned) by
                    // reading a single document — rules have no query
                    // primitive. The owner writes the active request id here,
                    // at the moment the approval is legitimately theirs to
                    // grant, and it is cleared again when the request ends.
                    transaction.update(itemRef, {
                        status: 'approved',
                        is_available: false,
                        active_request_id: requestId
                    });

                    const eventRef = db.collection('transaction_events').doc();
                    transaction.set(eventRef, {
                        request_id: requestId,
                        item_id: itemId,
                        actor_id: itemData.owner_id,
                        event_type: 'approved',
                        from_status: 'pending',
                        to_status: 'approved',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });
            } catch (err) {
                console.error("Error confirming borrow request:", err);
                throw err;
            }
        },

        declineBorrowRequest: async function(requestId) {
            try {
                const db = firebase.firestore();
                const requestRef = db.collection('requests').doc(requestId);
                
                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'pending') {
                        throw new Error("Only pending requests can be declined.");
                    }
                    
                    transaction.update(requestRef, {
                        status: 'declined',
                        declined_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    const eventRef = db.collection('transaction_events').doc();
                    transaction.set(eventRef, {
                        request_id: requestId,
                        item_id: requestData.item_id,
                        actor_id: requestData.lender_id,
                        event_type: 'declined',
                        from_status: 'pending',
                        to_status: 'declined',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });
            } catch (err) {
                console.error("Error declining borrow request:", err);
                throw err;
            }
        },

        // --- Messaging ---
        getInboxMessages: async function(userId) {
            try {
                // Fetch sent and received messages
                const query1 = firebase.firestore().collection('messages')
                    .where('sender_id', '==', userId).get();
                const query2 = firebase.firestore().collection('messages')
                    .where('receiver_id', '==', userId).get();
                
                const [snap1, snap2] = await Promise.all([query1, query2]);
                const list1 = snap1.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                const list2 = snap2.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
                const combinedMap = {};
                list1.forEach(m => combinedMap[m.id] = m);
                list2.forEach(m => combinedMap[m.id] = m);
                const messages = Object.values(combinedMap);

                // Populate sender and receiver profiles in parallel using a cache to avoid duplicate fetches
                const profileCache = {};
                const fetchProfileWithCache = async (pId) => {
                    if (!pId) return null;
                    if (profileCache[pId]) return profileCache[pId];
                    if (!profileCache[pId]) {
                        profileCache[pId] = this.getProfile(pId);
                    }
                    return profileCache[pId];
                };

                await Promise.all(messages.map(async (msg) => {
                    const [senderProfile, receiverProfile] = await Promise.all([
                        fetchProfileWithCache(msg.sender_id),
                        fetchProfileWithCache(msg.receiver_id)
                    ]);
                    msg.sender = senderProfile;
                    msg.receiver = receiverProfile;
                }));

                // Sort descending
                messages.sort((a, b) => {
                    const dateA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                    const dateB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                    return dateB - dateA;
                });

                return messages;
            } catch (err) {
                console.error("Error getting inbox messages:", err);
                return [];
            }
        },

        sendMessage: async function(senderId, receiverId, itemId, content) {
            try {
                let circleId = null;
                let circleIds = [];
                if (itemId) {
                    const itemDoc = await firebase.firestore().collection('items').doc(itemId).get();
                    if (itemDoc.exists) {
                        const itemData = itemDoc.data();
                        circleId = itemData.circle_id || null;
                        circleIds = itemData.circle_ids || [];
                    }
                }
                const ref = await firebase.firestore().collection('messages').add({
                    sender_id: senderId,
                    receiver_id: receiverId,
                    item_id: itemId || null,
                    circle_id: circleId,
                    circle_ids: circleIds,
                    content: content,
                    is_read: false,
                    participants: [senderId, receiverId],
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                });
                const doc = await ref.get();
                return { id: ref.id, ...doc.data() };
            } catch (err) {
                console.error("Error sending message:", err);
                throw err;
            }
        },

        subscribeToChatMessages: function(currentUserId, targetUserId, callback) {
            const db = firebase.firestore();
            const seenIds = new Set();

            const handleSnapshot = (snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        if (seenIds.has(change.doc.id)) return;
                        seenIds.add(change.doc.id);
                        const data = { id: change.doc.id, ...change.doc.data() };
                        if (data.created_at && data.created_at.toDate) {
                            data.created_at = data.created_at.toDate().toISOString();
                        }
                        callback(data);
                    }
                });
            };

            const handleError = (error) => {
                console.error("Realtime listener error:", error);
            };

            // Query 1: messages sent by currentUser to targetUser
            const unsub1 = db.collection('messages')
                .where('sender_id', '==', currentUserId)
                .where('receiver_id', '==', targetUserId)
                .onSnapshot(handleSnapshot, handleError);

            // Query 2: messages sent by targetUser to currentUser
            const unsub2 = db.collection('messages')
                .where('sender_id', '==', targetUserId)
                .where('receiver_id', '==', currentUserId)
                .onSnapshot(handleSnapshot, handleError);

            // Return a combined unsubscribe function
            return () => { unsub1(); unsub2(); };
        },

        getCirclePosts: async function(circleId) {
            try {
                const snapshot = await firebase.firestore().collection('circle_posts')
                    .where('circle_id', '==', circleId).get();
                const posts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
                // Fetch profiles in parallel
                await Promise.all(posts.map(async (post) => {
                    const profile = await this.getProfile(post.profile_id);
                    post.profiles = profile;
                }));
                
                // Sort by created_at descending
                posts.sort((a, b) => {
                    const dateA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                    const dateB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                    return dateB - dateA;
                });
                return posts;
            } catch (err) {
                console.error("Error getting circle posts:", err);
                return [];
            }
        },

        createCirclePost: async function(circleId, profileId, content) {
            try {
                const ref = await firebase.firestore().collection('circle_posts').add({
                    circle_id: circleId,
                    profile_id: profileId,
                    content: content,
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                });
                return { id: ref.id };
            } catch (err) {
                console.error("Error creating circle post:", err);
                throw err;
            }
        },

        markPickedUp: async function(requestId, itemId) {
            try {
                const db = firebase.firestore();
                const requestRef = db.collection('requests').doc(requestId);
                const itemRef = db.collection('items').doc(itemId);

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'approved') {
                        throw new Error("Request must be approved before pickup.");
                    }

                    const itemDoc = await transaction.get(itemRef);
                    if (!itemDoc.exists) throw new Error("Item not found");

                    // Update request status to borrowed
                    transaction.update(requestRef, {
                        status: 'borrowed',
                        picked_up_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // Update item status to borrowed and is_available to false
                    transaction.update(itemRef, {
                        status: 'borrowed',
                        is_available: false
                    });

                    const eventRef = db.collection('transaction_events').doc();
                    transaction.set(eventRef, {
                        request_id: requestId,
                        item_id: itemId,
                        actor_id: requestData.borrower_id,
                        event_type: 'picked_up',
                        from_status: 'approved',
                        to_status: 'borrowed',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });
            } catch (err) {
                console.error("Error marking as picked up:", err);
                throw err;
            }
        },

        markReturned: async function(requestId) {
            try {
                const db = firebase.firestore();
                const requestRef = db.collection('requests').doc(requestId);

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'borrowed') {
                        throw new Error("Only borrowed items can be marked as returned.");
                    }

                    const itemRef = db.collection('items').doc(requestData.item_id);
                    const itemDoc = await transaction.get(itemRef);

                    // Update request status to returned
                    transaction.update(requestRef, {
                        status: 'returned',
                        returned_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // Update item status to returned (if it exists)
                    if (itemDoc.exists) {
                        transaction.update(itemRef, {
                            status: 'returned'
                        });
                    }

                    const eventRef = db.collection('transaction_events').doc();
                    transaction.set(eventRef, {
                        request_id: requestId,
                        item_id: requestData.item_id,
                        actor_id: requestData.borrower_id,
                        event_type: 'returned',
                        from_status: 'borrowed',
                        to_status: 'returned',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });
            } catch (err) {
                console.error("Error marking as returned:", err);
                throw err;
            }
        },

        confirmReturn: async function(requestId) {
            try {
                const db = firebase.firestore();
                const user = firebase.auth().currentUser;
                if (!user) throw new Error("You must be signed in to confirm a return.");
                const requestRef = db.collection('requests').doc(requestId);

                let ledgerWrites = [];
                let beneficiaries = [];

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'returned') {
                        throw new Error("Return must be marked by borrower before confirmation.");
                    }

                    // Set request completed
                    transaction.update(requestRef, {
                        status: 'completed',
                        completed_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // Fetch item to know the owner (lender)
                    const itemRef = db.collection('items').doc(requestData.item_id);
                    const itemDoc = await transaction.get(itemRef);
                    if (itemDoc.exists) {
                        const itemData = itemDoc.data();
                        const lenderId = itemData.owner_id;
                        const borrowerId = requestData.borrower_id;
                        delete this.profilesCache[lenderId];
                        delete this.profilesCache[borrowerId];

                        // Mark item as available again (or completed if giveaway).
                        // active_request_id is cleared: the request is terminal,
                        // so firestore.rules must stop granting the participants
                        // write access to this item.
                        if (itemData.listing_type === 'giveaway' || itemData.intent === 'donate') {
                            transaction.update(itemRef, {
                                status: 'completed',
                                is_available: false,
                                active_request_id: null
                            });
                        } else {
                            transaction.update(itemRef, {
                                status: 'available',
                                is_available: true,
                                active_request_id: null
                            });
                        }

                        // FIX VULN-14: carbon_saved_kg is server-owned
                        // (firestore.rules blocks cross-profile writes), so the
                        // old approach of crediting BOTH profiles here was denied
                        // in production and failed the whole confirmation.
                        // Record an append-only ledger row per participant
                        // instead; the aggregate is derived from these rows.
                        const isDonation = itemData.listing_type === 'giveaway' || itemData.intent === 'donate';
                        const creditKg = isDonation ? 2 : 2;
                        beneficiaries = [
                            { id: lenderId, role: 'lender' },
                            { id: borrowerId, role: 'borrower' }
                        ];
                        ledgerWrites = beneficiaries.map(b => ({
                            ref: db.collection('impact_events').doc(),
                            data: {
                                actor_id: user.uid,
                                beneficiary_id: b.id,
                                role: b.role,
                                credit_kg: creditKg,
                                request_id: requestId,
                                item_id: requestData.item_id,
                                kind: isDonation ? 'donation' : 'loan',
                                created_at: firebase.firestore.FieldValue.serverTimestamp()
                            }
                        }));
                    }
                });

                // Ledger writes are outside the transaction so a credit-write
                // failure can never roll back a confirmed return.
                await Promise.all(ledgerWrites.map(w => w.ref.set(w.data)));

                return { credited: beneficiaries.length };
            } catch (err) {
                console.error("Error confirming return:", err);
                throw err;
            }
        },

        
        completeGiveaway: async function(requestId) {
            try {
                const db = firebase.firestore();
                const user = firebase.auth().currentUser;
                if (!user) throw new Error("You must be signed in to complete a giveaway.");
                const requestRef = db.collection('requests').doc(requestId);

                let ledgerWrites = [];
                let beneficiaries = [];

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'approved' && requestData.status !== 'borrowed') {
                        throw new Error("Giveaway must be approved before completion.");
                    }

                    transaction.update(requestRef, {
                        status: 'completed',
                        completed_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    const itemRef = db.collection('items').doc(requestData.item_id);
                    const itemDoc = await transaction.get(itemRef);
                    if (itemDoc.exists) {
                        const itemData = itemDoc.data();
                        const lenderId = itemData.owner_id;
                        const borrowerId = requestData.borrower_id;
                        delete this.profilesCache[lenderId];
                        delete this.profilesCache[borrowerId];

                        transaction.update(itemRef, {
                            status: 'transferred',
                            is_available: false,
                            active_request_id: null
                        });

                        beneficiaries = [
                            { id: lenderId, role: 'lender' },
                            { id: borrowerId, role: 'borrower' }
                        ];
                        ledgerWrites = beneficiaries.map(b => ({
                            ref: db.collection('impact_events').doc(),
                            data: {
                                actor_id: user.uid,
                                beneficiary_id: b.id,
                                role: b.role,
                                credit_kg: 2,
                                request_id: requestId,
                                item_id: requestData.item_id,
                                kind: 'donation',
                                created_at: firebase.firestore.FieldValue.serverTimestamp()
                            }
                        }));
                    }

                    const eventRef = db.collection('transaction_events').doc();
                    transaction.set(eventRef, {
                        request_id: requestId,
                        item_id: requestData.item_id,
                        actor_id: user.uid,
                        event_type: 'giveaway_completed',
                        from_status: requestData.status,
                        to_status: 'completed',
                        metadata: { type: 'giveaway' },
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });

                await Promise.all(ledgerWrites.map(w => w.ref.set(w.data)));
                return { credited: beneficiaries.length };
            } catch (err) {
                console.error("Error completing giveaway:", err);
                throw err;
            }
        },

        undoConfirmBorrowRequest: async function(requestId) {
            try {
                const db = firebase.firestore();
                const requestRef = db.collection('requests').doc(requestId);
                
                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'approved') {
                        throw new Error("Request is not in approved state.");
                    }
                    
                    const itemRef = db.collection('items').doc(requestData.item_id);
                    
                    // Revert request status to pending
                    transaction.update(requestRef, {
                        status: 'pending',
                        confirmed_at: null
                    });
                    
                    // Revert item status to available and drop the active
                    // request link, so the borrower can no longer write it.
                    transaction.update(itemRef, {
                        status: 'available',
                        is_available: true,
                        active_request_id: null
                    });
                });
            } catch (err) {
                console.error("Error undoing confirm borrow request:", err);
                throw err;
            }
        },

        undoMarkPickedUp: async function(requestId, itemId) {
            try {
                const db = firebase.firestore();
                const requestRef = db.collection('requests').doc(requestId);
                const itemRef = db.collection('items').doc(itemId);
                
                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'borrowed') {
                        throw new Error("Request is not in borrowed state.");
                    }
                    
                    // Revert request status to approved
                    transaction.update(requestRef, {
                        status: 'approved',
                        picked_up_at: null
                    });
                    
                    // Revert item status to approved
                    transaction.update(itemRef, {
                        status: 'approved',
                        is_available: false
                    });
                });
            } catch (err) {
                console.error("Error undoing mark picked up:", err);
                throw err;
            }
        },

        undoMarkReturned: async function(requestId) {
            try {
                const db = firebase.firestore();
                const requestRef = db.collection('requests').doc(requestId);
                
                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'returned') {
                        throw new Error("Request is not in returned state.");
                    }
                    
                    const itemRef = db.collection('items').doc(requestData.item_id);
                    
                    // Revert request status to borrowed
                    transaction.update(requestRef, {
                        status: 'borrowed',
                        returned_at: null
                    });
                    
                    // Revert item status to borrowed
                    transaction.update(itemRef, {
                        status: 'borrowed',
                        is_available: false
                    });
                });
            } catch (err) {
                console.error("Error undoing mark returned:", err);
                throw err;
            }
        },

        undoConfirmReturn: async function(requestId) {
            try {
                const db = firebase.firestore();
                const user = firebase.auth().currentUser;
                if (!user) throw new Error("You must be signed in to undo a confirmation.");
                const requestRef = db.collection('requests').doc(requestId);
                let impactRefs = [];

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'completed') {
                        throw new Error("Request is not in completed state.");
                    }
                    
                    const itemRef = db.collection('items').doc(requestData.item_id);
                    const itemDoc = await transaction.get(itemRef);
                    if (!itemDoc.exists) throw new Error("Item not found");
                    const itemData = itemDoc.data();
                    const isGiveaway = itemData.listing_type === 'giveaway' || itemData.intent === 'donate';
                    
                    // Revert request status to returned (or approved if giveaway)
                    const targetStatus = isGiveaway ? 'approved' : 'returned';
                    transaction.update(requestRef, {
                        status: targetStatus,
                        completed_at: null
                    });
                    
                    // Revert item status to returned (or approved if giveaway)
                    // and make unavailable. The request is live again, so the
                    // active_request_id link is restored.
                    transaction.update(itemRef, {
                        status: targetStatus,
                        is_available: false,
                        active_request_id: requestId
                    });

                    // VULN-14: the impact ledger is append-only and immutable
                    // (firestore.rules: allow update, delete: if false), so the
                    // credit is reversed by appending compensating rows that
                    // cancel it, rather than by mutating history.
                    const ledgerSnap = await transaction.get(
                        db.collection('impact_events').where('request_id', '==', requestId)
                    );
                    impactRefs = ledgerSnap.docs
                        .filter(d => {
                            const v = d.data().credit_kg;
                            return typeof v === 'number' && v > 0;
                        })
                        .map(d => ({
                            ref: d.ref,
                            amount: d.data().credit_kg,
                            beneficiaryId: d.data().beneficiary_id
                        }));
                });

                await Promise.all(impactRefs.map(({ ref, amount, beneficiaryId }) =>
                    db.collection('impact_events').doc().set({
                        actor_id: user.uid,
                        // Carry the ORIGINAL beneficiary so the credit sums back
                        // to zero for that person. A reversal row is a normal
                        // negative entry, not a write against history.
                        beneficiary_id: beneficiaryId || 'none',
                        role: 'reversal',
                        credit_kg: -amount,
                        reverses_event_id: ref.id,
                        request_id: requestId,
                        kind: 'reversal',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    })
                ));
            } catch (err) {
                console.error("Error undoing confirm return:", err);
                throw err;
            }
        },

        getActiveRequest: async function(itemId, userId1, userId2) {
            try {
                const db = firebase.firestore();
                const user = firebase.auth().currentUser;
                if (!user) return null;
                const currentUid = user.uid;

                // Query where the logged-in user is the borrower
                const q1 = db.collection('requests')
                    .where('item_id', '==', itemId)
                    .where('borrower_id', '==', currentUid)
                    .get();
                // Query where the logged-in user is the lender
                const q2 = db.collection('requests')
                    .where('item_id', '==', itemId)
                    .where('lender_id', '==', currentUid)
                    .get();
                
                const [snap1, snap2] = await Promise.all([q1, q2]);
                const docs = [...snap1.docs, ...snap2.docs];
                
                for (const doc of docs) {
                    const req = doc.data();
                    const bId = req.borrower_id;
                    const lId = req.lender_id;
                    const isMatch = (bId === userId1 && lId === userId2) ||
                                    (bId === userId2 && lId === userId1);
                    if (isMatch) {
                        return { id: doc.id, ...req };
                    }
                }
                return null;
            } catch (err) {
                console.error("Error getting active request:", err);
                return null;
            }
        },

        getUnreadCount: async function(userId) {
            try {
                const snap = await firebase.firestore().collection('messages')
                    .where('receiver_id', '==', userId)
                    .where('is_read', '==', false)
                    .get();
                return snap.size;
            } catch (err) {
                console.error("Error getting unread count:", err);
                return 0;
            }
        },

        markMessagesAsRead: async function(currentUserId, targetUserId) {
            try {
                const snap = await firebase.firestore().collection('messages')
                    .where('sender_id', '==', targetUserId)
                    .where('receiver_id', '==', currentUserId)
                    .where('is_read', '==', false)
                    .get();
                
                const batch = firebase.firestore().batch();
                snap.docs.forEach(doc => {
                    batch.update(doc.ref, { is_read: true });
                });
                await batch.commit();
            } catch (err) {
                console.error("Error marking messages as read:", err);
            }
        },

        // Derive a user's total impact credit from the append-only ledger.
        // carbon_saved_kg on the profile is server-owned and not client-writable
        // (firestore.rules), so the ledger is the source of truth for the UI.
        getImpactSummary: async function(profileId) {
            try {
                if (!profileId) return { credit_kg: 0, donations: 0, loans: 0, reversals: 0 };
                const snap = await firebase.firestore().collection('impact_events')
                    .where('beneficiary_id', '==', profileId)
                    .get();
                const rows = snap.docs.map(d => d.data());
                let credit_kg = 0, donations = 0, loans = 0, reversals = 0;
                rows.forEach(r => {
                    const v = Number(r.credit_kg) || 0;
                    credit_kg += v;
                    if (r.kind === 'donation' && v > 0) donations += 1;
                    else if (r.kind === 'loan' && v > 0) loans += 1;
                    else if (r.kind === 'reversal') reversals += 1;
                });
                return {
                    credit_kg: Math.max(0, Math.round(credit_kg * 10) / 10),
                    donations,
                    loans,
                    reversals
                };
            } catch (err) {
                console.error("Error getting impact summary:", err);
                return { credit_kg: 0, donations: 0, loans: 0, reversals: 0 };
            }
        },

        /**
         * Batched reputation lookup for display.
         *
         * getRatingsSummary() is deliberately scoped to the viewer's own
         * requests, because reading the whole `ratings` collection leaked
         * every rating and rater profile in the app to any signed-in user.
         * That scope means a page showing several counterparties needs each
         * one's score independently.
         *
         * Fetching one query per person does not scale, so this batches with
         * `ratee_id in [...]` (Firestore caps `in` at 30 values), turning N
         * reads into ceil(N/30). Supported by the
         * ratings(ratee_id ASC, created_at DESC) index.
         *
         * @param {string[]} userIds
         * @returns {Promise<Object<string, {average:number,count:number}>>}
         */
        getReputations: async function(userIds) {
            const result = {};
            const unique = [...new Set((userIds || []).filter(Boolean))];
            if (!unique.length) return result;

            if (!this._reputationCache) this._reputationCache = {};
            const pending = unique.filter(id => !this._reputationCache[id]);
            unique.forEach(id => {
                if (this._reputationCache[id]) result[id] = this._reputationCache[id];
            });

            const CHUNK = 30;
            for (let i = 0; i < pending.length; i += CHUNK) {
                const chunk = pending.slice(i, i + CHUNK);
                try {
                    const snap = await firebase.firestore().collection('ratings')
                        .where('ratee_id', 'in', chunk)
                        .limit(Math.min(1000, chunk.length * 50))
                        .get();
                    const byRatee = {};
                    snap.docs.forEach(d => {
                        const { ratee_id: rateeId, score } = d.data();
                        if (!rateeId) return;
                        const s = Number(score);
                        if (!Number.isFinite(s)) return;
                        if (!byRatee[rateeId]) byRatee[rateeId] = { total: 0, count: 0 };
                        byRatee[rateeId].total += s;
                        byRatee[rateeId].count += 1;
                    });
                    chunk.forEach(id => {
                        const agg = byRatee[id];
                        const entry = agg && agg.count > 0
                            ? { average: Number((agg.total / agg.count).toFixed(1)), count: agg.count }
                            : { average: 5.0, count: 0 };
                        this._reputationCache[id] = entry;
                        result[id] = entry;
                    });
                } catch (err) {
                    console.error("Error getting batched reputations:", err);
                    chunk.forEach(id => {
                        const entry = { average: 5.0, count: 0 };
                        this._reputationCache[id] = entry;
                        result[id] = entry;
                    });
                }
            }
            return result;
        },

        // Keyed by uid. A single shared cache leaked one signed-in user's ratings
        // summary to the next user on the same device, and the scope is
        // viewer-specific, so it can never be shared across identities.
        _ratingsSummaryCache: {},

        getRatingsSummary: async function() {
            const user = firebase.auth().currentUser;
            const cacheKey = user ? user.uid : '__anon__';
            if (this._ratingsSummaryCache[cacheKey]) {
                return this._ratingsSummaryCache[cacheKey];
            }
            try {
                let requestsDocs = [];
                
                if (user) {
                    const db = firebase.firestore();
                    const [borrowerSnap, lenderSnap] = await Promise.all([
                        db.collection('requests').where('borrower_id', '==', user.uid).get(),
                        db.collection('requests').where('lender_id', '==', user.uid).get()
                    ]);
                    requestsDocs = [...borrowerSnap.docs, ...lenderSnap.docs];
                }

                // Ratings are only meaningful for requests the viewer participates in, so
                // scope to those rather than scanning the entire `ratings`
                // collection. A rating whose request is not visible to this
                // viewer is dropped anyway, so the visible result is unchanged.
                let ratingsDocs = [];
                if (user) {
                    const viewerRequestIds = new Set(requestsDocs.map(d => d.id));
                    if (viewerRequestIds.size) {
                        const chunkSize = 30; // Firestore 'in' supports max 30
                        const ids = [...viewerRequestIds];
                        const chunks = [];
                        for (let i = 0; i < ids.length; i += chunkSize) {
                            chunks.push(ids.slice(i, i + chunkSize));
                        }
                        const snaps = await Promise.all(chunks.map(chunk =>
                            firebase.firestore().collection('ratings')
                                .where('request_id', 'in', chunk)
                                .limit(Math.min(1000, chunk.length * 4))
                                .get()
                        ));
                        ratingsDocs = snaps.flatMap(s => s.docs);
                    }
                }
                
                const requestsMap = {};
                requestsDocs.forEach(doc => {
                    requestsMap[doc.id] = { id: doc.id, ...doc.data() };
                });
                
                const listingRatings = {}; // itemId -> { total: 0, count: 0, average: 0.0, reviews: [] }
                const userRatings = {}; // userId -> { total: 0, count: 0, average: 0.0, reviews: [] }
                
                const profilesCache = {};
                const getProfileLocal = async (profileId) => {
                    if (profilesCache[profileId]) return profilesCache[profileId];
                    const p = await this.getProfile(profileId);
                    profilesCache[profileId] = p;
                    return p;
                };

                const ratings = [];
                for (const doc of ratingsDocs) {
                    const rating = { id: doc.id, ...doc.data() };
                    ratings.push(rating);
                }

                // Populate rater profiles for these ratings
                await Promise.all(ratings.map(async (r) => {
                    if (r.rater_id) {
                        r.rater_profile = await getProfileLocal(r.rater_id);
                    }
                }));

                ratings.forEach(rating => {
                    const score = Number(rating.score);
                    const rateeId = rating.ratee_id;
                    const raterId = rating.rater_id;
                    const reqId = rating.request_id;
                    const request = requestsMap[reqId];
                    
                    // User rating
                    if (rateeId) {
                        if (!userRatings[rateeId]) {
                            userRatings[rateeId] = { total: 0, count: 0, average: 0, reviews: [] };
                        }
                        userRatings[rateeId].total += score;
                        userRatings[rateeId].count += 1;
                        userRatings[rateeId].reviews.push(rating);
                    }
                    
                    // Listing rating
                    if (request && request.item_id) {
                        const itemId = request.item_id;
                        if (raterId === request.borrower_id) {
                            if (!listingRatings[itemId]) {
                                listingRatings[itemId] = { total: 0, count: 0, average: 0, reviews: [] };
                            }
                            listingRatings[itemId].total += score;
                            listingRatings[itemId].count += 1;
                            listingRatings[itemId].reviews.push(rating);
                        }
                    }
                });
                
                // Compute averages
                for (const itemId in listingRatings) {
                    const lr = listingRatings[itemId];
                    lr.average = lr.count > 0 ? Number((lr.total / lr.count).toFixed(1)) : 0;
                    lr.reviews.sort((a, b) => {
                        const dateA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                        const dateB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                        return dateB - dateA;
                    });
                }
                for (const userId in userRatings) {
                    const ur = userRatings[userId];
                    ur.average = ur.count > 0 ? Number((ur.total / ur.count).toFixed(1)) : 0;
                    ur.reviews.sort((a, b) => {
                        const dateA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                        const dateB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                        return dateB - dateA;
                    });
                }
                
                const summary = { listingRatings, userRatings, requestsMap };
                this._ratingsSummaryCache[cacheKey] = summary;
                return summary;
            } catch (err) {
                console.error("Error getting ratings summary:", err);
                return { listingRatings: {}, userRatings: {}, requestsMap: {} };
            }
        },

        // Derive a user's reputation from their ratings.
        //
        // profiles.reputation_score is server-owned: firestore.rules:30 blocks
        // the client from writing it. createRating used to attempt that write
        // and swallow the PERMISSION_DENIED, so reputation NEVER actually
        // updated in production. The aggregate is computed from `ratings`
        // instead, which is the record of truth.
        getReputation: async function(userId) {
            if (!userId) return { average: 5.0, count: 0 };
            if (this._reputationCache && this._reputationCache[userId]) {
                return this._reputationCache[userId];
            }
            if (!this._reputationCache) this._reputationCache = {};
            try {
                const snap = await firebase.firestore().collection('ratings')
                    .where('ratee_id', '==', userId).get();
                const scores = snap.docs
                    .map(d => Number(d.data().score))
                    .filter(s => Number.isFinite(s));
                const result = scores.length > 0
                    ? { average: Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)), count: scores.length }
                    : { average: 5.0, count: 0 };
                this._reputationCache[userId] = result;
                return result;
            } catch (err) {
                console.error("Error getting reputation:", err);
                return { average: 5.0, count: 0 };
            }
        },

        createRating: async function(ratingData) {
            // A new rating changes every viewer's summary, and the cache is
            // per-viewer, so drop all of it rather than guessing who is looking.
            this._ratingsSummaryCache = {};
            if (!this._reputationCache) this._reputationCache = {};
            if (ratingData.ratee_id) {
                delete this.profilesCache[ratingData.ratee_id];
                delete this._reputationCache[ratingData.ratee_id];
            }
            try {
                // VULN-15: reputation_score on the profile is not client-writable
                // (firestore.rules:30), so writing it here was always denied.
                // The rating row is the record; getReputation() derives the score.
                const ref = await firebase.firestore().collection('ratings').add({
                    ...ratingData,
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                });

                return { id: ref.id };
            } catch (err) {
                console.error("Error creating rating:", err);
                throw err;
            }
        },

        getUserRatings: async function(userId) {
            try {
                const snap = await firebase.firestore().collection('ratings')
                    .where('ratee_id', '==', userId)
                    .get();
                const ratings = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
                // Populate rater profiles
                await Promise.all(ratings.map(async (r) => {
                    r.rater_profile = await this.getProfile(r.rater_id);
                }));
                
                // Sort descending by created_at
                ratings.sort((a, b) => {
                    const dateA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                    const dateB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                    return dateB - dateA;
                });
                
                return ratings;
            } catch (err) {
                console.error("Error getting user ratings:", err);
                return [];
            }
        },

        checkIfRated: async function(requestId, raterId) {
            try {
                const snap = await firebase.firestore().collection('ratings')
                    .where('request_id', '==', requestId)
                    .where('rater_id', '==', raterId)
                    .get();
                return !snap.empty;
            } catch (err) {
                console.error("Error checking rating status:", err);
                return false;
            }
        },

        checkExistingRequest: async function(itemId, borrowerId) {
            try {
                const snap1 = await firebase.firestore().collection('requests')
                    .where('item_id', '==', itemId)
                    .where('borrower_id', '==', borrowerId)
                    .where('status', '==', 'pending')
                    .get();
                if (!snap1.empty) return true;

                const snap2 = await firebase.firestore().collection('requests')
                    .where('item_id', '==', itemId)
                    .where('borrower_id', '==', borrowerId)
                    .where('status', '==', 'approved')
                    .get();
                if (!snap2.empty) return true;

                return false;
            } catch (err) {
                console.error("Error checking existing requests:", err);
                return false;
            }
        }
    };

    // --- Global UI Helpers: Scroll-to-Hide Navigation ---
    let lastScrollY = window.scrollY;
    const scrollThreshold = 10;

    window.addEventListener('scroll', () => {
        const currentScrollY = window.scrollY;
        const header = document.querySelector('header');
        const bottomNav = document.querySelector('nav.fixed.bottom-0');
        
        if (!header || !bottomNav) return;

        // Scrolling Down -> Hide bars
        if (currentScrollY > lastScrollY + scrollThreshold && currentScrollY > 100) {
            header.classList.add('nav-hidden-top');
            bottomNav.classList.add('nav-hidden-bottom');
        } 
        // Scrolling Up -> Show both bars
        else if (currentScrollY < lastScrollY - scrollThreshold || currentScrollY <= 0) {
            header.classList.remove('nav-hidden-top');
            bottomNav.classList.remove('nav-hidden-bottom');
        }

        lastScrollY = currentScrollY;
    }, { passive: true });
}
