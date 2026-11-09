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
    function safeSessionStorage() {
        if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
        if (typeof sessionStorage !== 'undefined') return sessionStorage;
        return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    }
    window.loginWithGoogle = async function(redirectTo = 'explore.html') {
        safeSessionStorage().setItem(REDIRECT_LOGIN_FLAG, '1');
        safeSessionStorage().setItem(REDIRECT_TARGET_KEY, redirectTo || 'explore.html');
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
            await firebase.auth().signInWithRedirect(provider);
        } catch (error) {
            safeSessionStorage().removeItem(REDIRECT_LOGIN_FLAG);
            safeSessionStorage().removeItem(REDIRECT_TARGET_KEY);
            console.error('Login error:', error);
            alert('Login failed: ' + error.message);
        }
    };

    // Complete a Google redirect sign-in on the way back from accounts.google.com
    firebase.auth().getRedirectResult().then(async (result) => {
        // Always clear the flag — whether the redirect succeeded, was cancelled, or there was no pending redirect
        const target = safeSessionStorage().getItem(REDIRECT_TARGET_KEY) || 'explore.html';
        safeSessionStorage().removeItem(REDIRECT_LOGIN_FLAG);
        safeSessionStorage().removeItem(REDIRECT_TARGET_KEY);
        if (!result || !result.user) return;
        const user = result.user;
        await ensureProfile(user);
        window.location.href = safeRedirect(target);
    }).catch((error) => {
        safeSessionStorage().removeItem(REDIRECT_LOGIN_FLAG);
        safeSessionStorage().removeItem(REDIRECT_TARGET_KEY);
        console.error('Redirect login error:', error);
        alert('Login failed: ' + error.message);
    });

    // Helper function to handle Email/Password Login
    // Allowed post-auth redirect targets (VULN-19: open redirect prevention)
    const ALLOWED_REDIRECTS = new Set([
        'explore.html', 'index.html', 'circles.html', 'profile.html',
        'messages.html', 'activity.html', 'edit-profile.html', 'add-item.html',
        'circle-detail.html', 'item-details.html', 'book-detail.html'
    ]);
    function safeRedirect(redirectTo, fallback = 'explore.html') {
        if (!redirectTo || typeof redirectTo !== 'string') return fallback;
        const trimmed = redirectTo.trim();
        // Reject protocol-relative or absolute URLs or javascript: URIs (open redirect defence)
        if (trimmed.startsWith('//') || trimmed.includes('://') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
            return fallback;
        }
        // Strip leading slash if any
        const clean = trimmed.replace(/^\/+/, '');
        const [pagePart, queryPart] = clean.split('?');
        const basePage = pagePart.split('#')[0];
        if (!ALLOWED_REDIRECTS.has(basePage)) return fallback;

        // Preserve safe query string parameters (e.g. circle-detail.html?id=...)
        if (queryPart) {
            const rawQuery = queryPart.split('#')[0];
            const params = new URLSearchParams(rawQuery);
            const id = params.get('id');
            const circleId = params.get('circleId');
            const safeIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

            if (basePage === 'circle-detail.html') {
                if (id && safeIdPattern.test(id)) {
                    return `circle-detail.html?id=${encodeURIComponent(id)}`;
                }
                return 'circle-detail.html';
            }

            if (id && safeIdPattern.test(id)) {
                return `${basePage}?id=${encodeURIComponent(id)}`;
            }
            if (circleId && safeIdPattern.test(circleId)) {
                return `${basePage}?circleId=${encodeURIComponent(circleId)}`;
            }
        }

        return basePage;
    }
    window.safeRedirect = safeRedirect;

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
    window.requireAuth = async function(redirectUrl = null) {
        return new Promise((resolve) => {
            const unsubscribe = firebase.auth().onAuthStateChanged((user) => {
                unsubscribe();
                if (!user) {
                    console.warn('Unauthorized access. Redirecting to login.');
                    if (redirectUrl) {
                        window.location.href = redirectUrl;
                    } else {
                        let currentTarget = '';
                        if (typeof window !== 'undefined' && window.location) {
                            const page = window.location.pathname.split('/').pop() || 'explore.html';
                            const search = window.location.search || '';
                            currentTarget = page + search;
                        }
                        if (currentTarget && currentTarget !== 'join-community.html') {
                            window.location.href = `join-community.html?redirect=${encodeURIComponent(currentTarget)}`;
                        } else {
                            window.location.href = 'join-community.html';
                        }
                    }
                    resolve(null);
                } else {
                    user.id = user.uid; // Add compatibility mapping
                    resolve({ user: user });
                }
            });
        });
    };

    // Helper to generate canonical share URLs and handle Web Share API / clipboard
    window.getCircleShareUrl = function(circleId) {
        if (!circleId) return '';
        const origin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
        return `${origin}/circle-detail.html?id=${encodeURIComponent(circleId)}`;
    };

    window.shareCircle = async function({ circleId, name, description } = {}) {
        const url = window.getCircleShareUrl(circleId);
        const title = name ? `${name} - Share, Instead.` : 'Join my circle on Share, Instead.';
        const text = description || (name ? `Check out the ${name} community circle on Share, Instead.` : 'Join our neighborhood sharing circle.');
        if (typeof navigator !== 'undefined' && navigator.share) {
            try {
                await navigator.share({ title, text, url });
                return { shared: true, method: 'navigator.share', url };
            } catch (err) {
                if (err.name === 'AbortError') {
                    return { shared: false, method: 'aborted', url };
                }
            }
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(url);
            return { shared: true, method: 'clipboard', url };
        }
        return { shared: false, method: 'unsupported', url };
    };

    // Listen to auth changes globally (to handle sign outs)
    firebase.auth().onAuthStateChanged((user) => {
        const path = window.location.pathname;
        if (!user && 
            !path.includes('join-community') && 
            path !== '/' && 
            !path.includes('index') &&
            !path.includes('circle-detail') &&
            !path.includes('book-detail')) {
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
        // so cost and latency grew linearly with the whole catalogue.
        ITEMS_PAGE_SIZE: 24,
        MAX_PAGE_SIZE: 50,
        MAX_REFILL_ROUNDS: 5,

        /**
         * Paginated, indexed catalogue read with server-side query pushing,
         * cursor pagination, visibility scoping, and query safeguards.
         *
         * @param {string} category    'all' or a category id
         * @param {string|null} userId viewer uid for circle-scoped visibility
         * @param {object} opts        { pageSize, cursor, listing_type, available_only, book_id, circle_id, owner_id, exclude_owner_id, search, maxRefillRounds }
         * @returns {{items: Array, nextCursor: any|null, hasMore: boolean, totalFetched: number}}
         */
        getItemsPage: async function(category = 'all', userId = null, opts = {}) {
            const rawPageSize = Number(opts.pageSize) || this.ITEMS_PAGE_SIZE;
            const pageSize = Math.max(1, Math.min(rawPageSize, this.MAX_PAGE_SIZE));
            const cursor = opts.cursor || null;
            const listingType = (opts.listing_type && opts.listing_type !== 'all') ? opts.listing_type : null;
            const availableOnly = !!opts.available_only;
            const bookId = opts.book_id || null;
            const circleId = opts.circle_id || null;
            const ownerId = opts.owner_id || null;
            const excludeOwnerId = opts.exclude_owner_id || null;
            const searchQuery = typeof opts.search === 'string' ? opts.search.trim() : null;
            const maxRounds = typeof opts.maxRefillRounds === 'number' ? Math.max(1, opts.maxRefillRounds) : this.MAX_REFILL_ROUNDS;

            try {
                const db = firebase.firestore();

                // Build server-side query with filters where supported by composite indexes.
                // If a composite index is missing or throws at runtime, fallback gracefully
                // to a broader query and apply the filters in-memory on the page batch.
                let useServerCategoryFilter = category !== 'all';
                let useServerListingTypeFilter = !!listingType;
                let useServerBookFilter = !!bookId;
                let useServerCircleFilter = !!circleId;
                let useServerOwnerFilter = !!ownerId;
                let useServerAvailableFilter = availableOnly;

                const buildPageQuery = (cursorIn) => {
                    let q = db.collection('items');
                    if (useServerBookFilter) {
                        q = q.where('book_id', '==', bookId);
                    }
                    if (useServerOwnerFilter) {
                        q = q.where('owner_id', '==', ownerId);
                    }
                    if (useServerCircleFilter) {
                        q = q.where('circle_id', '==', circleId);
                    }
                    if (useServerListingTypeFilter) {
                        q = q.where('listing_type', '==', listingType);
                    }
                    if (useServerAvailableFilter) {
                        q = q.where('is_available', '==', true);
                    }
                    if (useServerCategoryFilter) {
                        q = q.where('categories', 'array-contains', category);
                    }
                    q = q.orderBy('created_at', 'desc').limit(pageSize + 1);
                    return cursorIn ? q.startAfter(cursorIn) : q;
                };

                let snapshot = null;
                let ordered = true;

                // Primary attempt: full server-side filters + ordering
                try {
                    snapshot = await buildPageQuery(cursor).get();
                } catch (qErr) {
                    // Gradual fallback: drop composite equality/array filters if missing index
                    useServerListingTypeFilter = false;
                    useServerAvailableFilter = false;
                    try {
                        snapshot = await buildPageQuery(cursor).get();
                    } catch (secErr) {
                        useServerCategoryFilter = false;
                        useServerCircleFilter = false;
                        try {
                            snapshot = await buildPageQuery(cursor).get();
                        } catch (thirdErr) {
                            snapshot = null;
                        }
                    }

                    if (!snapshot) {
                        // Final fallback: bare query without order if created_at index missing
                        ordered = false;
                        let bare = db.collection('items').limit(pageSize + 1);
                        if (bookId) bare = bare.where('book_id', '==', bookId);
                        if (cursor) bare = bare.startAfter(cursor);
                        snapshot = await bare.get();
                    }
                }

                // In-memory filter predicate to apply on any page batch
                let myCircleIds = null;
                if (userId) {
                    const memberships = await this.getMyMemberships(userId);
                    myCircleIds = new Set(memberships.map(m => m.circle_id));
                }

                const applyFilters = (rawDocs) => {
                    return rawDocs.filter(item => {
                        // Category filter
                        if (category !== 'all') {
                            const matchCat = (item.categories && Array.isArray(item.categories) && item.categories.includes(category))
                                || item.category === category;
                            if (!matchCat) return false;
                        }

                        // Listing type filter
                        if (listingType && item.listing_type !== listingType) {
                            return false;
                        }

                        // Availability filter
                        if (availableOnly) {
                            if (item.is_available === false || item.status === 'borrowed') {
                                return false;
                            }
                        }

                        // Book ID filter
                        if (bookId && item.book_id !== bookId) {
                            return false;
                        }

                        // Owner filter
                        if (ownerId && item.owner_id !== ownerId) {
                            return false;
                        }

                        // Exclude owner (e.g. viewer's own items on explore)
                        if (excludeOwnerId && item.owner_id === excludeOwnerId) {
                            return false;
                        }

                        // Circle filter
                        if (circleId) {
                            const inCircle = item.circle_id === circleId ||
                                (item.circle_ids && Array.isArray(item.circle_ids) && item.circle_ids.includes(circleId));
                            if (!inCircle) return false;
                        }

                        // Search query filter (fuzzy or substring on name/description/categories)
                        if (searchQuery) {
                            const matchesSearch = this.matchesSearchFuzzy(item, searchQuery);
                            if (!matchesSearch) return false;
                        }

                        // Visibility scoping (Issue #18)
                        if (item.visibility === 'trusted') {
                            const trustedList = Array.isArray(item.trusted_user_ids) ? item.trusted_user_ids : [];
                            return !!(userId && (item.owner_id === userId || trustedList.includes(userId)));
                        }
                        if (item.visibility === 'circles') {
                            if (!userId || !myCircleIds) return false;
                            if (item.owner_id === userId) return true;
                            if (item.circle_ids && item.circle_ids.length > 0) {
                                return item.circle_ids.some(cid => myCircleIds.has(cid));
                            }
                            return !!(item.circle_id && myCircleIds.has(item.circle_id));
                        }
                        if (item.visibility === 'public' || item.visibility_scope === 'world_of_books') {
                            return true;
                        }
                        if (userId) {
                            if (item.circle_ids && item.circle_ids.length > 0) {
                                return item.circle_ids.some(cid => myCircleIds.has(cid));
                            }
                            return !item.circle_id || myCircleIds.has(item.circle_id);
                        }
                        return !item.circle_id && (!item.circle_ids || item.circle_ids.length === 0);
                    }).map(item => {
                        // Location privacy: never reveal exact_address in public catalog reads
                        const sanitized = { ...item };
                        delete sanitized.exact_address;
                        return sanitized;
                    });
                };

                const docs = snapshot.docs;
                const hasMoreInitial = ordered && docs.length > pageSize;
                const page = docs.slice(0, pageSize);

                let rawItems = page.map(doc => ({ id: doc.id, ...doc.data() }));
                let filteredItems = applyFilters(rawItems);

                // Refill loop: if visibility/in-memory filters hollowed out the page,
                // fetch subsequent batches until pageSize is satisfied or maxRounds is reached.
                let nextCursor = page.length ? page[page.length - 1] : null;
                let exhausted = !hasMoreInitial;
                let rounds = 0;

                while (!exhausted && ordered && filteredItems.length < pageSize && rounds < maxRounds) {
                    rounds++;
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

                    const moreRaw = moreDocs.map(doc => ({ id: doc.id, ...doc.data() }));
                    const moreFiltered = applyFilters(moreRaw);
                    filteredItems = filteredItems.concat(moreFiltered);
                }

                return {
                    items: filteredItems.slice(0, pageSize),
                    nextCursor: nextCursor,
                    hasMore: !exhausted && (filteredItems.length >= pageSize || docs.length > pageSize),
                    totalFetched: filteredItems.length
                };
            } catch (err) {
                console.error("Error getting items page:", err);
                return { items: [], nextCursor: null, hasMore: false, totalFetched: 0 };
            }
        },

        /**
         * Paginated reads for circle-scoped inventory.
         * @param {string} circleId
         * @param {object} opts { pageSize, cursor, available_only, listing_type }
         * @returns {{items: Array, nextCursor: any|null, hasMore: boolean}}
         */
        getCircleItemsPage: async function(circleId, opts = {}) {
            const rawPageSize = Number(opts.pageSize) || this.ITEMS_PAGE_SIZE;
            const pageSize = Math.max(1, Math.min(rawPageSize, this.MAX_PAGE_SIZE));
            const cursor = opts.cursor || null;

            try {
                const db = firebase.firestore();
                let q = db.collection('items')
                    .where('circle_id', '==', circleId)
                    .orderBy('created_at', 'desc')
                    .limit(pageSize + 1);
                if (cursor) q = q.startAfter(cursor);

                let snapshot;
                try {
                    snapshot = await q.get();
                } catch (e) {
                    // Fallback without ordering if index not yet provisioned
                    let bare = db.collection('items').where('circle_id', '==', circleId).limit(pageSize + 1);
                    if (cursor) bare = bare.startAfter(cursor);
                    snapshot = await bare.get();
                }

                const docs = snapshot.docs;
                const hasMore = docs.length > pageSize;
                const page = docs.slice(0, pageSize);
                let items = page.map(d => {
                    const data = d.data();
                    delete data.exact_address;
                    return { id: d.id, ...data };
                });

                if (opts.available_only) {
                    items = items.filter(i => i.is_available !== false && i.status !== 'borrowed');
                }
                if (opts.listing_type && opts.listing_type !== 'all') {
                    items = items.filter(i => i.listing_type === opts.listing_type);
                }

                const nextCursor = page.length ? page[page.length - 1] : null;
                return {
                    items,
                    nextCursor,
                    hasMore
                };
            } catch (err) {
                console.error("Error getting circle items page:", err);
                return { items: [], nextCursor: null, hasMore: false };
            }
        },

        /**
         * Unified search over both canonical books (ISBN, title prefix, author)
         * and physical/general items.
         */
        searchCatalog: async function({ query = '', category = 'all', listing_type = 'all', available_only = false, limit = 20, userId = null } = {}) {
            const cleanQuery = (query || '').trim();
            const results = {
                books: [],
                items: [],
                totalResults: 0
            };

            // 1. If there's a search query, search canonical books first (ISBN, title prefix, author)
            if (cleanQuery) {
                try {
                    const matchedBooks = await this.searchBooks({ query: cleanQuery, limit: Math.min(limit, 10) });
                    results.books = matchedBooks.map(b => ({
                        ...b,
                        copiesStatus: this.getBookCopiesStatus(b)
                    }));
                } catch (err) {
                    console.warn('searchCatalog: books search error:', err);
                }
            }

            // 2. Fetch matching items via getItemsPage
            try {
                const pageResult = await this.getItemsPage(category, userId, {
                    pageSize: limit,
                    listing_type: listing_type !== 'all' ? listing_type : null,
                    available_only: !!available_only,
                    search: cleanQuery || null
                });
                results.items = pageResult.items;
                results.hasMore = pageResult.hasMore;
                results.nextCursor = pageResult.nextCursor;
            } catch (err) {
                console.warn('searchCatalog: items search error:', err);
            }

            results.totalResults = results.books.length + results.items.length;

            await this.logAnalyticsEvent('search_executed', {
                query: cleanQuery || '',
                category: category || 'all',
                results_count: results.totalResults
            });

            return results;
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

        getCircleItems: async function(circleId, opts = {}) {
            if (opts.pageSize || opts.cursor) {
                const page = await this.getCircleItemsPage(circleId, opts);
                return page.items;
            }
            try {
                const dbRef = firebase.firestore().collection('items');
                const [snap1, snap2] = await Promise.all([
                    dbRef.where('circle_id', '==', circleId).limit(50).get(),
                    dbRef.where('circle_ids', 'array-contains', circleId).limit(50).get()
                ]);
                const itemsMap = {};
                snap1.docs.forEach(doc => {
                    const data = doc.data();
                    delete data.exact_address;
                    itemsMap[doc.id] = { id: doc.id, ...data };
                });
                snap2.docs.forEach(doc => {
                    const data = doc.data();
                    delete data.exact_address;
                    itemsMap[doc.id] = { id: doc.id, ...data };
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

        // V1 listing types. Legacy 'free' and 'rental' listings remain
        // readable (and are mapped for display/editing), but new writes must
        // never introduce a rental.
        LISTING_TYPES: ['borrow', 'giveaway', 'swap'],

        normalizeListingType: function(type, intent) {
            const raw = String(type || '').toLowerCase();
            const rawIntent = String(intent || '').toLowerCase();
            if ((raw === 'free' || raw === '') && (rawIntent === 'donate' || rawIntent === 'giveaway')) {
                return 'giveaway';
            }
            if (raw === 'rental' || raw === 'free' || raw === 'lend' || raw === 'loan') return 'borrow';
            if (raw === 'donate' || raw === 'donation') return 'giveaway';
            if (raw === 'swap' || raw === 'trade') return 'swap';
            if (raw === 'giveaway') return 'giveaway';
            return 'borrow';
        },

        // Kept as a named alias so callers/UI can express intent explicitly.
        mapLegacyListingType: function(type) {
            return this.normalizeListingType(type);
        },

        syncBookCopyCounts: async function(bookId) {
            if (!bookId) return null;
            try {
                const book = await this.getBook(bookId);
                if (!book) return null;

                const snap = await firebase.firestore().collection('items')
                    .where('book_id', '==', bookId)
                    .get();
                const copies = snap.docs.map(doc => doc.data());
                const total = copies.length;
                const available = copies.filter(copy =>
                    copy.is_available !== false && (!copy.status || copy.status === 'available')
                ).length;

                if (book.copies_count === total && book.available_copies_count === available) {
                    try {
                        this.syncBookToSearchIndex(bookId, book);
                    } catch (e) {}
                    return book;
                }

                await firebase.firestore().collection('books').doc(bookId).set({
                    copies_count: total,
                    available_copies_count: available,
                    updated_at: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                const updatedBook = { ...book, copies_count: total, available_copies_count: available };
                try {
                    this.syncBookToSearchIndex(bookId, updatedBook);
                } catch (e) {}

                return updatedBook;
            } catch (err) {
                console.warn('Could not sync book copy counts:', err);
                return null;
            }
        },

        addItem: async function(itemData) {
            try {
                const user = firebase.auth().currentUser;
                const ownerId = itemData.owner_id || (user ? user.uid : null);
                const categories = Array.isArray(itemData.categories) ? itemData.categories : [];
                const isBook = itemData.kind === 'book'
                    || !!itemData.book_id
                    || categories.includes('books');

                // A physical copy can never exist without its canonical book
                // and an owner. Generic non-book items keep the legacy path.
                if (itemData.owner_id && user && itemData.owner_id !== user.uid) {
                    throw new Error('owner_id must match the signed-in user.');
                }
                if (isBook) {
                    if (!ownerId) {
                        throw new Error('A book copy must have an owner.');
                    }
                    if (!itemData.book_id) {
                        throw new Error('A book copy must be linked to a canonical book.');
                    }
                }

                let ownerName = 'Neighbor';
                let ownerAvatar = '';
                if (user) {
                    const profile = await this.getProfile(user.uid);
                    if (profile) {
                        ownerName = profile.full_name || 'Neighbor';
                        ownerAvatar = profile.avatar_url || '';
                    }
                }

                const listingType = this.normalizeListingType(itemData.listing_type, itemData.intent);

                const doc = {
                    ...itemData,
                    listing_type: listingType,
                    owner_id: ownerId,
                    owner_name: ownerName,
                    owner_avatar: ownerAvatar,
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                };

                // Visibility, request policy, and trusted users defaults (Issue #18)
                if (doc.kind === 'book') {
                    doc.visibility = doc.visibility || 'public';
                }
                if (doc.visibility) {
                    if (doc.visibility === 'public') {
                        doc.visibility_scope = doc.visibility_scope || 'world_of_books';
                    } else if (doc.visibility === 'circles') {
                        doc.visibility_scope = 'circles';
                    } else if (doc.visibility === 'trusted') {
                        doc.visibility_scope = 'trusted';
                    }
                }
                doc.request_policy = doc.request_policy || 'anyone';
                if (Array.isArray(doc.trusted_user_ids)) {
                    doc.trusted_user_ids = doc.trusted_user_ids.map(String).filter(Boolean);
                } else if ('trusted_user_ids' in doc && doc.trusted_user_ids !== undefined) {
                    // Keep non-array as-is so security rules reject invalid types
                } else {
                    doc.trusted_user_ids = [];
                }

                // Book spine fields. `name` is the display title used by the
                // existing item-details/explore UI; metadata is kept alongside
                // so the catalogue can be searched without loading everything.
                if (doc.kind === 'book') {
                    doc.condition = doc.condition || doc.condition_grade || null;
                    doc.condition_grade = doc.condition_grade || doc.condition || null;
                    doc.photos = Array.isArray(doc.photos) ? doc.photos : (doc.image_url ? [doc.image_url] : []);
                    if (doc.visibility === 'public') {
                        doc.visibility_scope = doc.visibility_scope || 'world_of_books';
                    } else if (doc.visibility === 'circles') {
                        doc.visibility_scope = 'circles';
                    } else if (doc.visibility === 'trusted') {
                        doc.visibility_scope = 'trusted';
                    }
                }
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

                if (doc.book_id) {
                    await this.syncBookCopyCounts(doc.book_id);
                }

                await this.logAnalyticsEvent('listing_created', {
                    item_id: ref.id,
                    name: doc.name,
                    kind: doc.kind,
                    listing_type: doc.listing_type,
                    circle_id: doc.circle_id || null,
                    book_id: doc.book_id || null
                });

                return { id: ref.id };
            } catch (err) {
                console.error("Error adding item:", err);
                throw err;
            }
        },

        updateItem: async function(itemId, itemData) {
            try {
                const patch = { ...itemData };
                if ('listing_type' in patch) {
                    patch.listing_type = this.normalizeListingType(patch.listing_type);
                }
                if ('photos' in patch || 'image_url' in patch) {
                    if (!Array.isArray(patch.photos)) {
                        patch.photos = patch.image_url ? [patch.image_url] : [];
                    }
                }
                if ('visibility' in patch && !['public', 'circles', 'trusted'].includes(patch.visibility)) {
                    delete patch.visibility;
                }
                if ('request_policy' in patch && !['anyone', 'circle_members', 'trusted_only'].includes(patch.request_policy)) {
                    delete patch.request_policy;
                }
                if ('trusted_user_ids' in patch && Array.isArray(patch.trusted_user_ids)) {
                    patch.trusted_user_ids = patch.trusted_user_ids.map(String).filter(Boolean);
                }
                await firebase.firestore().collection('items').doc(itemId).set({
                    ...patch,
                    updated_at: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                if (patch.book_id) {
                    await this.syncBookCopyCounts(patch.book_id);
                }
                return { id: itemId };
            } catch (err) {
                console.error("Error updating item:", err);
                throw err;
            }
        },

        deleteItem: async function(itemId) {
            try {
                const docSnap = await firebase.firestore().collection('items').doc(itemId).get();
                const existing = docSnap.exists ? docSnap.data() : null;
                if (existing && existing.active_request_id) {
                    throw new Error("Cannot delete item with an active circulation transaction.");
                }
                await firebase.firestore().collection('items').doc(itemId).delete();
                if (existing && existing.book_id) {
                    await this.syncBookCopyCounts(existing.book_id);
                }
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
                if (err && err.code === 'permission-denied') {
                    throw err;
                }
                console.warn("Could not retrieve private location:", err);
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
                    member_count: 1,
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

        getCircles: async function(opts = {}) {
            try {
                const isPaginated = !!(opts && (opts.paginated || opts.pageSize || opts.cursor));
                if (isPaginated) {
                    const pageSize = Math.max(1, Math.min(Number(opts.pageSize) || 12, 100));
                    let query = firebase.firestore().collection('circles')
                        .orderBy('created_at', 'desc');
                    if (opts.cursor) {
                        query = query.startAfter(opts.cursor);
                    }
                    query = query.limit(pageSize + 1);

                    const snapshot = await query.get();
                    const hasMore = snapshot.docs.length > pageSize;
                    const pagedDocs = hasMore ? snapshot.docs.slice(0, pageSize) : snapshot.docs;
                    const nextCursor = hasMore ? pagedDocs[pagedDocs.length - 1] : null;
                    const circles = pagedDocs.map(doc => ({ id: doc.id, ...doc.data() }));
                    return { circles, nextCursor, hasMore };
                }

                const snapshot = await firebase.firestore().collection('circles').get();
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            } catch (err) {
                console.error("Error getting circles:", err);
                if (opts && (opts.paginated || opts.pageSize || opts.cursor)) {
                    return { circles: [], nextCursor: null, hasMore: false };
                }
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

        getCircleMemberCount: async function(circleId) {
            if (!circleId) return 0;
            try {
                const circleDoc = await firebase.firestore().collection('circles').doc(circleId).get();
                if (circleDoc.exists) {
                    const data = circleDoc.data();
                    if (typeof data.member_count === 'number') {
                        return Math.max(0, data.member_count);
                    }
                }
                // Fallback if not yet initialized
                const snapshot = await firebase.firestore().collection('circle_members')
                    .where('circle_id', '==', circleId).get();
                return snapshot.docs.length;
            } catch (err) {
                console.error("Error getting circle member count:", err);
                return 0;
            }
        },

        getCircleMembership: async function(circleId, userId) {
            if (!circleId || !userId) return null;
            try {
                const doc = await firebase.firestore().collection('circle_members').doc(`${circleId}_${userId}`).get();
                return doc.exists ? { id: doc.id, ...doc.data() } : null;
            } catch (err) {
                console.error("Error getting circle membership:", err);
                return null;
            }
        },

        getCircleMembers: async function(circleId, opts = {}) {
            try {
                const isPaginated = !!(opts && (opts.paginated || opts.pageSize || opts.cursor));
                if (isPaginated) {
                    const pageSize = Math.max(1, Math.min(Number(opts.pageSize) || 20, 100));
                    let query = firebase.firestore().collection('circle_members')
                        .where('circle_id', '==', circleId)
                        .orderBy('joined_at', 'desc');

                    if (opts.cursor) {
                        query = query.startAfter(opts.cursor);
                    }
                    query = query.limit(pageSize + 1);

                    const snapshot = await query.get();
                    const hasMore = snapshot.docs.length > pageSize;
                    const pagedDocs = hasMore ? snapshot.docs.slice(0, pageSize) : snapshot.docs;
                    const nextCursor = hasMore ? pagedDocs[pagedDocs.length - 1] : null;

                    const memberships = pagedDocs.map(doc => doc.data());
                    const members = await Promise.all(memberships.map(async (m) => {
                        const profile = await this.getProfile(m.profile_id);
                        if (profile) {
                            return { ...profile, role: m.role, joined_at: m.joined_at };
                        }
                        return null;
                    }));

                    const totalCount = await this.getCircleMemberCount(circleId);

                    return {
                        members: members.filter(Boolean),
                        nextCursor,
                        hasMore,
                        totalCount
                    };
                }

                // Legacy unpaginated behavior
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
                if (opts && (opts.paginated || opts.pageSize || opts.cursor)) {
                    return { members: [], nextCursor: null, hasMore: false, totalCount: 0 };
                }
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
                const memRef = firebase.firestore().collection('circle_members').doc(id);
                const memDoc = await memRef.get();
                const isNew = !memDoc.exists;

                await memRef.set({
                    circle_id: circleId,
                    profile_id: profileId,
                    role: role,
                    joined_at: new Date().toISOString()
                });

                if (isNew) {
                    try {
                        const circleRef = firebase.firestore().collection('circles').doc(circleId);
                        const cSnap = await circleRef.get();
                        if (cSnap.exists) {
                            const curCount = cSnap.data().member_count;
                            const newCount = typeof curCount === 'number' ? Math.max(1, curCount + 1) : 1;
                            await circleRef.set({ member_count: newCount }, { merge: true });
                        }
                    } catch (e) {
                        console.warn("Could not increment circle member_count:", e);
                    }
                }
            } catch (err) {
                console.error("Error joining circle:", err);
                throw err;
            }
        },

        leaveCircle: async function(circleId, profileId) {
            try {
                const id = `${circleId}_${profileId}`;
                const memRef = firebase.firestore().collection('circle_members').doc(id);
                const memDoc = await memRef.get();
                if (memDoc.exists) {
                    await memRef.delete();
                    try {
                        const circleRef = firebase.firestore().collection('circles').doc(circleId);
                        const cSnap = await circleRef.get();
                        if (cSnap.exists) {
                            const curCount = cSnap.data().member_count;
                            const newCount = typeof curCount === 'number' ? Math.max(0, curCount - 1) : 0;
                            await circleRef.set({ member_count: newCount }, { merge: true });
                        }
                    } catch (e) {
                        console.warn("Could not decrement circle member_count:", e);
                    }
                }
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
                let itemCircleId = null;
                let itemOwnerId = null;
                let itemDisplayName = null;
                let itemBookId = null;
                
                const result = await db.runTransaction(async (transaction) => {
                    const itemDoc = await transaction.get(itemRef);
                    if (!itemDoc.exists) {
                        throw new Error("Item does not exist.");
                    }
                    const itemData = itemDoc.data();
                    itemCircleId = itemData.circle_id || (Array.isArray(itemData.circle_ids) ? itemData.circle_ids[0] : null);
                    itemOwnerId = itemData.owner_id;
                    itemDisplayName = itemData.name;
                    itemBookId = itemData.book_id || null;
                    
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

                    // Enforce visibility & request policy (Issue #18)
                    const borrowerId = requestData.borrower_id;
                    const itemVisibility = itemData.visibility || 'public';
                    const itemPolicy = itemData.request_policy || 'anyone';
                    const trustedUserIds = Array.isArray(itemData.trusted_user_ids) ? itemData.trusted_user_ids : [];
                    const itemCircles = Array.isArray(itemData.circle_ids) ? itemData.circle_ids : (itemData.circle_id ? [itemData.circle_id] : []);

                    let isBorrowerCircleMember = false;
                    for (const cid of itemCircles) {
                        const memberDoc = await db.collection('circle_members').doc(`${cid}_${borrowerId}`).get();
                        if (memberDoc.exists) {
                            isBorrowerCircleMember = true;
                            break;
                        }
                    }

                    // Visibility checks
                    if (itemVisibility === 'trusted' && !trustedUserIds.includes(borrowerId)) {
                        throw new Error("This copy is private to trusted neighbors only.");
                    }
                    if (itemVisibility === 'circles' && !isBorrowerCircleMember && itemCircles.length > 0) {
                        throw new Error("This copy is visible only to circle members.");
                    }

                    // Request policy checks
                    if (itemPolicy === 'trusted_only' && !trustedUserIds.includes(borrowerId)) {
                        throw new Error("The owner only accepts borrow requests from trusted neighbors for this copy.");
                    }
                    if (itemPolicy === 'circle_members' && !isBorrowerCircleMember && itemCircles.length > 0) {
                        throw new Error("The owner only accepts borrow requests from circle members for this copy.");
                    }

                    // Create the request
                    const circleId = itemData.circle_id || null;
                    const circleIds = itemData.circle_ids || [];
                    
                    const { lender_id: _ignoredLenderId, ...safeRequestData } = requestData;

                    const requestType = requestData.type || (
                        (itemData.listing_type === 'giveaway' || itemData.intent === 'donate')
                            ? 'giveaway'
                            : (itemData.listing_type === 'swap' ? 'swap' : 'borrow')
                    );

                    let offeredBookId = null;
                    if (requestType === 'swap') {
                        if (!requestData.offered_item_id) {
                            throw new Error("A swap request requires an offered item.");
                        }
                        const offeredRef = db.collection('items').doc(requestData.offered_item_id);
                        const offeredDoc = await transaction.get(offeredRef);
                        if (!offeredDoc.exists) {
                            throw new Error("Offered swap item does not exist.");
                        }
                        const offeredData = offeredDoc.data();
                        if (offeredData.owner_id !== requestData.borrower_id) {
                            throw new Error("You can only offer items you own in a swap.");
                        }
                        if (offeredData.is_available === false || ['approved', 'borrowed', 'returned'].includes(offeredData.status)) {
                            throw new Error("Your offered item is currently not available for a swap.");
                        }
                        offeredBookId = offeredData.book_id || null;
                    }

                    const participantIds = [requestData.borrower_id, itemData.owner_id];
                    const fulfillmentMethod = requestData.fulfillment_method || 'pickup';
                    const newRequestRef = db.collection('requests').doc();
                    const eventRef = db.collection('transaction_events').doc();

                    const initialTimeline = [{
                        status: 'pending',
                        actor_id: requestData.borrower_id,
                        event_type: 'requested',
                        event_id: eventRef.id,
                        created_at: new Date()
                    }];

                    transaction.set(newRequestRef, {
                        ...safeRequestData,
                        lender_id: itemData.owner_id,
                        participant_ids: participantIds,
                        type: requestType,
                        book_id: itemData.book_id || null,
                        offered_item_id: requestData.offered_item_id || null,
                        offered_book_id: offeredBookId,
                        fulfillment_method: fulfillmentMethod,
                        shipping_payer: requestData.shipping_payer || null,
                        shipping_notes: requestData.shipping_notes ? String(requestData.shipping_notes).trim() : '',
                        carrier: requestData.carrier || null,
                        tracking_number: requestData.tracking_number || null,
                        return_due_date: requestData.return_due_date || null,
                        circle_id: circleId,
                        circle_ids: circleIds,
                        status: 'pending',
                        timeline: initialTimeline,
                        last_event_id: eventRef.id,
                        last_event_type: 'requested',
                        created_at: firebase.firestore.FieldValue.serverTimestamp(),
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    if (requestType === 'swap' && requestData.offered_item_id) {
                        const offeredRef = db.collection('items').doc(requestData.offered_item_id);
                        transaction.update(offeredRef, {
                            active_request_id: newRequestRef.id
                        });
                    }

                    // Append immutable transaction event (Issue #2, #3, #13)
                    transaction.set(eventRef, {
                        request_id: newRequestRef.id,
                        transaction_type: requestType,
                        item_id: requestData.item_id,
                        book_id: itemData.book_id || null,
                        offered_item_id: requestData.offered_item_id || null,
                        offered_book_id: offeredBookId,
                        circle_id: circleId,
                        circle_ids: circleIds,
                        actor_id: requestData.borrower_id,
                        borrower_id: requestData.borrower_id,
                        lender_id: itemData.owner_id,
                        participant_ids: participantIds,
                        event_type: 'requested',
                        from_status: null,
                        to_status: 'pending',
                        fulfillment_method: fulfillmentMethod,
                        metadata: {
                            type: requestType,
                            duration: requestData.duration || 'flexible',
                            shipping_payer: requestData.shipping_payer || null
                        },
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    
                    return { id: newRequestRef.id };
                });

                await this.logAnalyticsEvent('request_created', {
                    request_id: result.id,
                    item_id: requestData.item_id,
                    circle_id: itemCircleId,
                    borrower_id: requestData.borrower_id
                });

                try {
                    const lenderId = requestData.lender_id || itemOwnerId;
                    if (lenderId) {
                        await this.dispatchNotification({
                            recipientId: lenderId,
                            actorId: requestData.borrower_id,
                            type: 'request_created',
                            title: 'New Borrow Request',
                            body: `New request received for "${itemDisplayName || 'your book'}".`,
                            actionUrl: `activity.html?request=${result.id}`,
                            requestId: result.id,
                            bookId: itemBookId,
                            itemId: requestData.item_id,
                            circleId: itemCircleId
                        });
                    }
                } catch (notifErr) {
                    console.warn('[Notifications] Non-fatal notification error on request_created:', notifErr);
                }

                return result;
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

        // --- Transaction History & Ledger Audit Queries (Issue #13) ---
        getTransactionHistoryForUser: async function(userId, opts = {}) {
            if (!userId) return [];
            const limit = opts.limit || 50;
            try {
                let snap;
                try {
                    snap = await firebase.firestore().collection('requests')
                        .where('participant_ids', 'array-contains', userId)
                        .orderBy('created_at', 'desc')
                        .limit(limit)
                        .get();
                } catch (e) {
                    // Fallback without ordering or separate queries if index unprovisioned
                    const [borrowerSnap, lenderSnap] = await Promise.all([
                        firebase.firestore().collection('requests').where('borrower_id', '==', userId).limit(limit).get(),
                        firebase.firestore().collection('requests').where('lender_id', '==', userId).limit(limit).get()
                    ]);
                    const map = {};
                    borrowerSnap.docs.forEach(d => map[d.id] = { id: d.id, ...d.data() });
                    lenderSnap.docs.forEach(d => map[d.id] = { id: d.id, ...d.data() });
                    const list = Object.values(map);
                    list.sort((a, b) => {
                        const tA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                        const tB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                        return tB - tA;
                    });
                    return list.slice(0, limit);
                }

                return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            } catch (err) {
                console.error("Error getting transaction history for user:", err);
                return [];
            }
        },

        getTransactionEventsForRequest: async function(requestId) {
            if (!requestId) return [];
            try {
                let snap;
                try {
                    snap = await firebase.firestore().collection('transaction_events')
                        .where('request_id', '==', requestId)
                        .orderBy('created_at', 'asc')
                        .get();
                } catch (e) {
                    snap = await firebase.firestore().collection('transaction_events')
                        .where('request_id', '==', requestId)
                        .get();
                }
                const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                events.sort((a, b) => {
                    const tA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                    const tB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                    return tA - tB;
                });
                return events;
            } catch (err) {
                console.error("Error getting transaction events for request:", err);
                return [];
            }
        },

        getTransactionHistoryForBook: async function(bookId, opts = {}) {
            if (!bookId) return [];
            const limit = opts.limit || 50;
            try {
                let snap;
                try {
                    snap = await firebase.firestore().collection('requests')
                        .where('book_id', '==', bookId)
                        .orderBy('created_at', 'desc')
                        .limit(limit)
                        .get();
                } catch (e) {
                    snap = await firebase.firestore().collection('requests')
                        .where('book_id', '==', bookId)
                        .limit(limit)
                        .get();
                }
                const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                list.sort((a, b) => {
                    const tA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                    const tB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                    return tB - tA;
                });
                return list;
            } catch (err) {
                console.error("Error getting transaction history for book:", err);
                return [];
            }
        },

        getTransactionHistoryForCircle: async function(circleId, opts = {}) {
            if (!circleId) return [];
            const limit = opts.limit || 50;
            try {
                let snap;
                try {
                    snap = await firebase.firestore().collection('requests')
                        .where('circle_id', '==', circleId)
                        .orderBy('created_at', 'desc')
                        .limit(limit)
                        .get();
                } catch (e) {
                    snap = await firebase.firestore().collection('requests')
                        .where('circle_id', '==', circleId)
                        .limit(limit)
                        .get();
                }
                const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                list.sort((a, b) => {
                    const tA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                    const tB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                    return tB - tA;
                });
                return list;
            } catch (err) {
                console.error("Error getting transaction history for circle:", err);
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
                let itemCircleId = null;
                let notifiedBorrowerId = null;
                let notifiedItemName = null;
                let notifiedBookId = null;

                await db.runTransaction(async (transaction) => {
                    const itemDoc = await transaction.get(itemRef);
                    if (!itemDoc.exists) {
                        throw new Error("Item does not exist.");
                    }
                    const itemData = itemDoc.data();
                    itemCircleId = itemData.circle_id || (Array.isArray(itemData.circle_ids) ? itemData.circle_ids[0] : null);
                    notifiedItemName = itemData.name;
                    notifiedBookId = itemData.book_id || null;
                    
                    // Check if item is already lent/promised (i.e., is_available is false, or status is approved/borrowed/returned)
                    if (itemData.is_available === false || ['approved', 'borrowed', 'returned'].includes(itemData.status)) {
                        throw new Error("This item is already lent or promised to another user.");
                    }

                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) {
                        throw new Error("Request does not exist.");
                    }
                    const requestData = requestDoc.data();
                    notifiedBorrowerId = requestData.borrower_id;
                    if (!notifiedBookId && requestData.book_id) notifiedBookId = requestData.book_id;
                    if (requestData.status !== 'pending') {
                        throw new Error("This request is no longer pending.");
                    }

                    const eventRef = db.collection('transaction_events').doc();
                    const now = new Date();
                    const existingTimeline = Array.isArray(requestData.timeline) ? requestData.timeline : [];
                    const newTimeline = [...existingTimeline, {
                        status: 'approved',
                        actor_id: itemData.owner_id,
                        event_type: 'approved',
                        event_id: eventRef.id,
                        created_at: now
                    }];

                    // Update request status to approved
                    transaction.update(requestRef, {
                        status: 'approved',
                        confirmed_at: firebase.firestore.FieldValue.serverTimestamp(),
                        timeline: newTimeline,
                        last_event_id: eventRef.id,
                        last_event_type: 'approved',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // Update item status to approved (reserved) and is_available to false
                    transaction.update(itemRef, {
                        status: 'approved',
                        is_available: false,
                        active_request_id: requestId
                    });

                    // In swaps, both items are marked reserved/in-transaction (Issue #14)
                    if ((requestData.type || 'borrow') === 'swap' && requestData.offered_item_id) {
                        const offeredRef = db.collection('items').doc(requestData.offered_item_id);
                        const offeredDoc = await transaction.get(offeredRef);
                        if (offeredDoc.exists) {
                            transaction.update(offeredRef, {
                                status: 'approved',
                                is_available: false,
                                active_request_id: requestId
                            });
                        }
                    }

                    const participantIds = requestData.participant_ids || [requestData.borrower_id, itemData.owner_id];
                    transaction.set(eventRef, {
                        request_id: requestId,
                        transaction_type: requestData.type || 'borrow',
                        item_id: itemId,
                        book_id: itemData.book_id || requestData.book_id || null,
                        offered_item_id: requestData.offered_item_id || null,
                        offered_book_id: requestData.offered_book_id || null,
                        circle_id: requestData.circle_id || itemData.circle_id || null,
                        circle_ids: requestData.circle_ids || itemData.circle_ids || [],
                        actor_id: itemData.owner_id,
                        borrower_id: requestData.borrower_id,
                        lender_id: itemData.owner_id,
                        participant_ids: participantIds,
                        event_type: 'approved',
                        from_status: 'pending',
                        to_status: 'approved',
                        fulfillment_method: requestData.fulfillment_method || 'pickup',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });

                await this.logAnalyticsEvent('request_approved', {
                    request_id: requestId,
                    item_id: itemId,
                    circle_id: itemCircleId
                });

                try {
                    if (notifiedBorrowerId) {
                        await this.dispatchNotification({
                            recipientId: notifiedBorrowerId,
                            actorId: firebase.auth().currentUser?.uid || null,
                            type: 'request_approved',
                            title: 'Borrow Request Approved',
                            body: `Your request for "${notifiedItemName || 'the book'}" has been approved!`,
                            actionUrl: `activity.html?request=${requestId}`,
                            requestId: requestId,
                            bookId: notifiedBookId,
                            itemId: itemId,
                            circleId: itemCircleId
                        });
                    }
                } catch (notifErr) {
                    console.warn('[Notifications] Non-fatal notification error on request_approved:', notifErr);
                }
            } catch (err) {
                console.error("Error confirming borrow request:", err);
                throw err;
            }
        },

        declineBorrowRequest: async function(requestId) {
            try {
                const db = firebase.firestore();
                const requestRef = db.collection('requests').doc(requestId);
                let notifiedBorrowerId = null;
                let notifiedCircleId = null;
                let notifiedItemName = null;
                
                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'pending') {
                        throw new Error("Only pending requests can be declined.");
                    }
                    notifiedBorrowerId = requestData.borrower_id;
                    notifiedCircleId = requestData.circle_id || null;
                    notifiedItemName = requestData.item_name || 'the book';

                    const eventRef = db.collection('transaction_events').doc();
                    const now = new Date();
                    const existingTimeline = Array.isArray(requestData.timeline) ? requestData.timeline : [];
                    const newTimeline = [...existingTimeline, {
                        status: 'declined',
                        actor_id: requestData.lender_id,
                        event_type: 'declined',
                        event_id: eventRef.id,
                        created_at: now
                    }];
                    
                    if ((requestData.type || 'borrow') === 'swap' && requestData.offered_item_id) {
                        const offeredRef = db.collection('items').doc(requestData.offered_item_id);
                        transaction.update(offeredRef, {
                            status: 'available',
                            is_available: true,
                            active_request_id: null
                        });
                    }

                    transaction.update(requestRef, {
                        status: 'declined',
                        declined_at: firebase.firestore.FieldValue.serverTimestamp(),
                        timeline: newTimeline,
                        last_event_id: eventRef.id,
                        last_event_type: 'declined',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    const participantIds = requestData.participant_ids || [requestData.borrower_id, requestData.lender_id];
                    transaction.set(eventRef, {
                        request_id: requestId,
                        transaction_type: requestData.type || 'borrow',
                        item_id: requestData.item_id,
                        book_id: requestData.book_id || null,
                        offered_item_id: requestData.offered_item_id || null,
                        offered_book_id: requestData.offered_book_id || null,
                        circle_id: requestData.circle_id || null,
                        circle_ids: requestData.circle_ids || [],
                        actor_id: requestData.lender_id,
                        borrower_id: requestData.borrower_id,
                        lender_id: requestData.lender_id,
                        participant_ids: participantIds,
                        event_type: 'declined',
                        from_status: 'pending',
                        to_status: 'declined',
                        fulfillment_method: requestData.fulfillment_method || 'pickup',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });

                try {
                    if (notifiedBorrowerId) {
                        await this.dispatchNotification({
                            recipientId: notifiedBorrowerId,
                            actorId: firebase.auth().currentUser?.uid || null,
                            type: 'request_declined',
                            title: 'Borrow Request Declined',
                            body: `Your request for "${notifiedItemName}" was declined.`,
                            actionUrl: `activity.html?request=${requestId}`,
                            requestId: requestId,
                            circleId: notifiedCircleId
                        });
                    }
                } catch (notifErr) {
                    console.warn('[Notifications] Non-fatal notification error on request_declined:', notifErr);
                }
            } catch (err) {
                console.error("Error declining borrow request:", err);
                throw err;
            }
        },

        cancelBorrowRequest: async function(requestId) {
            try {
                const db = firebase.firestore();
                const user = firebase.auth().currentUser;
                if (!user) throw new Error("Authentication required.");
                const requestRef = db.collection('requests').doc(requestId);

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();

                    const isBorrower = requestData.borrower_id === user.uid;
                    const isLender = requestData.lender_id === user.uid;
                    if (!isBorrower && !isLender) {
                        throw new Error("Only transaction participants can cancel a request.");
                    }

                    if (!['pending', 'approved'].includes(requestData.status)) {
                        throw new Error(`Cannot cancel a transaction after handoff (status: '${requestData.status}').`);
                    }

                    const eventRef = db.collection('transaction_events').doc();
                    const now = new Date();
                    const existingTimeline = Array.isArray(requestData.timeline) ? requestData.timeline : [];
                    const newTimeline = [...existingTimeline, {
                        status: 'cancelled',
                        actor_id: user.uid,
                        event_type: 'cancelled',
                        event_id: eventRef.id,
                        created_at: now
                    }];

                    // Release target item if it was reserved (must execute before request status becomes terminal)
                    if (requestData.item_id) {
                        const itemRef = db.collection('items').doc(requestData.item_id);
                        const itemDoc = await transaction.get(itemRef);
                        if (itemDoc.exists && itemDoc.data().active_request_id === requestId) {
                            transaction.update(itemRef, {
                                status: 'available',
                                is_available: true,
                                active_request_id: null
                            });
                        }
                    }

                    // Release offered item if swap
                    if (requestData.offered_item_id) {
                        const offeredRef = db.collection('items').doc(requestData.offered_item_id);
                        const offeredDoc = await transaction.get(offeredRef);
                        if (offeredDoc.exists && (offeredDoc.data().active_request_id === requestId || !offeredDoc.data().active_request_id)) {
                            transaction.update(offeredRef, {
                                status: 'available',
                                is_available: true,
                                active_request_id: null
                            });
                        }
                    }

                    // Update request status to cancelled
                    transaction.update(requestRef, {
                        status: 'cancelled',
                        cancelled_at: firebase.firestore.FieldValue.serverTimestamp(),
                        timeline: newTimeline,
                        last_event_id: eventRef.id,
                        last_event_type: 'cancelled',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    const participantIds = requestData.participant_ids || [requestData.borrower_id, requestData.lender_id];
                    transaction.set(eventRef, {
                        request_id: requestId,
                        transaction_type: requestData.type || 'borrow',
                        item_id: requestData.item_id,
                        book_id: requestData.book_id || null,
                        offered_item_id: requestData.offered_item_id || null,
                        offered_book_id: requestData.offered_book_id || null,
                        circle_id: requestData.circle_id || null,
                        circle_ids: requestData.circle_ids || [],
                        actor_id: user.uid,
                        borrower_id: requestData.borrower_id,
                        lender_id: requestData.lender_id,
                        participant_ids: participantIds,
                        event_type: 'cancelled',
                        from_status: requestData.status,
                        to_status: 'cancelled',
                        fulfillment_method: requestData.fulfillment_method || 'pickup',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });
            } catch (err) {
                console.error("Error cancelling request:", err);
                throw err;
            }
        },

        confirmSwapExchange: async function(requestId) {
            try {
                const db = firebase.firestore();
                const user = firebase.auth().currentUser;
                if (!user) throw new Error("Authentication required.");
                const requestRef = db.collection('requests').doc(requestId);

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();

                    if ((requestData.type || 'borrow') !== 'swap') {
                        throw new Error("confirmSwapExchange can only be used on swap transactions.");
                    }

                    const isBorrower = requestData.borrower_id === user.uid;
                    const isLender = requestData.lender_id === user.uid;
                    if (!isBorrower && !isLender) {
                        throw new Error("Only swap participants can confirm exchange.");
                    }

                    if (requestData.status !== 'approved') {
                        throw new Error(`Swap must be approved before exchange confirmation (current: '${requestData.status}').`);
                    }

                    const now = new Date();
                    const existingTimeline = Array.isArray(requestData.timeline) ? requestData.timeline : [];
                    const eventRef = db.collection('transaction_events').doc();

                    const isBorrowerConfirming = isBorrower;
                    const otherAlreadyConfirmed = isBorrowerConfirming
                        ? Boolean(requestData.lender_confirmed_at || requestData.owner_confirmed_at)
                        : Boolean(requestData.borrower_confirmed_at || requestData.requester_confirmed_at);

                    if (otherAlreadyConfirmed) {
                        const newTimeline = [...existingTimeline, {
                            status: 'completed',
                            actor_id: user.uid,
                            event_type: 'swap_completed',
                            event_id: eventRef.id,
                            created_at: now
                        }];

                        const reqUpdates = {
                            status: 'completed',
                            completed_at: firebase.firestore.FieldValue.serverTimestamp(),
                            timeline: newTimeline,
                            last_event_id: eventRef.id,
                            last_event_type: 'swap_completed',
                            updated_at: firebase.firestore.FieldValue.serverTimestamp()
                        };
                        if (isBorrowerConfirming) {
                            reqUpdates.borrower_confirmed_at = firebase.firestore.FieldValue.serverTimestamp();
                            reqUpdates.requester_confirmed_at = firebase.firestore.FieldValue.serverTimestamp();
                        } else {
                            reqUpdates.lender_confirmed_at = firebase.firestore.FieldValue.serverTimestamp();
                            reqUpdates.owner_confirmed_at = firebase.firestore.FieldValue.serverTimestamp();
                        }
                        if (requestData.item_id) {
                            const itemRef = db.collection('items').doc(requestData.item_id);
                            transaction.update(itemRef, {
                                status: 'completed',
                                is_available: false,
                                active_request_id: null
                            });
                        }

                        if (requestData.offered_item_id) {
                            const offeredRef = db.collection('items').doc(requestData.offered_item_id);
                            transaction.update(offeredRef, {
                                status: 'completed',
                                is_available: false,
                                active_request_id: null
                            });
                        }

                        transaction.update(requestRef, reqUpdates);

                        delete this.profilesCache[requestData.lender_id];
                        delete this.profilesCache[requestData.borrower_id];

                        const participants = [
                            { id: requestData.borrower_id, role: 'requester' },
                            { id: requestData.lender_id, role: 'owner' }
                        ];
                        for (const p of participants) {
                            const impactRef = db.collection('impact_events').doc();
                            transaction.set(impactRef, {
                                actor_id: user.uid,
                                beneficiary_id: p.id,
                                user_id: p.id,
                                role: p.role,
                                credit_kg: 2,
                                weight_kg: 2,
                                request_id: requestId,
                                item_id: requestData.item_id,
                                kind: 'swap',
                                created_at: firebase.firestore.FieldValue.serverTimestamp()
                            });
                        }

                        const participantIds = requestData.participant_ids || [requestData.borrower_id, requestData.lender_id];
                        transaction.set(eventRef, {
                            request_id: requestId,
                            transaction_type: 'swap',
                            item_id: requestData.item_id,
                            book_id: requestData.book_id || null,
                            offered_item_id: requestData.offered_item_id || null,
                            offered_book_id: requestData.offered_book_id || null,
                            circle_id: requestData.circle_id || null,
                            circle_ids: requestData.circle_ids || [],
                            actor_id: user.uid,
                            borrower_id: requestData.borrower_id,
                            lender_id: requestData.lender_id,
                            participant_ids: participantIds,
                            event_type: 'swap_completed',
                            from_status: 'approved',
                            to_status: 'completed',
                            fulfillment_method: requestData.fulfillment_method || 'pickup',
                            created_at: firebase.firestore.FieldValue.serverTimestamp()
                        });
                    } else {
                        const partialEventType = isBorrowerConfirming ? 'swap_confirmed_by_requester' : 'swap_confirmed_by_owner';
                        const newTimeline = [...existingTimeline, {
                            status: 'approved',
                            actor_id: user.uid,
                            event_type: partialEventType,
                            event_id: eventRef.id,
                            created_at: now
                        }];

                        const reqUpdates = {
                            timeline: newTimeline,
                            last_event_id: eventRef.id,
                            last_event_type: partialEventType,
                            updated_at: firebase.firestore.FieldValue.serverTimestamp()
                        };
                        if (isBorrowerConfirming) {
                            reqUpdates.borrower_confirmed_at = firebase.firestore.FieldValue.serverTimestamp();
                            reqUpdates.requester_confirmed_at = firebase.firestore.FieldValue.serverTimestamp();
                        } else {
                            reqUpdates.lender_confirmed_at = firebase.firestore.FieldValue.serverTimestamp();
                            reqUpdates.owner_confirmed_at = firebase.firestore.FieldValue.serverTimestamp();
                        }

                        transaction.update(requestRef, reqUpdates);

                        const participantIds = requestData.participant_ids || [requestData.borrower_id, requestData.lender_id];
                        transaction.set(eventRef, {
                            request_id: requestId,
                            transaction_type: 'swap',
                            item_id: requestData.item_id,
                            book_id: requestData.book_id || null,
                            offered_item_id: requestData.offered_item_id || null,
                            offered_book_id: requestData.offered_book_id || null,
                            circle_id: requestData.circle_id || null,
                            circle_ids: requestData.circle_ids || [],
                            actor_id: user.uid,
                            borrower_id: requestData.borrower_id,
                            lender_id: requestData.lender_id,
                            participant_ids: participantIds,
                            event_type: partialEventType,
                            from_status: 'approved',
                            to_status: 'approved',
                            fulfillment_method: requestData.fulfillment_method || 'pickup',
                            created_at: firebase.firestore.FieldValue.serverTimestamp()
                        });
                    }
                });
            } catch (err) {
                console.error("Error confirming swap exchange:", err);
                throw err;
            }
        },

        getUserAvailableItemsForSwap: async function(userId) {
            if (!userId) return [];
            try {
                const snap = await firebase.firestore().collection('items')
                    .where('owner_id', '==', userId)
                    .where('is_available', '==', true)
                    .get();

                return snap.docs
                    .map(d => ({ id: d.id, ...d.data() }))
                    .filter(item => !item.active_request_id && item.status !== 'transferred' && item.status !== 'completed');
            } catch (err) {
                console.error("Error getting user items for swap:", err);
                return [];
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

        sendMessage: async function(senderId, receiverId, itemIdOrOpts, content, requestIdOrOpts = null, explicitConvId = null) {
            try {
                let itemId = null;
                let requestId = null;
                let convId = explicitConvId;
                let bookId = null;

                if (typeof itemIdOrOpts === 'object' && itemIdOrOpts !== null) {
                    itemId = itemIdOrOpts.itemId || itemIdOrOpts.item_id || null;
                    requestId = itemIdOrOpts.requestId || itemIdOrOpts.request_id || null;
                    convId = itemIdOrOpts.conversationId || itemIdOrOpts.conversation_id || convId;
                    bookId = itemIdOrOpts.bookId || itemIdOrOpts.book_id || null;
                } else {
                    itemId = itemIdOrOpts || null;
                }

                if (typeof requestIdOrOpts === 'object' && requestIdOrOpts !== null) {
                    requestId = requestId || requestIdOrOpts.requestId || requestIdOrOpts.request_id || null;
                    convId = convId || requestIdOrOpts.conversationId || requestIdOrOpts.conversation_id || null;
                    bookId = bookId || requestIdOrOpts.bookId || requestIdOrOpts.book_id || null;
                } else if (typeof requestIdOrOpts === 'string') {
                    requestId = requestId || requestIdOrOpts;
                }

                if (!convId) {
                    if (requestId) {
                        convId = `tx_${requestId}`;
                    } else {
                        const sorted = [senderId, receiverId].sort();
                        convId = itemId ? `chat_${sorted[0]}_${sorted[1]}_${itemId}` : `direct_${sorted[0]}_${sorted[1]}`;
                    }
                }

                let circleId = null;
                let circleIds = [];
                if (itemId) {
                    try {
                        const itemDoc = await firebase.firestore().collection('items').doc(itemId).get();
                        if (itemDoc.exists) {
                            const itemData = itemDoc.data();
                            circleId = itemData.circle_id || null;
                            circleIds = itemData.circle_ids || [];
                            bookId = itemData.book_id || null;
                        }
                    } catch (e) {
                        console.warn("Could not load item metadata for message:", e);
                    }
                }
                if (requestId && (!bookId || !itemId)) {
                    try {
                        const reqDoc = await firebase.firestore().collection('requests').doc(requestId).get();
                        if (reqDoc.exists) {
                            const rData = reqDoc.data();
                            circleId = circleId || rData.circle_id || null;
                            circleIds = (circleIds.length > 0) ? circleIds : (rData.circle_ids || []);
                            bookId = bookId || rData.book_id || null;
                            itemId = itemId || rData.item_id || null;
                        }
                    } catch (e) {
                        console.warn("Could not load request metadata for message:", e);
                    }
                }

                const ref = await firebase.firestore().collection('messages').add({
                    sender_id: senderId,
                    receiver_id: receiverId,
                    item_id: itemId || null,
                    book_id: bookId || null,
                    request_id: requestId || null,
                    conversation_id: convId,
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

        subscribeToChatMessages: function(currentUserId, targetUserId, callback, opts = {}) {
            const db = firebase.firestore();
            const seenIds = new Set();
            const filterRequestId = typeof opts === 'string' ? opts : (opts ? (opts.requestId || opts.request_id || null) : null);
            const filterConvId = (typeof opts === 'object' && opts) ? (opts.conversationId || opts.conversation_id || null) : null;

            const handleSnapshot = (snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        if (seenIds.has(change.doc.id)) return;
                        const data = { id: change.doc.id, ...change.doc.data() };

                        // Scoping filter if requestId or conversationId is provided (Issue #19)
                        if (filterRequestId) {
                            if (data.request_id && data.request_id !== filterRequestId) return;
                            if (!data.request_id && data.conversation_id && !data.conversation_id.includes(filterRequestId)) return;
                        } else if (filterConvId) {
                            if (data.conversation_id && data.conversation_id !== filterConvId) return;
                        }

                        seenIds.add(change.doc.id);
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

        getInboxThreads: async function(userId) {
            try {
                const messages = await this.getInboxMessages(userId);
                if (!messages || messages.length === 0) {
                    return [];
                }

                const threadsMap = new Map();

                for (const msg of messages) {
                    const isSender = msg.sender_id === userId;
                    const partnerId = isSender ? msg.receiver_id : msg.sender_id;
                    const partnerProfile = isSender ? msg.receiver : msg.sender;

                    let threadKey;
                    let isTx = false;
                    let requestId = null;

                    if (msg.request_id) {
                        requestId = msg.request_id;
                        threadKey = `tx_${msg.request_id}`;
                        isTx = true;
                    } else if (msg.conversation_id && msg.conversation_id.startsWith('tx_')) {
                        requestId = msg.conversation_id.replace(/^tx_/, '');
                        threadKey = msg.conversation_id;
                        isTx = true;
                    } else if (msg.item_id) {
                        threadKey = `item_${partnerId}_${msg.item_id}`;
                    } else {
                        threadKey = `general_${partnerId}`;
                    }

                    if (!threadsMap.has(threadKey)) {
                        threadsMap.set(threadKey, {
                            id: threadKey,
                            threadKey: threadKey,
                            requestId: requestId,
                            isTransaction: isTx,
                            partnerId: partnerId,
                            partner: partnerProfile,
                            itemId: msg.item_id || null,
                            bookId: msg.book_id || null,
                            latestMessage: msg,
                            unreadCount: (!isSender && !msg.is_read) ? 1 : 0,
                            isUnread: (!isSender && !msg.is_read),
                            messages: [msg]
                        });
                    } else {
                        const existing = threadsMap.get(threadKey);
                        existing.messages.push(msg);
                        if (!isSender && !msg.is_read) {
                            existing.unreadCount = (existing.unreadCount || 0) + 1;
                            existing.isUnread = true;
                        }
                        if (!existing.itemId && msg.item_id) existing.itemId = msg.item_id;
                        if (!existing.bookId && msg.book_id) existing.bookId = msg.book_id;
                    }
                }

                const threads = Array.from(threadsMap.values());

                // Fetch metadata for transactions and items/books in parallel
                await Promise.all(threads.map(async (thread) => {
                    if (thread.requestId) {
                        try {
                            const reqDoc = await firebase.firestore().collection('requests').doc(thread.requestId).get();
                            if (reqDoc.exists) {
                                thread.request = { id: reqDoc.id, ...reqDoc.data() };
                                thread.status = thread.request.status;
                                thread.transactionType = thread.request.type || 'borrow';
                                thread.itemId = thread.itemId || thread.request.item_id;
                                thread.bookId = thread.bookId || thread.request.book_id;
                            }
                        } catch (err) {
                            console.warn('Could not fetch request for thread:', thread.requestId, err);
                        }
                    }

                    if (thread.itemId) {
                        try {
                            const itemData = await this.getItem(thread.itemId);
                            if (itemData) {
                                thread.item = itemData;
                                thread.itemName = itemData.name;
                                thread.itemImage = itemData.image_url;
                                thread.listingType = itemData.listing_type;
                                thread.bookId = thread.bookId || itemData.book_id;
                            }
                        } catch (err) {
                            console.warn('Could not fetch item for thread:', thread.itemId, err);
                        }
                    }

                    if (thread.bookId) {
                        try {
                            const bookData = await this.getBook(thread.bookId);
                            if (bookData) {
                                thread.book = bookData;
                                thread.bookTitle = bookData.title;
                                thread.bookAuthor = bookData.author || (Array.isArray(bookData.authors) ? bookData.authors.join(', ') : '');
                                thread.bookCover = bookData.cover_image_url || bookData.cover_image;
                            }
                        } catch (err) {
                            console.warn('Could not fetch book for thread:', thread.bookId, err);
                        }
                    }
                }));

                // Sort threads by latest message timestamp descending
                threads.sort((a, b) => {
                    const timeA = a.latestMessage?.created_at?.toDate ? a.latestMessage.created_at.toDate().getTime() : new Date(a.latestMessage?.created_at || 0).getTime();
                    const timeB = b.latestMessage?.created_at?.toDate ? b.latestMessage.created_at.toDate().getTime() : new Date(b.latestMessage?.created_at || 0).getTime();
                    return timeB - timeA;
                });

                return threads;
            } catch (err) {
                console.error("Error getting inbox threads:", err);
                return [];
            }
        },

        getCirclePosts: async function(circleId, opts = {}) {
            try {
                const isPaginated = !!(opts && (opts.paginated || opts.pageSize || opts.cursor));
                let query = firebase.firestore().collection('circle_posts')
                    .where('circle_id', '==', circleId)
                    .orderBy('created_at', 'desc');

                if (isPaginated) {
                    const pageSize = Math.max(1, Math.min(Number(opts.pageSize) || 10, 100));
                    if (opts.cursor) {
                        query = query.startAfter(opts.cursor);
                    }
                    query = query.limit(pageSize + 1);

                    const snapshot = await query.get();
                    const hasMore = snapshot.docs.length > pageSize;
                    const pagedDocs = hasMore ? snapshot.docs.slice(0, pageSize) : snapshot.docs;
                    const nextCursor = hasMore ? pagedDocs[pagedDocs.length - 1] : null;

                    const posts = pagedDocs.map(doc => ({ id: doc.id, ...doc.data() }));
                    await Promise.all(posts.map(async (post) => {
                        const profile = await this.getProfile(post.profile_id);
                        post.profiles = profile;
                    }));

                    return { posts, nextCursor, hasMore };
                }

                const snapshot = await query.get();
                const posts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
                // Fetch profiles in parallel
                await Promise.all(posts.map(async (post) => {
                    const profile = await this.getProfile(post.profile_id);
                    post.profiles = profile;
                }));
                
                // Sort by created_at descending (fallback for in-memory or legacy dates)
                posts.sort((a, b) => {
                    const dateA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                    const dateB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                    return dateB - dateA;
                });
                return posts;
            } catch (err) {
                console.error("Error getting circle posts:", err);
                if (opts && (opts.paginated || opts.pageSize || opts.cursor)) {
                    return { posts: [], nextCursor: null, hasMore: false };
                }
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
                let notifiedLenderId = null;
                let notifiedBorrowerId = null;
                let notifiedItemName = null;
                let notifiedCircleId = null;

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'approved') {
                        throw new Error("Request must be approved before pickup.");
                    }

                    const itemDoc = await transaction.get(itemRef);
                    if (!itemDoc.exists) throw new Error("Item not found");
                    const itemData = itemDoc.data();
                    notifiedLenderId = requestData.lender_id || itemData.owner_id;
                    notifiedBorrowerId = requestData.borrower_id;
                    notifiedItemName = itemData.name;
                    notifiedCircleId = requestData.circle_id || itemData.circle_id || null;

                    const eventRef = db.collection('transaction_events').doc();
                    const now = new Date();
                    const existingTimeline = Array.isArray(requestData.timeline) ? requestData.timeline : [];
                    const newTimeline = [...existingTimeline, {
                        status: 'borrowed',
                        actor_id: requestData.borrower_id,
                        event_type: 'picked_up',
                        event_id: eventRef.id,
                        created_at: now
                    }];

                    // Update request status to borrowed
                    transaction.update(requestRef, {
                        status: 'borrowed',
                        picked_up_at: firebase.firestore.FieldValue.serverTimestamp(),
                        timeline: newTimeline,
                        last_event_id: eventRef.id,
                        last_event_type: 'picked_up',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // Update item status to borrowed and is_available to false
                    transaction.update(itemRef, {
                        status: 'borrowed',
                        is_available: false
                    });

                    const participantIds = requestData.participant_ids || [requestData.borrower_id, requestData.lender_id || itemData.owner_id];
                    transaction.set(eventRef, {
                        request_id: requestId,
                        transaction_type: requestData.type || 'borrow',
                        item_id: itemId,
                        book_id: itemData.book_id || requestData.book_id || null,
                        offered_item_id: requestData.offered_item_id || null,
                        offered_book_id: requestData.offered_book_id || null,
                        circle_id: requestData.circle_id || itemData.circle_id || null,
                        circle_ids: requestData.circle_ids || itemData.circle_ids || [],
                        actor_id: requestData.borrower_id,
                        borrower_id: requestData.borrower_id,
                        lender_id: requestData.lender_id || itemData.owner_id,
                        participant_ids: participantIds,
                        event_type: 'picked_up',
                        from_status: 'approved',
                        to_status: 'borrowed',
                        fulfillment_method: requestData.fulfillment_method || 'pickup',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });

                try {
                    const currentUid = firebase.auth().currentUser?.uid;
                    const recipientId = currentUid === notifiedBorrowerId ? notifiedLenderId : notifiedBorrowerId;
                    if (recipientId) {
                        await this.dispatchNotification({
                            recipientId,
                            actorId: currentUid || null,
                            type: 'item_picked_up',
                            title: 'Item Picked Up',
                            body: `"${notifiedItemName || 'The book'}" has been marked as picked up.`,
                            actionUrl: `activity.html?request=${requestId}`,
                            requestId: requestId,
                            itemId: itemId,
                            circleId: notifiedCircleId
                        });
                    }
                } catch (notifErr) {
                    console.warn('[Notifications] Non-fatal notification error on item_picked_up:', notifErr);
                }
            } catch (err) {
                console.error("Error marking as picked up:", err);
                throw err;
            }
        },

        markShipped: async function(requestId, shippingInfo = {}) {
            try {
                const db = firebase.firestore();
                const user = firebase.auth().currentUser;
                if (!user) throw new Error("Authentication required.");
                const requestRef = db.collection('requests').doc(requestId);

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();

                    if (requestData.status !== 'approved') {
                        throw new Error(`Request must be approved before shipping (current status: ${requestData.status}).`);
                    }

                    const isLender = requestData.lender_id === user.uid;
                    const isBorrower = requestData.borrower_id === user.uid;
                    if (!isLender && !isBorrower) {
                        throw new Error("Only transaction participants can mark as shipped.");
                    }

                    const eventRef = db.collection('transaction_events').doc();
                    const now = new Date();
                    const existingTimeline = Array.isArray(requestData.timeline) ? requestData.timeline : [];
                    const newTimeline = [...existingTimeline, {
                        status: 'shipped',
                        actor_id: user.uid,
                        event_type: 'shipped',
                        event_id: eventRef.id,
                        created_at: now
                    }];

                    const reqUpdates = {
                        status: 'shipped',
                        shipped_at: firebase.firestore.FieldValue.serverTimestamp(),
                        timeline: newTimeline,
                        last_event_id: eventRef.id,
                        last_event_type: 'shipped',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    };

                    if (shippingInfo.tracking_number) {
                        reqUpdates.tracking_number = String(shippingInfo.tracking_number).trim();
                    }
                    if (shippingInfo.carrier) {
                        reqUpdates.carrier = String(shippingInfo.carrier).trim();
                    }

                    if (requestData.item_id) {
                        const itemRef = db.collection('items').doc(requestData.item_id);
                        transaction.update(itemRef, {
                            status: 'shipped',
                            is_available: false
                        });
                    }

                    if (requestData.offered_item_id) {
                        const offeredRef = db.collection('items').doc(requestData.offered_item_id);
                        transaction.update(offeredRef, {
                            status: 'shipped',
                            is_available: false
                        });
                    }

                    transaction.update(requestRef, reqUpdates);

                    const participantIds = requestData.participant_ids || [requestData.borrower_id, requestData.lender_id];
                    transaction.set(eventRef, {
                        request_id: requestId,
                        transaction_type: requestData.type || 'borrow',
                        item_id: requestData.item_id,
                        book_id: requestData.book_id || null,
                        offered_item_id: requestData.offered_item_id || null,
                        offered_book_id: requestData.offered_book_id || null,
                        circle_id: requestData.circle_id || null,
                        circle_ids: requestData.circle_ids || [],
                        actor_id: user.uid,
                        borrower_id: requestData.borrower_id,
                        lender_id: requestData.lender_id,
                        participant_ids: participantIds,
                        event_type: 'shipped',
                        from_status: 'approved',
                        to_status: 'shipped',
                        fulfillment_method: requestData.fulfillment_method || 'shipping',
                        metadata: {
                            carrier: reqUpdates.carrier || null,
                            tracking_number: reqUpdates.tracking_number || null
                        },
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });
            } catch (err) {
                console.error("Error marking as shipped:", err);
                throw err;
            }
        },

        markDelivered: async function(requestId) {
            try {
                const db = firebase.firestore();
                const user = firebase.auth().currentUser;
                if (!user) throw new Error("Authentication required.");
                const requestRef = db.collection('requests').doc(requestId);

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();

                    if (requestData.status !== 'shipped') {
                        throw new Error(`Item must be shipped before delivery (current status: ${requestData.status}).`);
                    }

                    const isLender = requestData.lender_id === user.uid;
                    const isBorrower = requestData.borrower_id === user.uid;
                    if (!isLender && !isBorrower) {
                        throw new Error("Only transaction participants can mark as delivered.");
                    }

                    const eventRef = db.collection('transaction_events').doc();
                    const now = new Date();
                    const existingTimeline = Array.isArray(requestData.timeline) ? requestData.timeline : [];
                    const newTimeline = [...existingTimeline, {
                        status: 'delivered',
                        actor_id: user.uid,
                        event_type: 'delivered',
                        event_id: eventRef.id,
                        created_at: now
                    }];

                    if (requestData.item_id) {
                        const itemRef = db.collection('items').doc(requestData.item_id);
                        transaction.update(itemRef, {
                            status: 'delivered',
                            is_available: false
                        });
                    }

                    if (requestData.offered_item_id) {
                        const offeredRef = db.collection('items').doc(requestData.offered_item_id);
                        transaction.update(offeredRef, {
                            status: 'delivered',
                            is_available: false
                        });
                    }

                    transaction.update(requestRef, {
                        status: 'delivered',
                        delivered_at: firebase.firestore.FieldValue.serverTimestamp(),
                        timeline: newTimeline,
                        last_event_id: eventRef.id,
                        last_event_type: 'delivered',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    const participantIds = requestData.participant_ids || [requestData.borrower_id, requestData.lender_id];
                    transaction.set(eventRef, {
                        request_id: requestId,
                        transaction_type: requestData.type || 'borrow',
                        item_id: requestData.item_id,
                        book_id: requestData.book_id || null,
                        offered_item_id: requestData.offered_item_id || null,
                        offered_book_id: requestData.offered_book_id || null,
                        circle_id: requestData.circle_id || null,
                        circle_ids: requestData.circle_ids || [],
                        actor_id: user.uid,
                        borrower_id: requestData.borrower_id,
                        lender_id: requestData.lender_id,
                        participant_ids: participantIds,
                        event_type: 'delivered',
                        from_status: 'shipped',
                        to_status: 'delivered',
                        fulfillment_method: requestData.fulfillment_method || 'shipping',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });
            } catch (err) {
                console.error("Error marking as delivered:", err);
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
                    if (requestData.status !== 'borrowed' && requestData.status !== 'delivered') {
                        throw new Error("Only borrowed or delivered items can be marked as returned.");
                    }

                    const itemRef = db.collection('items').doc(requestData.item_id);
                    const itemDoc = await transaction.get(itemRef);
                    const itemData = itemDoc.exists ? itemDoc.data() : {};

                    const eventRef = db.collection('transaction_events').doc();
                    const now = new Date();
                    const existingTimeline = Array.isArray(requestData.timeline) ? requestData.timeline : [];
                    const newTimeline = [...existingTimeline, {
                        status: 'returned',
                        actor_id: requestData.borrower_id,
                        event_type: 'returned',
                        event_id: eventRef.id,
                        created_at: now
                    }];

                    // Update request status to returned
                    transaction.update(requestRef, {
                        status: 'returned',
                        returned_at: firebase.firestore.FieldValue.serverTimestamp(),
                        timeline: newTimeline,
                        last_event_id: eventRef.id,
                        last_event_type: 'returned',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // Update item status to returned (if it exists)
                    if (itemDoc.exists) {
                        transaction.update(itemRef, {
                            status: 'returned'
                        });
                    }

                    const participantIds = requestData.participant_ids || [requestData.borrower_id, requestData.lender_id || itemData.owner_id];
                    transaction.set(eventRef, {
                        request_id: requestId,
                        transaction_type: requestData.type || 'borrow',
                        item_id: requestData.item_id,
                        book_id: itemData.book_id || requestData.book_id || null,
                        offered_item_id: requestData.offered_item_id || null,
                        offered_book_id: requestData.offered_book_id || null,
                        circle_id: requestData.circle_id || itemData.circle_id || null,
                        circle_ids: requestData.circle_ids || itemData.circle_ids || [],
                        actor_id: requestData.borrower_id,
                        borrower_id: requestData.borrower_id,
                        lender_id: requestData.lender_id || itemData.owner_id,
                        participant_ids: participantIds,
                        event_type: 'returned',
                        from_status: 'borrowed',
                        to_status: 'returned',
                        fulfillment_method: requestData.fulfillment_method || 'pickup',
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
                let completedItemId = null;
                let completedCircleId = null;
                let notifiedBorrowerId = null;
                let notifiedItemName = null;

                await db.runTransaction(async (transaction) => {
                    const requestDoc = await transaction.get(requestRef);
                    if (!requestDoc.exists) throw new Error("Request not found");
                    const requestData = requestDoc.data();
                    if (requestData.status !== 'returned') {
                        throw new Error("Return must be marked by borrower before confirmation.");
                    }
                    completedItemId = requestData.item_id;
                    completedCircleId = requestData.circle_id || null;
                    notifiedBorrowerId = requestData.borrower_id;
                    notifiedItemName = requestData.item_name || 'the book';

                    const eventRef = db.collection('transaction_events').doc();
                    const now = new Date();
                    const existingTimeline = Array.isArray(requestData.timeline) ? requestData.timeline : [];
                    const newTimeline = [...existingTimeline, {
                        status: 'completed',
                        actor_id: requestData.lender_id,
                        event_type: 'borrow_completed',
                        event_id: eventRef.id,
                        created_at: now
                    }];

                    // Set request completed
                    transaction.update(requestRef, {
                        status: 'completed',
                        completed_at: firebase.firestore.FieldValue.serverTimestamp(),
                        timeline: newTimeline,
                        last_event_id: eventRef.id,
                        last_event_type: 'borrow_completed',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
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

                    const participantIds = requestData.participant_ids || [requestData.borrower_id, requestData.lender_id];
                    transaction.set(eventRef, {
                        request_id: requestId,
                        transaction_type: requestData.type || 'borrow',
                        item_id: requestData.item_id,
                        book_id: requestData.book_id || null,
                        offered_item_id: requestData.offered_item_id || null,
                        offered_book_id: requestData.offered_book_id || null,
                        circle_id: requestData.circle_id || null,
                        circle_ids: requestData.circle_ids || [],
                        actor_id: user.uid,
                        borrower_id: requestData.borrower_id,
                        lender_id: requestData.lender_id,
                        participant_ids: participantIds,
                        event_type: 'borrow_completed',
                        from_status: 'returned',
                        to_status: 'completed',
                        fulfillment_method: requestData.fulfillment_method || 'pickup',
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });

                // Ledger writes are outside the transaction so a credit-write
                // failure can never roll back a confirmed return.
                await Promise.all(ledgerWrites.map(w => w.ref.set(w.data)));

                await this.logAnalyticsEvent('transaction_completed', {
                    request_id: requestId,
                    item_id: completedItemId,
                    circle_id: completedCircleId,
                    status: 'completed'
                });

                try {
                    if (notifiedBorrowerId) {
                        await this.dispatchNotification({
                            recipientId: notifiedBorrowerId,
                            actorId: user.uid,
                            type: 'transaction_completed',
                            title: 'Return Confirmed',
                            body: `Return confirmed for "${notifiedItemName}". Thank you for sharing!`,
                            actionUrl: `activity.html?request=${requestId}`,
                            requestId: requestId,
                            itemId: completedItemId,
                            circleId: completedCircleId
                        });
                    }
                } catch (notifErr) {
                    console.warn('[Notifications] Non-fatal notification error on transaction_completed:', notifErr);
                }

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

                    const eventRef = db.collection('transaction_events').doc();
                    const now = new Date();
                    const existingTimeline = Array.isArray(requestData.timeline) ? requestData.timeline : [];
                    const newTimeline = [...existingTimeline, {
                        status: 'completed',
                        actor_id: user.uid,
                        event_type: 'giveaway_completed',
                        event_id: eventRef.id,
                        created_at: now
                    }];

                    transaction.update(requestRef, {
                        status: 'completed',
                        completed_at: firebase.firestore.FieldValue.serverTimestamp(),
                        timeline: newTimeline,
                        last_event_id: eventRef.id,
                        last_event_type: 'giveaway_completed',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
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

                    const participantIds = requestData.participant_ids || [requestData.borrower_id, requestData.lender_id];
                    transaction.set(eventRef, {
                        request_id: requestId,
                        transaction_type: 'giveaway',
                        item_id: requestData.item_id,
                        book_id: requestData.book_id || null,
                        offered_item_id: null,
                        offered_book_id: null,
                        circle_id: requestData.circle_id || null,
                        circle_ids: requestData.circle_ids || [],
                        actor_id: user.uid,
                        borrower_id: requestData.borrower_id,
                        lender_id: requestData.lender_id,
                        participant_ids: participantIds,
                        event_type: 'giveaway_completed',
                        from_status: requestData.status,
                        to_status: 'completed',
                        fulfillment_method: requestData.fulfillment_method || 'pickup',
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

        markMessagesAsRead: async function(currentUserId, targetUserId, requestIdOrOpts = null) {
            try {
                const reqId = typeof requestIdOrOpts === 'string' ? requestIdOrOpts : (requestIdOrOpts ? (requestIdOrOpts.requestId || requestIdOrOpts.request_id || null) : null);
                const snap = await firebase.firestore().collection('messages')
                    .where('sender_id', '==', targetUserId)
                    .where('receiver_id', '==', currentUserId)
                    .where('is_read', '==', false)
                    .get();
                
                const batch = firebase.firestore().batch();
                snap.docs.forEach(doc => {
                    const data = doc.data();
                    if (reqId) {
                        const matchesReq = (data.request_id === reqId) || (data.conversation_id && data.conversation_id.includes(reqId));
                        if (!matchesReq) return;
                    }
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

        getImpactLeaderboard: async function(opts = {}) {
            try {
                const pageSize = Math.max(1, Math.min(Number(opts && opts.pageSize) || 20, 100));
                let query = firebase.firestore().collection('profiles')
                    .orderBy('carbon_saved_kg', 'desc');

                if (opts && opts.cursor) {
                    query = query.startAfter(opts.cursor);
                }
                query = query.limit(pageSize + 1);

                const snapshot = await query.get();
                const hasMore = snapshot.docs.length > pageSize;
                const pagedDocs = hasMore ? snapshot.docs.slice(0, pageSize) : snapshot.docs;
                const nextCursor = hasMore ? pagedDocs[pagedDocs.length - 1] : null;

                const leaderboard = await Promise.all(pagedDocs.map(async (doc) => {
                    const data = doc.data();
                    let creditKg = typeof data.carbon_saved_kg === 'number' ? data.carbon_saved_kg : 0;
                    try {
                        const summary = await this.getImpactSummary(doc.id);
                        if (summary && summary.credit_kg > 0) creditKg = summary.credit_kg;
                    } catch (_) {}

                    return {
                        id: doc.id,
                        full_name: data.full_name || 'Neighbor',
                        avatar_url: data.avatar_url || `https://i.pravatar.cc/150?u=${doc.id}`,
                        carbon_saved_kg: creditKg,
                        reputation_score: typeof data.reputation_score === 'number' ? data.reputation_score : 5.0,
                        bio: data.bio || '',
                        location: data.location || ''
                    };
                }));

                return {
                    leaderboard,
                    nextCursor,
                    hasMore
                };
            } catch (err) {
                console.error("Error getting impact leaderboard:", err);
                return { leaderboard: [], nextCursor: null, hasMore: false };
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
        },

        // ── Canonical Books Catalog (Universal Library) ──────────────────────
        cleanIsbn: function(raw) {
            if (!raw || typeof raw !== 'string') return '';
            return raw.replace(/[^0-9X]/gi, '').toUpperCase();
        },

        isValidIsbn10: function(str) {
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
        },

        isValidIsbn13: function(str) {
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
        },

        isbn10ToIsbn13: function(isbn10) {
            const cleaned = this.cleanIsbn(isbn10);
            if (!this.isValidIsbn10(cleaned)) return null;
            const base = '978' + cleaned.substring(0, 9);
            let sum = 0;
            for (let i = 0; i < 12; i++) {
                const digit = parseInt(base[i], 10);
                sum += i % 2 === 0 ? digit : digit * 3;
            }
            const checkDigit = (10 - (sum % 10)) % 10;
            return base + checkDigit.toString();
        },

        isbn13ToIsbn10: function(isbn13) {
            const cleaned = this.cleanIsbn(isbn13);
            if (!this.isValidIsbn13(cleaned)) return null;
            if (!cleaned.startsWith('978')) return null;
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
        },

        normalizeIsbn: function(raw) {
            const cleaned = this.cleanIsbn(raw);
            let isbn10 = null;
            let isbn13 = null;
            let valid = false;

            if (cleaned.length === 10 && this.isValidIsbn10(cleaned)) {
                valid = true;
                isbn10 = cleaned;
                isbn13 = this.isbn10ToIsbn13(cleaned);
            } else if (cleaned.length === 13 && this.isValidIsbn13(cleaned)) {
                valid = true;
                isbn13 = cleaned;
                isbn10 = this.isbn13ToIsbn10(cleaned);
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
        },

        normalizeTitle: function(raw) {
            if (!raw || typeof raw !== 'string') return '';
            let text = raw.trim().toLowerCase();
            text = text.replace(/^(the|a|an)\s+/i, '');
            text = text.replace(/[^\p{L}\p{N}\s]/gu, ' ');
            text = text.replace(/\s+/g, ' ').trim();
            return text;
        },

        normalizeAuthor: function(raw) {
            if (!raw || typeof raw !== 'string') return '';
            let text = raw.trim().toLowerCase();
            text = text.replace(/[^\p{L}\p{N}\s]/gu, '');
            text = text.replace(/\s+/g, ' ').trim();
            return text;
        },

        normalizeAuthors: function(authors) {
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
                const norm = this.normalizeAuthor(trimmed);
                if (norm && !normalizedAuthors.includes(norm)) {
                    normalizedAuthors.push(norm);
                }
                const tokens = norm.split(/\s+/).filter(t => t.length > 1);
                for (const tok of tokens) {
                    if (!normalizedAuthors.includes(tok)) {
                        normalizedAuthors.push(tok);
                    }
                }
            }

            return {
                authors: cleanedAuthors,
                authors_normalized: normalizedAuthors
            };
        },

        getBookCopiesStatus: function(book) {
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
                    ctaUrl: bookId ? '/add-item.html?book_id=' + encodeURIComponent(bookId) : '/add-item.html'
                };
            }

            if (availableCopies === 0) {
                return {
                    hasCopies: true,
                    totalCopies,
                    availableCopies: 0,
                    badge: 'All copies in use',
                    badgeClass: 'bg-amber-100 text-amber-800 border border-amber-200',
                    message: totalCopies + ' copy in circulation, currently checked out.',
                    actionLabel: 'Add to Want List',
                    ctaUrl: bookId ? 'book-detail.html?id=' + encodeURIComponent(bookId) + '#want' : '#'
                };
            }

            return {
                hasCopies: true,
                totalCopies,
                availableCopies,
                badge: availableCopies + ' available',
                badgeClass: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
                message: availableCopies + ' of ' + totalCopies + ' copies ready to borrow or swap.',
                actionLabel: 'View Copies',
                ctaUrl: bookId ? 'book-detail.html?id=' + encodeURIComponent(bookId) : '#'
            };
        },

        getBook: async function(bookId, opts = {}) {
            if (!bookId) return null;
            try {
                const doc = await firebase.firestore().collection('books').doc(bookId).get();
                if (!doc.exists) return null;
                const data = doc.data();
                if (data.is_merged && data.merged_into && !opts?.skipFollowMerge) {
                    const merged = await this.getBook(data.merged_into);
                    if (merged) {
                        return { ...merged, _redirected_from: bookId };
                    }
                }
                return { id: doc.id, ...data };
            } catch (err) {
                console.error('Error fetching canonical book:', err);
                return null;
            }
        },

        findBook: async function({ isbn, title, author } = {}) {
            try {
                const normIsbn = this.normalizeIsbn(isbn || '');
                const normTitle = this.normalizeTitle(title || '');
                const { authors_normalized } = this.normalizeAuthors(author || []);

                // 1. Direct ID lookup if ISBN-13 is valid
                if (normIsbn.valid && normIsbn.isbn13) {
                    const directDoc = await firebase.firestore().collection('books').doc('isbn_' + normIsbn.isbn13).get();
                    if (directDoc.exists) {
                        return { id: directDoc.id, ...directDoc.data() };
                    }
                }

                // 2. Query by ISBN in isbns array
                if (normIsbn.isbns.length > 0) {
                    for (const code of normIsbn.isbns) {
                        const snap = await firebase.firestore().collection('books')
                            .where('isbns', 'array-contains', code)
                            .limit(1)
                            .get();
                        if (!snap.empty) {
                            return { id: snap.docs[0].id, ...snap.docs[0].data() };
                        }
                    }
                }

                // 3. Query by normalized title
                if (normTitle) {
                    const snap = await firebase.firestore().collection('books')
                        .where('title_normalized', '==', normTitle)
                        .limit(10)
                        .get();

                    if (!snap.empty) {
                        if (authors_normalized.length > 0) {
                            for (const doc of snap.docs) {
                                const data = doc.data();
                                const existingNorm = data.authors_normalized || [];
                                if (authors_normalized.some(a => existingNorm.includes(a))) {
                                    return { id: doc.id, ...data };
                                }
                            }
                        } else {
                            return { id: snap.docs[0].id, ...snap.docs[0].data() };
                        }
                    }
                }

                return null;
            } catch (err) {
                console.error('Error finding book:', err);
                return null;
            }
        },

        createBook: async function(bookData) {
            const user = firebase.auth().currentUser;
            if (!user) throw new Error('User must be logged in to add a book.');

            if (!bookData.title || typeof bookData.title !== 'string' || !bookData.title.trim()) {
                throw new Error('Book title is required.');
            }

            const title = bookData.title.trim();
            const title_normalized = this.normalizeTitle(title);
            const { authors, authors_normalized } = this.normalizeAuthors(bookData.authors || []);
            const normIsbn = this.normalizeIsbn(bookData.isbn || bookData.isbn_13 || bookData.isbn_10 || '');

            const isbns = [...normIsbn.isbns];
            if (Array.isArray(bookData.isbns)) {
                for (const raw of bookData.isbns) {
                    const c = this.cleanIsbn(raw);
                    if (c && !isbns.includes(c)) isbns.push(c);
                }
            }

            const publishedYear = bookData.published_year ? parseInt(bookData.published_year, 10) : null;

            const docId = normIsbn.valid && normIsbn.isbn13 
                ? 'isbn_' + normIsbn.isbn13 
                : firebase.firestore().collection('books').doc().id;

            const payload = {
                title,
                title_normalized,
                authors,
                authors_normalized,
                isbn_10: normIsbn.isbn10 || bookData.isbn_10 || null,
                isbn_13: normIsbn.isbn13 || bookData.isbn_13 || null,
                isbns,
                publisher: bookData.publisher ? String(bookData.publisher).trim() : null,
                published_year: !isNaN(publishedYear) ? publishedYear : null,
                language: bookData.language ? String(bookData.language).trim().toLowerCase() : 'en',
                cover_url: bookData.cover_url ? String(bookData.cover_url).trim() : null,
                description: bookData.description ? String(bookData.description).trim() : null,
                source_identifiers: bookData.source_identifiers && typeof bookData.source_identifiers === 'object'
                    ? bookData.source_identifiers
                    : {},
                copies_count: typeof bookData.copies_count === 'number' && bookData.copies_count >= 0 ? bookData.copies_count : 0,
                available_copies_count: typeof bookData.available_copies_count === 'number' && bookData.available_copies_count >= 0 
                    ? bookData.available_copies_count 
                    : 0,
                circle_ids: Array.isArray(bookData.circle_ids) ? bookData.circle_ids : (bookData.circle_id ? [bookData.circle_id] : []),
                created_by: user.uid,
                created_at: firebase.firestore.FieldValue.serverTimestamp(),
                updated_at: firebase.firestore.FieldValue.serverTimestamp()
            };

            const docRef = firebase.firestore().collection('books').doc(docId);
            await docRef.set(payload);

            const resultBook = {
                id: docId,
                ...payload
            };
            try {
                await this.syncBookToSearchIndex(docId, resultBook);
            } catch (syncErr) {
                console.warn('[Typesense] Non-blocking search sync dispatch error:', syncErr);
            }
            return resultBook;
        },

        findOrCreateBook: async function(bookData) {
            const existing = await this.findBook({
                isbn: bookData.isbn || bookData.isbn_13 || bookData.isbn_10,
                title: bookData.title,
                author: bookData.authors || bookData.author
            });

            if (existing) {
                return {
                    created: false,
                    book: existing,
                    copiesStatus: this.getBookCopiesStatus(existing)
                };
            }

            const newBook = await this.createBook(bookData);
            return {
                created: true,
                book: newBook,
                copiesStatus: this.getBookCopiesStatus(newBook)
            };
        },

        // ==========================================
        // Typesense Search Integration (Issue #23)
        // ==========================================
        _typesenseMockIndex: new Map(),
        _typesenseStatus: {
            provider: 'firestore',
            isHealthy: true,
            lastSyncAt: null,
            totalIndexed: 0,
            failuresCount: 0
        },

        getTypesenseConfig: function() {
            const env = (typeof window !== 'undefined' && window.ENV) || (typeof global !== 'undefined' && global.ENV) || {};
            const forceEnabled = (typeof window !== 'undefined' && Boolean(window.TYPESENSE_FORCE_ENABLED));
            const flagEnabled = this.isFeatureEnabled('typesense_search') || forceEnabled;
            const hasApiKey = Boolean(env.TYPESENSE_API_KEY);
            const rawThreshold = (typeof window !== 'undefined' && window.TYPESENSE_THRESHOLD !== undefined)
                ? window.TYPESENSE_THRESHOLD
                : env.TYPESENSE_THRESHOLD;
            const threshold = Number(rawThreshold) || 50;
            return {
                host: env.TYPESENSE_HOST || 'localhost',
                port: env.TYPESENSE_PORT || 8108,
                protocol: env.TYPESENSE_PROTOCOL || 'http',
                apiKey: env.TYPESENSE_API_KEY || (flagEnabled ? 'mock-typesense-key' : null),
                threshold: threshold,
                enabled: Boolean(hasApiKey || flagEnabled)
            };
        },

        isTypesenseEnabled: function() {
            const config = this.getTypesenseConfig();
            return config.enabled;
        },

        _levenshteinDistance: function(a, b) {
            if (!a || !b) return (a || '').length + (b || '').length;
            const matrix = [];
            for (let i = 0; i <= b.length; i++) matrix[i] = [i];
            for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
            for (let i = 1; i <= b.length; i++) {
                for (let j = 1; j <= a.length; j++) {
                    if (b.charAt(i - 1) === a.charAt(j - 1)) {
                        matrix[i][j] = matrix[i - 1][j - 1];
                    } else {
                        matrix[i][j] = Math.min(
                            matrix[i - 1][j - 1] + 1,
                            matrix[i][j - 1] + 1,
                            matrix[i - 1][j] + 1
                        );
                    }
                }
            }
            return matrix[b.length][a.length];
        },

        _matchDocumentTypesense: function(doc, queryTokens) {
            let totalScore = 0;
            const title = (doc.title || '').toLowerCase();
            const authors = (Array.isArray(doc.authors) ? doc.authors.join(' ') : (doc.author || '')).toLowerCase();
            const isbns = (Array.isArray(doc.isbns) ? doc.isbns.join(' ') : '').toLowerCase();
            const desc = (doc.description || '').toLowerCase();

            for (const token of queryTokens) {
                let tokenMatched = false;
                let tokenScore = 0;

                if (isbns.includes(token)) {
                    tokenScore = Math.max(tokenScore, 100);
                    tokenMatched = true;
                }
                if (title === token) {
                    tokenScore = Math.max(tokenScore, 90);
                    tokenMatched = true;
                } else if (title.includes(token)) {
                    tokenScore = Math.max(tokenScore, 70);
                    tokenMatched = true;
                } else {
                    const titleWords = title.split(/\s+/);
                    for (const w of titleWords) {
                        if (w.length >= 3 && token.length >= 3) {
                            const dist = this._levenshteinDistance(w, token);
                            if (dist <= 1) {
                                tokenScore = Math.max(tokenScore, 50);
                                tokenMatched = true;
                                break;
                            } else if (dist <= 2 && w.length >= 5 && token.length >= 5) {
                                tokenScore = Math.max(tokenScore, 35);
                                tokenMatched = true;
                                break;
                            }
                        }
                    }
                }

                if (authors.includes(token)) {
                    tokenScore = Math.max(tokenScore, 60);
                    tokenMatched = true;
                } else {
                    const authorWords = authors.split(/\s+/);
                    for (const w of authorWords) {
                        if (w.length >= 3 && token.length >= 3) {
                            const dist = this._levenshteinDistance(w, token);
                            if (dist <= 1) {
                                tokenScore = Math.max(tokenScore, 40);
                                tokenMatched = true;
                                break;
                            }
                        }
                    }
                }

                if (desc.includes(token)) {
                    tokenScore = Math.max(tokenScore, 20);
                    tokenMatched = true;
                }

                if (!tokenMatched) return { matched: false, score: 0 };
                totalScore += tokenScore;
            }

            if (doc.available_copies_count > 0) {
                totalScore += Math.min(doc.available_copies_count * 2, 20);
            }

            return { matched: true, score: totalScore };
        },

        syncBookToSearchIndex: async function(bookId, bookData = null) {
            try {
                if (!bookId) return null;
                const db = firebase.firestore();

                let data = bookData;
                if (!data) {
                    const bDoc = await db.collection('books').doc(bookId).get();
                    if (!bDoc.exists) {
                        this._typesenseMockIndex.delete(bookId);
                        return null;
                    }
                    data = bDoc.data();
                }

                if (data.is_merged) {
                    this._typesenseMockIndex.delete(bookId);
                    return null;
                }

                const copiesSnap = await db.collection('items')
                    .where('book_id', '==', bookId)
                    .get();

                const activeCopies = copiesSnap.docs
                    .map(d => ({ id: d.id, ...d.data() }))
                    .filter(c => !c.is_withdrawn && c.status !== 'withdrawn');

                const availableCopies = activeCopies.filter(c => c.is_available && c.status === 'available');
                const copyCircleIds = activeCopies.map(c => c.circle_id).filter(Boolean);
                const bookCircleIds = Array.isArray(data.circle_ids) ? data.circle_ids : (data.circle_id ? [data.circle_id] : []);
                const circleIds = [...new Set([...copyCircleIds, ...bookCircleIds])];

                const totalCopies = activeCopies.length > 0 ? activeCopies.length : (Number(data.copies_count) || 0);
                const availCopies = activeCopies.length > 0 ? availableCopies.length : (Number(data.available_copies_count) || 0);

                const searchDoc = {
                    id: bookId,
                    title: data.title || '',
                    title_normalized: data.title_normalized || (data.title ? this.normalizeTitle(data.title) : ''),
                    authors: Array.isArray(data.authors) ? data.authors : (data.author ? [data.author] : []),
                    isbns: Array.isArray(data.isbns) ? data.isbns : [],
                    isbn10: data.isbn_10 || data.isbn10 || '',
                    isbn13: data.isbn_13 || data.isbn13 || '',
                    description: data.description || '',
                    cover_url: data.cover_url || '',
                    published_year: Number(data.published_year) || 0,
                    categories: Array.isArray(data.categories) ? data.categories : (data.category ? [data.category] : []),
                    copies_count: totalCopies,
                    available_copies_count: availCopies,
                    circle_ids: circleIds,
                    updated_at: Date.now()
                };

                this._typesenseMockIndex.set(bookId, searchDoc);
                this._typesenseStatus.totalIndexed = this._typesenseMockIndex.size;
                this._typesenseStatus.lastSyncAt = new Date().toISOString();

                const config = this.getTypesenseConfig();
                if (config.apiKey && config.apiKey !== 'mock-typesense-key' && typeof fetch !== 'undefined') {
                    const url = `${config.protocol}://${config.host}:${config.port}/collections/books/documents/import?action=upsert`;
                    await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-TYPESENSE-API-KEY': config.apiKey
                        },
                        body: JSON.stringify(searchDoc)
                    });
                }

                return searchDoc;
            } catch (err) {
                console.warn(`[Typesense] Non-fatal sync error for book ${bookId}:`, err);
                this._typesenseStatus.failuresCount = (this._typesenseStatus.failuresCount || 0) + 1;
                return null;
            }
        },

        removeBookFromSearchIndex: async function(bookId) {
            try {
                this._typesenseMockIndex.delete(bookId);
                this._typesenseStatus.totalIndexed = this._typesenseMockIndex.size;
            } catch (err) {
                console.warn(`[Typesense] Non-fatal delete error for book ${bookId}:`, err);
            }
        },

        searchBooksTypesense: async function({ query, limit = 20, circle_id = null, available_only = false } = {}) {
            if (!query || typeof query !== 'string') return [];
            const clean = query.trim().toLowerCase();
            if (!clean) return [];

            const queryTokens = clean.split(/\s+/).filter(Boolean);
            const matches = [];

            for (const [id, doc] of this._typesenseMockIndex.entries()) {
                if (circle_id && !doc.circle_ids.includes(circle_id)) continue;
                if (available_only && doc.available_copies_count <= 0) continue;

                const { matched, score } = this._matchDocumentTypesense(doc, queryTokens);
                if (matched) {
                    matches.push({
                        ...doc,
                        _score: score,
                        searchProvider: 'typesense',
                        copiesStatus: {
                            totalCount: doc.copies_count,
                            availableCount: doc.available_copies_count,
                            hasAvailableCopies: doc.available_copies_count > 0,
                            summaryBadge: doc.available_copies_count > 0
                                ? `${doc.available_copies_count} Available`
                                : (doc.copies_count > 0 ? 'All Copies Borrowed' : 'No Copies Listed')
                        }
                    });
                }
            }

            matches.sort((a, b) => {
                if (b._score !== a._score) return b._score - a._score;
                return b.available_copies_count - a.available_copies_count;
            });

            return matches.slice(0, limit);
        },

        reindexCatalogToTypesense: async function({ batchSize = 50 } = {}) {
            const startTime = Date.now();
            let totalIndexed = 0;
            let totalErrors = 0;

            try {
                const db = firebase.firestore();
                const snapshot = await db.collection('books').get();

                for (const doc of snapshot.docs) {
                    try {
                        const data = doc.data();
                        if (data.is_merged) continue;
                        await this.syncBookToSearchIndex(doc.id, data);
                        totalIndexed++;
                    } catch (err) {
                        totalErrors++;
                        console.warn(`Error indexing book ${doc.id}:`, err);
                    }
                }

                this._typesenseStatus.provider = 'typesense';
                this._typesenseStatus.isHealthy = true;
                this._typesenseStatus.lastSyncAt = new Date().toISOString();
                this._typesenseStatus.totalIndexed = totalIndexed;

                return {
                    success: true,
                    totalIndexed,
                    totalErrors,
                    durationMs: Date.now() - startTime,
                    timestamp: this._typesenseStatus.lastSyncAt
                };
            } catch (fatalErr) {
                console.error("Fatal error during reindexCatalogToTypesense:", fatalErr);
                return {
                    success: false,
                    totalIndexed,
                    totalErrors: totalErrors + 1,
                    durationMs: Date.now() - startTime,
                    error: fatalErr.message
                };
            }
        },

        getSearchServiceStatus: function() {
            const config = this.getTypesenseConfig();
            return {
                enabled: config.enabled,
                threshold: config.threshold,
                totalIndexed: this._typesenseMockIndex.size,
                isHealthy: this._typesenseStatus.isHealthy,
                provider: (config.enabled && this._typesenseStatus.isHealthy) ? 'typesense' : 'firestore',
                lastSyncAt: this._typesenseStatus.lastSyncAt,
                failuresCount: this._typesenseStatus.failuresCount || 0
            };
        },

        searchBooks: async function({ query, limit = 20, forceFallback = false, circle_id = null, available_only = false } = {}) {
            if (!query || typeof query !== 'string') return [];
            const clean = query.trim();
            if (!clean) return [];

            // 1. Try Typesense if enabled and not forced to fallback
            if (!forceFallback && this.isTypesenseEnabled()) {
                try {
                    const typesenseResults = await this.searchBooksTypesense({ query: clean, limit, circle_id, available_only });
                    if (typesenseResults && typesenseResults.length > 0) {
                        return typesenseResults;
                    }
                } catch (err) {
                    console.warn('[Search] Typesense query failed, seamlessly falling back to Firestore search:', err);
                    this._typesenseStatus.isHealthy = false;
                }
            }

            // 2. Firestore Fallback Search (ISBN, Prefix Title, Author)
            const results = [];
            const seenIds = new Set();

            // 1. Check if query is an ISBN
            const cleanIsbnQuery = this.cleanIsbn(clean);
            if (cleanIsbnQuery.length >= 9) {
                const isbnSnap = await firebase.firestore().collection('books')
                    .where('isbns', 'array-contains', cleanIsbnQuery)
                    .limit(limit)
                    .get();

                isbnSnap.docs.forEach(doc => {
                    if (!seenIds.has(doc.id)) {
                        seenIds.add(doc.id);
                        results.push({ id: doc.id, searchProvider: 'firestore', ...doc.data() });
                    }
                });
            }

            // 2. Title prefix search
            const normTitle = this.normalizeTitle(clean);
            if (normTitle && results.length < limit) {
                const titleSnap = await firebase.firestore().collection('books')
                    .where('title_normalized', '>=', normTitle)
                    .where('title_normalized', '<=', normTitle + '\uf8ff')
                    .limit(limit - results.length)
                    .get();

                titleSnap.docs.forEach(doc => {
                    if (!seenIds.has(doc.id)) {
                        seenIds.add(doc.id);
                        results.push({ id: doc.id, searchProvider: 'firestore', ...doc.data() });
                    }
                });
            }

            // 3. Author search
            const normAuthor = this.normalizeAuthor(clean);
            if (normAuthor && results.length < limit) {
                const authorSnap = await firebase.firestore().collection('books')
                    .where('authors_normalized', 'array-contains', normAuthor)
                    .limit(limit - results.length)
                    .get();

                authorSnap.docs.forEach(doc => {
                    if (!seenIds.has(doc.id)) {
                        seenIds.add(doc.id);
                        results.push({ id: doc.id, searchProvider: 'firestore', ...doc.data() });
                    }
                });
            }

            return results;
        },

        canUserViewItem: function(item, uid, userCircleIds = []) {
            if (!item) return false;
            const vis = item.visibility || 'public';
            if (vis === 'public') return true;
            if (!uid) return false;
            if (item.owner_id === uid) return true;
            if (vis === 'trusted') {
                const trusted = Array.isArray(item.trusted_user_ids) ? item.trusted_user_ids : [];
                return trusted.includes(uid);
            }
            if (vis === 'circles') {
                const cids = Array.isArray(item.circle_ids) ? item.circle_ids : (item.circle_id ? [item.circle_id] : []);
                return cids.some(cid => userCircleIds.includes(cid));
            }
            return false;
        },

        canUserRequestItem: function(item, uid, userCircleIds = []) {
            if (!this.canUserViewItem(item, uid, userCircleIds)) return false;
            if (!uid || item.owner_id === uid) return false;
            if (item.is_available === false || ['approved', 'borrowed', 'returned'].includes(item.status)) return false;
            const policy = item.request_policy || 'anyone';
            const trusted = Array.isArray(item.trusted_user_ids) ? item.trusted_user_ids : [];
            if (policy === 'trusted_only') {
                return trusted.includes(uid);
            }
            if (policy === 'circle_members') {
                const cids = Array.isArray(item.circle_ids) ? item.circle_ids : (item.circle_id ? [item.circle_id] : []);
                return cids.some(cid => userCircleIds.includes(cid));
            }
            return true;
        },

        getBookCopies: async function(bookId, filters = {}) {
            if (!bookId) return [];
            try {
                // If the book was merged into another canonical record, resolve the target
                let resolvedBookId = bookId;
                try {
                    const bDoc = await firebase.firestore().collection('books').doc(bookId).get();
                    if (bDoc.exists && bDoc.data().is_merged && bDoc.data().merged_into) {
                        resolvedBookId = bDoc.data().merged_into;
                    }
                } catch (e) {}

                const snap = await firebase.firestore().collection('items')
                    .where('book_id', '==', resolvedBookId)
                    .get();

                let copies = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                // Filter out withdrawn copies unless explicitly requested
                if (!filters.include_withdrawn) {
                    copies = copies.filter(c => !c.is_withdrawn && c.status !== 'withdrawn');
                }

                // Filter out copies that the viewer is not authorized to view based on visibility (Issue #18)
                const currentUser = firebase.auth().currentUser;
                const viewerId = filters.viewer_id || (currentUser ? currentUser.uid : null);
                
                let viewerCircleIds = Array.isArray(filters.user_circle_ids) ? filters.user_circle_ids : [];
                if (viewerId && viewerCircleIds.length === 0) {
                    try {
                        const memSnap = await firebase.firestore().collection('circle_members')
                            .where('profile_id', '==', viewerId).get();
                        viewerCircleIds = memSnap.docs.map(d => d.data().circle_id).filter(Boolean);
                    } catch (e) {
                        console.warn('Could not load viewer circle memberships:', e);
                    }
                }

                copies = copies.filter(c => this.canUserViewItem(c, viewerId, viewerCircleIds));

                // Populate owner profiles
                const ownerIds = [...new Set(copies.map(c => c.owner_id).filter(Boolean))];
                const profilesMap = {};
                await Promise.all(ownerIds.map(async (uid) => {
                    try {
                        const prof = await this.getProfile(uid);
                        if (prof) profilesMap[uid] = prof;
                    } catch (e) {
                        console.warn('Could not load owner profile:', uid, e);
                    }
                }));

                // Populate circle names if copies are bound to a circle
                const circleIds = [...new Set(copies.map(c => c.circle_id).filter(Boolean))];
                const circlesMap = {};
                await Promise.all(circleIds.map(async (cid) => {
                    try {
                        const circle = await this.getCircle(cid);
                        if (circle) circlesMap[cid] = circle;
                    } catch (e) {
                        console.warn('Could not load circle:', cid, e);
                    }
                }));

                // Enrich copy objects and enforce location privacy (never expose exact_address)
                copies = copies.map(copy => {
                    const owner = profilesMap[copy.owner_id] || {};
                    const circle = circlesMap[copy.circle_id] || null;
                    const area = copy.location_area || copy.location || owner.location || 'Local area';
                    const policy = copy.request_policy || 'anyone';
                    const trusted = Array.isArray(copy.trusted_user_ids) ? copy.trusted_user_ids : [];
                    const cids = Array.isArray(copy.circle_ids) ? copy.circle_ids : (copy.circle_id ? [copy.circle_id] : []);

                    let canRequest = true;
                    let requestRestrictionReason = null;
                    if (viewerId && copy.owner_id === viewerId) {
                        canRequest = false;
                        requestRestrictionReason = 'Your copy';
                    } else if (policy === 'trusted_only' && (!viewerId || !trusted.includes(viewerId))) {
                        canRequest = false;
                        requestRestrictionReason = 'Trusted neighbors only';
                    } else if (policy === 'circle_members' && (!viewerId || !cids.some(cid => viewerCircleIds.includes(cid)))) {
                        canRequest = false;
                        requestRestrictionReason = 'Circle members only';
                    }

                    const enriched = {
                        ...copy,
                        owner_profile: owner,
                        owner_name: owner.full_name || copy.owner_name || 'Neighbor',
                        owner_avatar: owner.avatar_url || 'https://placehold.co/100x100?text=U',
                        circle_name: circle ? circle.name : (copy.circle_name || null),
                        display_area: area,
                        visibility: copy.visibility || 'public',
                        request_policy: policy,
                        can_request: canRequest,
                        request_restriction_reason: requestRestrictionReason
                    };
                    delete enriched.exact_address;
                    return enriched;
                });

                // Filter by listing_type if specified ('borrow', 'giveaway', 'swap')
                if (filters.listing_type && filters.listing_type !== 'all') {
                    copies = copies.filter(c => c.listing_type === filters.listing_type);
                }

                // Filter by available_only
                if (filters.available_only) {
                    copies = copies.filter(c => c.is_available !== false && (!c.status || c.status === 'available'));
                }

                // Filter by condition
                if (filters.condition && filters.condition !== 'all') {
                    copies = copies.filter(c => c.condition === filters.condition);
                }

                // Sort: available first, then newest
                copies.sort((a, b) => {
                    const aAvail = a.is_available !== false && (!a.status || a.status === 'available') ? 1 : 0;
                    const bAvail = b.is_available !== false && (!b.status || b.status === 'available') ? 1 : 0;
                    if (aAvail !== bAvail) return bAvail - aAvail;
                    const aTime = a.created_at?.toMillis ? a.created_at.toMillis() : (a.created_at ? new Date(a.created_at).getTime() : 0);
                    const bTime = b.created_at?.toMillis ? b.created_at.toMillis() : (b.created_at ? new Date(b.created_at).getTime() : 0);
                    return bTime - aTime;
                });

                return copies;
            } catch (err) {
                console.error('Error fetching book copies:', err);
                return [];
            }
        },

        getBookWithCopies: async function(bookId, filters = {}) {
            if (!bookId) return null;
            const book = await this.getBook(bookId);
            if (!book) return null;
            const copies = await this.getBookCopies(bookId, filters);
            const copiesStatus = this.getBookCopiesStatus(book);
            return { book, copies, copiesStatus };
        },

        lookupBookMetadata: async function({ isbn, query } = {}) {
            // 1. Try server-side callable if available
            try {
                if (typeof firebase.functions === 'function') {
                    const fn = firebase.functions().httpsCallable('lookupBookMetadata');
                    const res = await fn({ isbn, query });
                    if (res && res.data && (res.data.found || (res.data.candidates && res.data.candidates.length > 0))) {
                        return res.data;
                    }
                }
            } catch (err) {
                console.warn('Server callable lookup failed, using client fallback:', err.message);
            }

            // 2. Client-side fallback to Open Library with Google Books fallback
            const cleanIsbn = this.cleanIsbn(isbn || '');
            const cleanQuery = (query || '').trim();

            if (cleanIsbn) {
                // Try Open Library (Primary)
                try {
                    const olUrl = 'https://openlibrary.org/api/books?bibkeys=ISBN:' + cleanIsbn + '&format=json&jscmd=data';
                    const res = await fetch(olUrl);
                    if (res.ok) {
                        const data = await res.json();
                        const item = data['ISBN:' + cleanIsbn];
                        if (item && item.title) {
                            const authors = (item.authors || []).map(a => a.name).filter(Boolean);
                            const normIsbn = this.normalizeIsbn(cleanIsbn);
                            let cover = item.cover?.large || item.cover?.medium || ('https://covers.openlibrary.org/b/isbn/' + cleanIsbn + '-L.jpg');
                            if (cover && cover.startsWith('http://')) cover = 'https://' + cover.substring(7);
                            const book = {
                                title: item.title,
                                authors: authors.length > 0 ? authors : ['Unknown Author'],
                                isbn: cleanIsbn,
                                isbn_10: normIsbn.isbn10 || null,
                                isbn_13: normIsbn.isbn13 || null,
                                isbns: normIsbn.isbns,
                                publisher: item.publishers?.[0]?.name || null,
                                published_year: item.publish_date ? parseInt(String(item.publish_date).match(/\b(1[4-9]\d{2}|20\d{2})\b/)?.[0] || '0', 10) || null : null,
                                cover_url: cover,
                                description: typeof item.notes === 'string' ? item.notes : (typeof item.description === 'string' ? item.description : null),
                                source: 'open_library'
                            };
                            return { found: true, source: 'open_library', book, candidates: [book] };
                        }
                    }
                } catch (e) {}

                // Fallback Google Books
                try {
                    const gbUrl = 'https://www.googleapis.com/books/v1/volumes?q=isbn:' + cleanIsbn + '&maxResults=1';
                    const res = await fetch(gbUrl);
                    if (res.ok) {
                        const data = await res.json();
                        const item = data.items?.[0]?.volumeInfo;
                        if (item && item.title) {
                            let cover = item.imageLinks?.thumbnail || item.imageLinks?.smallThumbnail || null;
                            if (cover && cover.startsWith('http://')) cover = 'https://' + cover.substring(7);
                            const normIsbn = this.normalizeIsbn(cleanIsbn);
                            const book = {
                                title: item.title + (item.subtitle ? ': ' + item.subtitle : ''),
                                authors: item.authors || ['Unknown Author'],
                                isbn: cleanIsbn,
                                isbn_10: normIsbn.isbn10 || null,
                                isbn_13: normIsbn.isbn13 || null,
                                isbns: normIsbn.isbns,
                                publisher: item.publisher || null,
                                published_year: item.publishedDate ? parseInt(String(item.publishedDate).match(/\b(1[4-9]\d{2}|20\d{2})\b/)?.[0] || '0', 10) || null : null,
                                cover_url: cover,
                                description: item.description || null,
                                source: 'google_books'
                            };
                            return { found: true, source: 'google_books', book, candidates: [book] };
                        }
                    }
                } catch (e) {}
            } else if (cleanQuery) {
                // Open Library search (Primary)
                try {
                    const olUrl = 'https://openlibrary.org/search.json?q=' + encodeURIComponent(cleanQuery) + '&limit=5';
                    const res = await fetch(olUrl);
                    if (res.ok) {
                        const data = await res.json();
                        if (data.docs && data.docs.length > 0) {
                            const candidates = data.docs.map(doc => {
                                const isbns = doc.isbn || [];
                                const prim = isbns[0] || '';
                                const normIsbn = this.normalizeIsbn(prim);
                                let cover = doc.cover_i ? ('https://covers.openlibrary.org/b/id/' + doc.cover_i + '-L.jpg') : (prim ? ('https://covers.openlibrary.org/b/isbn/' + prim + '-L.jpg') : null);
                                if (cover && cover.startsWith('http://')) cover = 'https://' + cover.substring(7);
                                return {
                                    title: doc.title,
                                    authors: doc.author_name || ['Unknown Author'],
                                    isbn: prim,
                                    isbn_10: normIsbn.isbn10 || null,
                                    isbn_13: normIsbn.isbn13 || null,
                                    isbns,
                                    publisher: doc.publisher?.[0] || null,
                                    published_year: doc.first_publish_year || null,
                                    cover_url: cover,
                                    source: 'open_library'
                                };
                            });
                            return { found: true, source: 'open_library', book: candidates[0], candidates };
                        }
                    }
                } catch (e) {}

                // Fallback Google Books search
                try {
                    const gbUrl = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(cleanQuery) + '&maxResults=5';
                    const res = await fetch(gbUrl);
                    if (res.ok) {
                        const data = await res.json();
                        if (data.items && data.items.length > 0) {
                            const candidates = data.items.map(it => {
                                const vi = it.volumeInfo || {};
                                let cover = vi.imageLinks?.thumbnail || vi.imageLinks?.smallThumbnail || null;
                                if (cover && cover.startsWith('http://')) cover = 'https://' + cover.substring(7);
                                return {
                                    title: vi.title + (vi.subtitle ? ': ' + vi.subtitle : ''),
                                    authors: vi.authors || ['Unknown Author'],
                                    isbn: vi.industryIdentifiers?.[0]?.identifier || '',
                                    publisher: vi.publisher || null,
                                    published_year: vi.publishedDate ? parseInt(String(vi.publishedDate).match(/\b(1[4-9]\d{2}|20\d{2})\b/)?.[0] || '0', 10) || null : null,
                                    cover_url: cover,
                                    description: vi.description || null,
                                    source: 'google_books'
                                };
                            });
                            return { found: true, source: 'google_books', book: candidates[0], candidates };
                        }
                    }
                } catch (e) {}
            }

            return { found: false, source: null, book: null, candidates: [] };
        },

        // ==========================================
        // Issue #20: Librarian Roles, Moderation & Catalog Curation
        // ==========================================

        isLibrarian: async function(userId, circleId = null) {
            if (!userId) return false;
            try {
                // 1. Check global librarians collection
                const libDoc = await firebase.firestore().collection('librarians').doc(userId).get();
                if (libDoc.exists) {
                    const data = libDoc.data();
                    if (data.is_active !== false) return true;
                }

                // 2. Check profile role
                const profile = await this.getProfile(userId);
                if (profile) {
                    if (profile.role === 'librarian' || profile.role === 'admin' || profile.is_librarian === true) {
                        return true;
                    }
                }

                // 3. If circleId specified, check circle creator or circle_members role
                if (circleId) {
                    const circleDoc = await firebase.firestore().collection('circles').doc(circleId).get();
                    if (circleDoc.exists && circleDoc.data().created_by === userId) return true;

                    const membershipId = `${circleId}_${userId}`;
                    const memDoc = await firebase.firestore().collection('circle_members').doc(membershipId).get();
                    if (memDoc.exists) {
                        const mData = memDoc.data();
                        if (mData.role === 'librarian' || mData.role === 'admin') return true;
                    }
                } else {
                    // Check if member is librarian or admin in any circle membership
                    const memSnap = await firebase.firestore().collection('circle_members')
                        .where('profile_id', '==', userId).get();
                    const hasCircleLib = memSnap.docs.some(d => {
                        const r = d.data().role;
                        return r === 'librarian' || r === 'admin';
                    });
                    if (hasCircleLib) return true;
                }

                return false;
            } catch (err) {
                console.warn('Error checking librarian status:', err);
                return false;
            }
        },

        appointLibrarian: async function(targetUserId, circleId = null, appointedBy = null) {
            const currentUid = appointedBy || firebase.auth().currentUser?.uid;
            if (!currentUid) throw new Error('Authentication required to appoint librarians');
            if (!targetUserId) throw new Error('Target user ID required');

            try {
                if (circleId) {
                    const circleDoc = await firebase.firestore().collection('circles').doc(circleId).get();
                    if (!circleDoc.exists) throw new Error('Circle not found');
                    if (circleDoc.data().created_by !== currentUid) {
                        throw new Error('Only circle creator can appoint librarians in this circle');
                    }
                    const memRef = firebase.firestore().collection('circle_members').doc(`${circleId}_${targetUserId}`);
                    await memRef.set({
                        circle_id: circleId,
                        profile_id: targetUserId,
                        role: 'librarian',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                }

                // Register in librarians collection
                await firebase.firestore().collection('librarians').doc(targetUserId).set({
                    profile_id: targetUserId,
                    circle_id: circleId || null,
                    appointed_by: currentUid,
                    is_active: true,
                    appointed_at: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                // Log to moderation_events
                await firebase.firestore().collection('moderation_events').add({
                    action: 'appoint_librarian',
                    actor_id: currentUid,
                    target_type: 'user',
                    target_id: targetUserId,
                    circle_id: circleId || null,
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                });

                return { success: true, targetUserId, role: 'librarian' };
            } catch (err) {
                console.error('Error appointing librarian:', err);
                throw err;
            }
        },

        removeLibrarian: async function(targetUserId, circleId = null, removedBy = null) {
            const currentUid = removedBy || firebase.auth().currentUser?.uid;
            if (!currentUid) throw new Error('Authentication required to remove librarians');
            if (!targetUserId) throw new Error('Target user ID required');

            try {
                if (circleId) {
                    const circleDoc = await firebase.firestore().collection('circles').doc(circleId).get();
                    if (!circleDoc.exists) throw new Error('Circle not found');
                    if (circleDoc.data().created_by !== currentUid) {
                        throw new Error('Only circle creator can remove librarians in this circle');
                    }
                    const memRef = firebase.firestore().collection('circle_members').doc(`${circleId}_${targetUserId}`);
                    await memRef.set({
                        role: 'member',
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                }

                // Deactivate in librarians collection
                await firebase.firestore().collection('librarians').doc(targetUserId).set({
                    is_active: false,
                    removed_by: currentUid,
                    removed_at: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                // Log to moderation_events
                await firebase.firestore().collection('moderation_events').add({
                    action: 'remove_librarian',
                    actor_id: currentUid,
                    target_type: 'user',
                    target_id: targetUserId,
                    circle_id: circleId || null,
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                });

                return { success: true, targetUserId, role: 'member' };
            } catch (err) {
                console.error('Error removing librarian:', err);
                throw err;
            }
        },

        updateBookMetadata: async function(bookId, updates, editorUserId = null) {
            const currentUid = editorUserId || firebase.auth().currentUser?.uid;
            if (!currentUid) throw new Error('Authentication required to update book metadata');
            if (!bookId) throw new Error('Book ID required');

            const bookDoc = await firebase.firestore().collection('books').doc(bookId).get();
            if (!bookDoc.exists) throw new Error('Book not found');
            const bookData = bookDoc.data();

            const isLib = await this.isLibrarian(currentUid);
            const isCreator = (bookData.created_by === currentUid);
            if (!isLib && !isCreator) {
                throw new Error('Permission denied: only librarians or creator may update canonical book metadata');
            }

            const payload = {};
            if (updates.title) {
                payload.title = String(updates.title).trim();
                payload.title_normalized = this.normalizeTitle(payload.title);
            }
            if (updates.author) {
                payload.author = String(updates.author).trim();
                const authNorm = this.normalizeAuthors(payload.author);
                payload.authors = authNorm.authors;
            } else if (Array.isArray(updates.authors)) {
                payload.authors = updates.authors;
                payload.author = updates.authors.join(', ');
            }
            if (updates.description !== undefined) payload.description = String(updates.description || '').trim();
            if (updates.publisher !== undefined) payload.publisher = String(updates.publisher || '').trim();
            if (updates.published_year !== undefined) payload.published_year = parseInt(updates.published_year, 10) || null;
            if (updates.cover_image_url !== undefined) payload.cover_image_url = updates.cover_image_url;
            if (updates.cover_image !== undefined) payload.cover_image = updates.cover_image;
            if (Array.isArray(updates.categories)) payload.categories = updates.categories;

            if (updates.isbn) {
                const n = this.normalizeIsbn(updates.isbn);
                const isbns = new Set(bookData.isbns || []);
                if (n.isbn13) isbns.add(n.isbn13);
                if (n.isbn10) isbns.add(n.isbn10);
                payload.isbns = Array.from(isbns);
                payload.isbn = n.isbn13 || n.isbn10 || updates.isbn;
            }

            payload.updated_at = firebase.firestore.FieldValue.serverTimestamp();
            payload.updated_by = currentUid;

            await firebase.firestore().collection('books').doc(bookId).update(payload);

            // Log to moderation_events
            await firebase.firestore().collection('moderation_events').add({
                action: 'edit_book_metadata',
                actor_id: currentUid,
                target_type: 'book',
                target_id: bookId,
                details: payload,
                created_at: firebase.firestore.FieldValue.serverTimestamp()
            });

            const updatedBook = { id: bookId, ...bookData, ...payload };
            try {
                await this.syncBookToSearchIndex(bookId, updatedBook);
            } catch (e) {}

            return updatedBook;
        },

        findDuplicateBooks: async function(bookId) {
            if (!bookId) return [];
            try {
                const targetBook = await this.getBook(bookId, { skipFollowMerge: true });
                if (!targetBook) return [];

                const snap = await firebase.firestore().collection('books').get();
                const candidates = [];

                for (const doc of snap.docs) {
                    if (doc.id === bookId) continue;
                    const b = { id: doc.id, ...doc.data() };
                    if (b.is_merged) continue;

                    let isMatch = false;
                    let matchReason = '';

                    // 1. Normalized Title Match
                    if (b.title_normalized && targetBook.title_normalized && b.title_normalized === targetBook.title_normalized) {
                        isMatch = true;
                        matchReason = 'Identical Title';
                    }

                    // 2. ISBN Overlap
                    if (!isMatch && Array.isArray(b.isbns) && Array.isArray(targetBook.isbns)) {
                        const hasCommonIsbn = b.isbns.some(isbn => targetBook.isbns.includes(isbn));
                        if (hasCommonIsbn) {
                            isMatch = true;
                            matchReason = 'Matching ISBN';
                        }
                    }

                    // 3. Substring Title Match
                    if (!isMatch && b.title_normalized && targetBook.title_normalized) {
                        if (b.title_normalized.length > 5 && targetBook.title_normalized.length > 5) {
                            if (b.title_normalized.includes(targetBook.title_normalized) || targetBook.title_normalized.includes(b.title_normalized)) {
                                isMatch = true;
                                matchReason = 'Similar Title';
                            }
                        }
                    }

                    if (isMatch) {
                        candidates.push({ ...b, matchReason });
                    }
                }

                return candidates;
            } catch (err) {
                console.error('Error finding duplicate books:', err);
                return [];
            }
        },

        mergeDuplicateBooks: async function(sourceBookId, targetBookId, moderatorUserId = null) {
            const currentUid = moderatorUserId || firebase.auth().currentUser?.uid;
            if (!currentUid) throw new Error('Authentication required to merge duplicate books');
            if (!sourceBookId || !targetBookId) throw new Error('Both source and target book IDs required');
            if (sourceBookId === targetBookId) throw new Error('Cannot merge a book into itself');

            const isLib = await this.isLibrarian(currentUid);
            if (!isLib) {
                throw new Error('Permission denied: only librarians or admins can merge books');
            }

            const db = firebase.firestore();
            const sourceDoc = await db.collection('books').doc(sourceBookId).get();
            const targetDoc = await db.collection('books').doc(targetBookId).get();

            if (!sourceDoc.exists) throw new Error(`Source book ${sourceBookId} not found`);
            if (!targetDoc.exists) throw new Error(`Target book ${targetBookId} not found`);

            const sourceData = sourceDoc.data();
            const targetData = targetDoc.data();

            if (sourceData.is_merged) throw new Error(`Source book is already merged into ${sourceData.merged_into}`);

            // 1. Repoint all physical book copies (items)
            const itemSnap = await db.collection('items').where('book_id', '==', sourceBookId).get();
            const batch = db.batch();

            itemSnap.docs.forEach(doc => {
                batch.update(doc.ref, {
                    book_id: targetBookId,
                    updated_at: firebase.firestore.FieldValue.serverTimestamp()
                });
            });

            // 2. Repoint all transaction requests
            const reqSnap = await db.collection('requests').where('book_id', '==', sourceBookId).get();
            reqSnap.docs.forEach(doc => {
                batch.update(doc.ref, {
                    book_id: targetBookId,
                    updated_at: firebase.firestore.FieldValue.serverTimestamp()
                });
            });

            // 3. Repoint all messages
            const msgSnap = await db.collection('messages').where('book_id', '==', sourceBookId).get();
            msgSnap.docs.forEach(doc => {
                batch.update(doc.ref, {
                    book_id: targetBookId
                });
            });

            // 4. Update Target Canonical Book (aggregating counts and metadata)
            const mergedAuthors = [...new Set([...(targetData.authors || []), ...(sourceData.authors || [])])];
            const mergedIsbns = [...new Set([...(targetData.isbns || []), ...(sourceData.isbns || [])])];
            const newCopiesCount = (targetData.copies_count || 0) + (sourceData.copies_count || 0);
            const newAvailableCount = (targetData.available_copies_count || 0) + (sourceData.available_copies_count || 0);

            batch.update(targetDoc.ref, {
                authors: mergedAuthors,
                isbns: mergedIsbns,
                copies_count: newCopiesCount,
                available_copies_count: newAvailableCount,
                updated_at: firebase.firestore.FieldValue.serverTimestamp(),
                updated_by: currentUid
            });

            // 5. Mark Source Canonical Book as merged
            batch.update(sourceDoc.ref, {
                is_merged: true,
                merged_into: targetBookId,
                copies_count: 0,
                available_copies_count: 0,
                updated_at: firebase.firestore.FieldValue.serverTimestamp(),
                updated_by: currentUid
            });

            await batch.commit();

            try {
                await this.removeBookFromSearchIndex(sourceBookId);
                const updatedTarget = await this.getBook(targetBookId);
                if (updatedTarget) {
                    await this.syncBookToSearchIndex(targetBookId, updatedTarget);
                }
            } catch (e) {}

            // 6. Record in moderation_events audit trail
            await db.collection('moderation_events').add({
                action: 'merge_books',
                actor_id: currentUid,
                target_type: 'book',
                source_id: sourceBookId,
                target_id: targetBookId,
                copies_moved: itemSnap.docs.length,
                requests_moved: reqSnap.docs.length,
                messages_moved: msgSnap.docs.length,
                created_at: firebase.firestore.FieldValue.serverTimestamp()
            });

            return {
                success: true,
                targetBookId,
                sourceBookId,
                copiesMoved: itemSnap.docs.length,
                requestsMoved: reqSnap.docs.length
            };
        },

        withdrawItemCopy: async function(copyId, reason = '', moderatorUserId = null) {
            const currentUid = moderatorUserId || firebase.auth().currentUser?.uid;
            if (!currentUid) throw new Error('Authentication required to withdraw item copy');
            if (!copyId) throw new Error('Copy ID required');

            const itemDoc = await firebase.firestore().collection('items').doc(copyId).get();
            if (!itemDoc.exists) throw new Error('Item copy not found');
            const itemData = itemDoc.data();

            const isOwner = (itemData.owner_id === currentUid);
            const isLib = await this.isLibrarian(currentUid);
            if (!isOwner && !isLib) {
                throw new Error('Permission denied: only copy owner or librarians may withdraw copy');
            }

            const wasAvailable = Boolean(itemData.is_available && itemData.status === 'available');

            await firebase.firestore().collection('items').doc(copyId).update({
                is_withdrawn: true,
                is_available: false,
                status: 'withdrawn',
                withdrawal_reason: reason || 'Withdrawn by moderation',
                withdrawn_by: currentUid,
                withdrawn_at: firebase.firestore.FieldValue.serverTimestamp(),
                updated_at: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Adjust canonical book copies count if linked
            if (itemData.book_id) {
                try {
                    const bookDoc = await firebase.firestore().collection('books').doc(itemData.book_id).get();
                    if (bookDoc.exists) {
                        const bData = bookDoc.data();
                        const newCopies = Math.max(0, (bData.copies_count || 1) - 1);
                        const newAvail = wasAvailable ? Math.max(0, (bData.available_copies_count || 1) - 1) : (bData.available_copies_count || 0);
                        await bookDoc.ref.update({
                            copies_count: newCopies,
                            available_copies_count: newAvail,
                            updated_at: firebase.firestore.FieldValue.serverTimestamp()
                        });
                        this.syncBookToSearchIndex(itemData.book_id, {
                            ...bData,
                            id: itemData.book_id,
                            copies_count: newCopies,
                            available_copies_count: newAvail
                        });
                    }
                } catch (e) {
                    console.warn('Could not update book counts on copy withdrawal:', e);
                }
            }

            // Log to moderation_events
            await firebase.firestore().collection('moderation_events').add({
                action: 'withdraw_copy',
                actor_id: currentUid,
                target_type: 'item',
                target_id: copyId,
                book_id: itemData.book_id || null,
                reason: reason || '',
                created_at: firebase.firestore.FieldValue.serverTimestamp()
            });

            return { success: true, copyId, is_withdrawn: true };
        },

        submitReport: async function({ targetType, targetId, reporterId = null, reason, details = '', circle_id = null, circleId = null }) {
            const currentUid = reporterId || firebase.auth().currentUser?.uid;
            if (!currentUid) throw new Error('Authentication required to submit report');
            if (!reason) throw new Error('Reason is required');
            if (!targetType || !targetId) throw new Error('Target type and target ID required');

            const reportCircleId = circle_id || circleId || null;

            const reportData = {
                target_type: targetType,
                target_id: targetId,
                reporter_id: currentUid,
                reason: String(reason).trim(),
                details: String(details || '').trim(),
                status: 'pending',
                created_at: firebase.firestore.FieldValue.serverTimestamp(),
                updated_at: firebase.firestore.FieldValue.serverTimestamp()
            };
            if (reportCircleId) {
                reportData.circle_id = reportCircleId;
            }

            const ref = await firebase.firestore().collection('reports').add(reportData);

            await this.logAnalyticsEvent('report_submitted', {
                report_id: ref.id,
                target_type: targetType,
                target_id: targetId,
                circle_id: reportCircleId,
                reason: String(reason).trim()
            });

            return { id: ref.id, status: 'pending' };
        },

        getReportQueue: async function(status = 'pending') {
            try {
                let query = firebase.firestore().collection('reports');
                if (status) {
                    query = query.where('status', '==', status);
                }
                const snap = await query.get();
                const reports = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                // Sort descending by created_at
                reports.sort((a, b) => {
                    const tA = a.created_at?.toDate ? a.created_at.toDate().getTime() : new Date(a.created_at || 0).getTime();
                    const tB = b.created_at?.toDate ? b.created_at.toDate().getTime() : new Date(b.created_at || 0).getTime();
                    return tB - tA;
                });

                // Enrich reports with metadata
                await Promise.all(reports.map(async (rep) => {
                    if (rep.reporter_id) {
                        rep.reporter = await this.getProfile(rep.reporter_id);
                    }
                    if (rep.target_type === 'book') {
                        rep.targetBook = await this.getBook(rep.target_id);
                    } else if (rep.target_type === 'item') {
                        rep.targetItem = await this.getItem(rep.target_id);
                    } else if (rep.target_type === 'user') {
                        rep.targetUser = await this.getProfile(rep.target_id);
                    }
                }));

                return reports;
            } catch (err) {
                console.error('Error fetching report queue:', err);
                return [];
            }
        },

        resolveReport: async function(reportId, resolution, moderatorUserId = null, actionTaken = 'none') {
            const currentUid = moderatorUserId || firebase.auth().currentUser?.uid;
            if (!currentUid) throw new Error('Authentication required to resolve report');
            if (!reportId) throw new Error('Report ID required');

            const isLib = await this.isLibrarian(currentUid);
            if (!isLib) throw new Error('Permission denied: only librarians or admins can resolve reports');

            const repDoc = await firebase.firestore().collection('reports').doc(reportId).get();
            if (!repDoc.exists) throw new Error('Report not found');

            await repDoc.ref.update({
                status: 'resolved',
                resolution: resolution || 'Reviewed and resolved',
                action_taken: actionTaken,
                resolved_by: currentUid,
                resolved_at: firebase.firestore.FieldValue.serverTimestamp(),
                updated_at: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Log to moderation_events
            await firebase.firestore().collection('moderation_events').add({
                action: 'resolve_report',
                actor_id: currentUid,
                target_type: 'report',
                target_id: reportId,
                resolution: resolution || '',
                action_taken: actionTaken,
                created_at: firebase.firestore.FieldValue.serverTimestamp()
            });

            return { success: true, reportId, status: 'resolved' };
        },

        getModerationEvents: async function(opts = {}) {
            try {
                let query = firebase.firestore().collection('moderation_events');
                if (opts.targetType) query = query.where('target_type', '==', opts.targetType);
                if (opts.targetId) query = query.where('target_id', '==', opts.targetId);
                if (opts.actorId) query = query.where('actor_id', '==', opts.actorId);

                const snap = await query.get();
                const events = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                events.sort((a, b) => {
                    const tA = a.created_at?.toDate ? a.created_at.toDate().getTime() : new Date(a.created_at || 0).getTime();
                    const tB = b.created_at?.toDate ? b.created_at.toDate().getTime() : new Date(b.created_at || 0).getTime();
                    return tB - tA;
                });

                if (opts.limit && events.length > opts.limit) {
                    return events.slice(0, opts.limit);
                }

                return events;
            } catch (err) {
                console.error('Error getting moderation events:', err);
                return [];
            }
        },

        // --- Feature Flags (Issue #22: Soft Launch Rollout) ---
        _featureFlags: {
            universal_catalog: {
                enabled: false,
                enabledCircles: ['a-world-of-books', 'seed-books-circle'],
                enabledForSeedUsers: true
            },
            book_pages: {
                enabled: false,
                enabledCircles: ['a-world-of-books', 'seed-books-circle'],
                enabledForSeedUsers: true
            },
            soft_launch_active: true
        },

        getFeatureFlags: async function() {
            return { ...this._featureFlags };
        },

        setFeatureFlag: async function(flagName, config) {
            this._featureFlags[flagName] = config;
            try {
                if (firebase.auth().currentUser) {
                    await firebase.firestore().collection('feature_flags').doc(flagName).set({
                        ...((typeof config === 'object' && config !== null) ? config : { enabled: !!config }),
                        updated_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                }
            } catch (err) {
                console.warn('Feature flag persistence non-fatal error:', err);
            }
            return this._featureFlags[flagName];
        },

        isFeatureEnabled: function(flagName, context = {}) {
            const flag = this._featureFlags[flagName];
            if (!flag) return false;
            if (typeof flag === 'boolean') return flag;
            if (flag.enabled === true) return true;

            const circleId = context.circleId || context.circle_id;
            if (circleId && Array.isArray(flag.enabledCircles)) {
                if (flag.enabledCircles.includes(circleId)) return true;
                if (typeof circleId === 'string' && flag.enabledCircles.some(c => circleId.toLowerCase().includes(c.toLowerCase()))) {
                    return true;
                }
            }

            if ((context.isSeedUser || context.seed_user) && flag.enabledForSeedUsers) {
                return true;
            }

            return false;
        },

        // --- Instrumentation & Analytics (Issue #22) ---
        logAnalyticsEvent: async function(eventType, metadata = {}) {
            try {
                if (!eventType) return null;
                const user = firebase.auth().currentUser;
                const eventDoc = {
                    event_type: String(eventType),
                    user_id: metadata.user_id || (user ? user.uid : null),
                    circle_id: metadata.circle_id || null,
                    metadata: { ...metadata },
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                };
                const ref = await firebase.firestore().collection('analytics_events').add(eventDoc);
                return { id: ref.id, ...eventDoc };
            } catch (err) {
                console.warn("Analytics event logging non-fatal error:", err);
                return null;
            }
        },

        // --- Seed Feedback Path (Issue #22) ---
        submitSeedFeedback: async function(data) {
            try {
                const user = firebase.auth().currentUser;
                const uid = data.user_id || (user ? user.uid : null);
                if (!uid) throw new Error("Must be logged in to submit feedback");
                if (!data.comment || !data.comment.trim()) throw new Error("Comment is required");

                const feedbackDoc = {
                    circle_id: data.circle_id || null,
                    user_id: uid,
                    feedback_type: data.feedback_type || 'general',
                    rating: Math.max(1, Math.min(Number(data.rating) || 5, 5)),
                    comment: data.comment.trim(),
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                };

                const ref = await firebase.firestore().collection('seed_feedback').add(feedbackDoc);
                await this.logAnalyticsEvent('seed_feedback_submitted', {
                    feedback_id: ref.id,
                    circle_id: feedbackDoc.circle_id,
                    feedback_type: feedbackDoc.feedback_type,
                    rating: feedbackDoc.rating
                });
                return { id: ref.id, ...feedbackDoc };
            } catch (err) {
                console.error("Error submitting seed feedback:", err);
                throw err;
            }
        },

        getSeedFeedback: async function(circleId = null) {
            try {
                let query = firebase.firestore().collection('seed_feedback');
                if (circleId) {
                    query = query.where('circle_id', '==', circleId);
                }
                const snapshot = await query.get();
                return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            } catch (err) {
                console.error("Error getting seed feedback:", err);
                return [];
            }
        },

        // --- Soft Launch Metrics & Go/No-Go Decision (Issue #22) ---
        getSoftLaunchMetrics: async function(circleId = null) {
            try {
                let query = firebase.firestore().collection('analytics_events');
                if (circleId) {
                    query = query.where('circle_id', '==', circleId);
                }
                const snapshot = await query.get();
                const events = snapshot.docs.map(d => d.data());

                let listings = 0;
                let searches = 0;
                let searchSuccesses = 0;
                let requests = 0;
                let approved = 0;
                let completed = 0;
                let reports = 0;

                events.forEach(e => {
                    switch (e.event_type) {
                        case 'listing_created':
                            listings++;
                            break;
                        case 'search_executed':
                            searches++;
                            if (e.metadata && Number(e.metadata.results_count) > 0) {
                                searchSuccesses++;
                            }
                            break;
                        case 'request_created':
                            requests++;
                            break;
                        case 'request_approved':
                            approved++;
                            break;
                        case 'transaction_completed':
                            completed++;
                            break;
                        case 'report_submitted':
                            reports++;
                            break;
                    }
                });

                // Calculate rates
                const searchSuccessRate = searches > 0 ? Math.round((searchSuccesses / searches) * 100) : 100;
                const completionRate = approved > 0 ? Math.round((completed / approved) * 100) : (requests > 0 ? Math.round((completed / requests) * 100) : 0);
                const disputeRate = completed > 0 ? Math.round((reports / completed) * 100) : (reports > 0 ? 100 : 0);

                // Feedback stats
                const feedback = await this.getSeedFeedback(circleId);
                const feedbackCount = feedback.length;
                const totalRating = feedback.reduce((sum, f) => sum + (Number(f.rating) || 0), 0);
                const averageRating = feedbackCount > 0 ? Math.round((totalRating / feedbackCount) * 10) / 10 : 5.0;

                return {
                    circle_id: circleId,
                    listings,
                    searches,
                    search_successes: searchSuccesses,
                    search_success_rate: searchSuccessRate,
                    requests,
                    approved,
                    completed,
                    completion_rate: completionRate,
                    reports,
                    dispute_rate: disputeRate,
                    feedback_count: feedbackCount,
                    average_rating: averageRating
                };
            } catch (err) {
                console.error("Error calculating soft launch metrics:", err);
                return {
                    circle_id: circleId,
                    listings: 0,
                    searches: 0,
                    search_successes: 0,
                    search_success_rate: 0,
                    requests: 0,
                    approved: 0,
                    completed: 0,
                    completion_rate: 0,
                    reports: 0,
                    dispute_rate: 0,
                    feedback_count: 0,
                    average_rating: 0
                };
            }
        },

        evaluateGoNoGoCriteria: async function(circleId = null, customTargets = {}) {
            const metrics = await this.getSoftLaunchMetrics(circleId);
            const targets = {
                min_listings: 5,
                min_requests: 3,
                min_completion_rate: 70, // >= 70%
                max_dispute_rate: 15,    // <= 15%
                min_search_success_rate: 60, // >= 60%
                min_average_rating: 3.5, // >= 3.5 stars
                ...customTargets
            };

            const criteria = [
                {
                    name: 'Active Listings Threshold',
                    key: 'listings',
                    actual: metrics.listings,
                    target: targets.min_listings,
                    passed: metrics.listings >= targets.min_listings,
                    rule: `>= ${targets.min_listings}`
                },
                {
                    name: 'Request Activity Threshold',
                    key: 'requests',
                    actual: metrics.requests,
                    target: targets.min_requests,
                    passed: metrics.requests >= targets.min_requests,
                    rule: `>= ${targets.min_requests}`
                },
                {
                    name: 'Transaction Completion Rate',
                    key: 'completion_rate',
                    actual: metrics.completion_rate,
                    target: targets.min_completion_rate,
                    passed: metrics.completion_rate >= targets.min_completion_rate,
                    rule: `>= ${targets.min_completion_rate}%`
                },
                {
                    name: 'Dispute / Report Rate',
                    key: 'dispute_rate',
                    actual: metrics.dispute_rate,
                    target: targets.max_dispute_rate,
                    passed: metrics.dispute_rate <= targets.max_dispute_rate,
                    rule: `<= ${targets.max_dispute_rate}%`
                },
                {
                    name: 'Search Discovery Success Rate',
                    key: 'search_success_rate',
                    actual: metrics.search_success_rate,
                    target: targets.min_search_success_rate,
                    passed: metrics.search_success_rate >= targets.min_search_success_rate,
                    rule: `>= ${targets.min_search_success_rate}%`
                },
                {
                    name: 'Seed User Satisfaction Rating',
                    key: 'average_rating',
                    actual: metrics.average_rating,
                    target: targets.min_average_rating,
                    passed: metrics.average_rating >= targets.min_average_rating,
                    rule: `>= ${targets.min_average_rating} / 5.0`
                }
            ];

            const blockers = criteria.filter(c => !c.passed).map(c => `${c.name}: actual ${c.actual} did not meet ${c.rule}`);
            const allPassed = blockers.length === 0;

            return {
                decision: allPassed ? 'GO' : 'NO_GO',
                allPassed,
                blockers,
                metrics,
                criteria,
                evaluated_at: new Date().toISOString()
            };
        },

        // ==========================================
        // Issue #24: Notifications and Due-Date Reminders
        // ==========================================
        _mockEmailOutbox: [],

        getNotificationPreferences: async function(userId) {
            if (!userId) {
                return {
                    in_app_enabled: true,
                    email_enabled: true,
                    due_reminders_enabled: true,
                    marketing_enabled: false,
                    email_unsubscribe_token: null
                };
            }
            try {
                const userDoc = await firebase.firestore().collection('users').doc(userId).get();
                if (userDoc.exists) {
                    const data = userDoc.data();
                    if (data && data.notification_preferences) {
                        return {
                            in_app_enabled: data.notification_preferences.in_app_enabled !== false,
                            email_enabled: data.notification_preferences.email_enabled !== false,
                            due_reminders_enabled: data.notification_preferences.due_reminders_enabled !== false,
                            marketing_enabled: Boolean(data.notification_preferences.marketing_enabled),
                            email_unsubscribe_token: data.notification_preferences.email_unsubscribe_token || `unsub_${userId}`
                        };
                    }
                }
            } catch (err) {
                console.warn('Could not read user notification preferences:', err);
            }
            return {
                in_app_enabled: true,
                email_enabled: true,
                due_reminders_enabled: true,
                marketing_enabled: false,
                email_unsubscribe_token: `unsub_${userId}`
            };
        },

        updateNotificationPreferences: async function(userId, updates) {
            if (!userId) throw new Error('User ID required');
            const patch = {};
            if ('in_app_enabled' in updates) patch.in_app_enabled = Boolean(updates.in_app_enabled);
            if ('email_enabled' in updates) patch.email_enabled = Boolean(updates.email_enabled);
            if ('due_reminders_enabled' in updates) patch.due_reminders_enabled = Boolean(updates.due_reminders_enabled);
            if ('marketing_enabled' in updates) patch.marketing_enabled = Boolean(updates.marketing_enabled);
            patch.email_unsubscribe_token = updates.email_unsubscribe_token || `unsub_${userId}`;
            patch.updated_at = firebase.firestore.FieldValue.serverTimestamp();

            await firebase.firestore().collection('users').doc(userId).set({
                notification_preferences: patch
            }, { merge: true });

            return patch;
        },

        unsubscribeEmailNotifications: async function(token) {
            if (!token || typeof token !== 'string') throw new Error('Invalid unsubscribe token');
            const cleanToken = token.trim();
            let targetUserId = null;

            if (cleanToken.startsWith('unsub_')) {
                targetUserId = cleanToken.substring(6);
            } else {
                const snap = await firebase.firestore().collection('users')
                    .where('notification_preferences.email_unsubscribe_token', '==', cleanToken)
                    .limit(1)
                    .get();
                if (!snap.empty) {
                    targetUserId = snap.docs[0].id;
                }
            }

            if (!targetUserId) {
                throw new Error('Unsubscribe token not found or expired');
            }

            await this.updateNotificationPreferences(targetUserId, { email_enabled: false });
            return { success: true, userId: targetUserId, email_enabled: false };
        },

        dispatchNotification: async function({
            recipientId,
            actorId = null,
            type,
            title,
            body,
            actionUrl = '',
            requestId = null,
            bookId = null,
            itemId = null,
            circleId = null,
            metadata = {}
        }) {
            if (!recipientId || !type || !title || !body) {
                console.warn('[Notifications] Missing required notification fields:', { recipientId, type, title });
                return { success: false, reason: 'missing_fields' };
            }

            try {
                const prefs = await this.getNotificationPreferences(recipientId);

                // Check due-date reminder preference specifically
                if (type.startsWith('due_') && !prefs.due_reminders_enabled) {
                    return { success: false, reason: 'due_reminders_disabled' };
                }

                const db = firebase.firestore();

                // Rate limiting and deduplication:
                const dedupKey = metadata.dedup_key || (requestId ? `${recipientId}_${type}_${requestId}` : null);
                if (dedupKey) {
                    const existingSnap = await db.collection('notifications')
                        .where('recipient_id', '==', recipientId)
                        .where('dedup_key', '==', dedupKey)
                        .limit(1)
                        .get();
                    if (existingSnap && existingSnap.docs && existingSnap.docs.length > 0) {
                        return { success: true, dedupSkipped: true, existingId: existingSnap.docs[0].id };
                    }
                }

                let createdInAppId = null;

                // 1. Create In-App Notification if enabled
                if (prefs.in_app_enabled) {
                    const notifDocRef = await db.collection('notifications').add({
                        recipient_id: recipientId,
                        actor_id: actorId,
                        type,
                        title,
                        body,
                        action_url: actionUrl,
                        request_id: requestId,
                        book_id: bookId,
                        item_id: itemId,
                        circle_id: circleId,
                        is_read: false,
                        dedup_key: dedupKey,
                        metadata: metadata || {},
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    createdInAppId = notifDocRef.id;
                }

                // 2. Dispatch simulated email if enabled
                let emailSent = false;
                if (prefs.email_enabled) {
                    const unsubscribeUrl = `https://neighborgoods.app/unsubscribe?token=${prefs.email_unsubscribe_token || ('unsub_' + recipientId)}`;
                    const emailRecord = {
                        recipient_id: recipientId,
                        subject: title,
                        body_text: body,
                        action_url: actionUrl,
                        unsubscribe_url: unsubscribeUrl,
                        sent_at: new Date().toISOString()
                    };
                    this._mockEmailOutbox.push(emailRecord);
                    emailSent = true;
                }

                return {
                    success: true,
                    inAppDispatched: Boolean(createdInAppId),
                    emailDispatched: emailSent,
                    notificationId: createdInAppId,
                    dedupSkipped: false
                };
            } catch (err) {
                console.warn('[Notifications] Non-fatal notification dispatch error:', err);
                return { success: false, error: err.message };
            }
        },

        getUserNotifications: async function(userId, { unreadOnly = false, limit = 20, startAfter = null } = {}) {
            if (!userId) return [];
            try {
                let query = firebase.firestore().collection('notifications')
                    .where('recipient_id', '==', userId);

                if (unreadOnly) {
                    query = query.where('is_read', '==', false);
                }

                const snap = await query.get();
                let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));

                list.sort((a, b) => {
                    const timeA = a.created_at?.toMillis ? a.created_at.toMillis() : new Date(a.created_at || 0).getTime();
                    const timeB = b.created_at?.toMillis ? b.created_at.toMillis() : new Date(b.created_at || 0).getTime();
                    return timeB - timeA;
                });

                if (startAfter) {
                    const idx = list.findIndex(n => n.id === startAfter);
                    if (idx !== -1) {
                        list = list.slice(idx + 1);
                    }
                }

                return list.slice(0, limit);
            } catch (err) {
                console.error('Error fetching user notifications:', err);
                return [];
            }
        },

        getUnreadNotificationCount: async function(userId) {
            if (!userId) return 0;
            try {
                const snap = await firebase.firestore().collection('notifications')
                    .where('recipient_id', '==', userId)
                    .where('is_read', '==', false)
                    .get();
                return snap.docs.length;
            } catch (err) {
                console.warn('Error reading unread notification count:', err);
                return 0;
            }
        },

        markNotificationAsRead: async function(notificationId, userId = null) {
            if (!notificationId) return null;
            try {
                await firebase.firestore().collection('notifications').doc(notificationId).update({
                    is_read: true,
                    read_at: firebase.firestore.FieldValue.serverTimestamp()
                });
                return { id: notificationId, is_read: true };
            } catch (err) {
                console.error('Error marking notification as read:', err);
                throw err;
            }
        },

        markAllNotificationsAsRead: async function(userId) {
            if (!userId) return { count: 0 };
            try {
                const snap = await firebase.firestore().collection('notifications')
                    .where('recipient_id', '==', userId)
                    .where('is_read', '==', false)
                    .get();

                const db = firebase.firestore();
                const batch = db.batch();
                snap.docs.forEach(doc => {
                    batch.update(doc.ref, {
                        is_read: true,
                        read_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });
                await batch.commit();
                return { count: snap.docs.length };
            } catch (err) {
                console.error('Error marking all notifications as read:', err);
                throw err;
            }
        },

        subscribeToUserNotifications: function(userId, callback) {
            if (!userId || typeof callback !== 'function') return () => {};
            try {
                return firebase.firestore().collection('notifications')
                    .where('recipient_id', '==', userId)
                    .onSnapshot(snap => {
                        const notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                        notifications.sort((a, b) => {
                            const timeA = a.created_at?.toMillis ? a.created_at.toMillis() : new Date(a.created_at || 0).getTime();
                            const timeB = b.created_at?.toMillis ? b.created_at.toMillis() : new Date(b.created_at || 0).getTime();
                            return timeB - timeA;
                        });
                        const unreadCount = notifications.filter(n => !n.is_read).length;
                        callback({ notifications, unreadCount });
                    }, err => {
                        console.warn('Subscription error for notifications:', err);
                    });
            } catch (e) {
                return () => {};
            }
        },

        checkAndDispatchDueDateReminders: async function({ asOfDate = new Date(), warningDays = 2 } = {}) {
            const now = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
            const dateStr = now.toISOString().split('T')[0];
            let totalEvaluated = 0;
            let remindersSent = 0;
            let dueSoonCount = 0;
            let overdueCount = 0;

            try {
                const db = firebase.firestore();
                const snap = await db.collection('requests')
                    .where('status', 'in', ['borrowed', 'picked_up', 'in_progress'])
                    .get();

                for (const doc of snap.docs) {
                    totalEvaluated++;
                    const req = { id: doc.id, ...doc.data() };
                    if (!req.borrower_id) continue;

                    let dueDate = null;
                    if (req.return_due_date) {
                        dueDate = new Date(req.return_due_date);
                    } else if (req.end_date) {
                        dueDate = new Date(req.end_date);
                    } else {
                        const baseDate = req.picked_up_at?.toMillis
                            ? new Date(req.picked_up_at.toMillis())
                            : (req.created_at?.toMillis ? new Date(req.created_at.toMillis()) : new Date());
                        dueDate = new Date(baseDate.getTime() + (14 * 24 * 60 * 60 * 1000));
                    }

                    if (isNaN(dueDate.getTime())) continue;

                    const diffMs = dueDate.getTime() - now.getTime();
                    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
                    const itemName = req.item_name || req.name || 'your borrowed book';

                    let reminderType = null;
                    let title = '';
                    let body = '';

                    if (diffDays < 0) {
                        reminderType = 'due_overdue';
                        const overdueDays = Math.abs(diffDays);
                        title = `Overdue: "${itemName}" was due ${overdueDays} day${overdueDays !== 1 ? 's' : ''} ago`;
                        body = `"${itemName}" was due on ${dueDate.toLocaleDateString()}. Please arrange a return with the lender.`;
                        overdueCount++;
                    } else if (diffDays <= warningDays) {
                        reminderType = diffDays === 0 ? 'due_today' : 'due_soon';
                        title = diffDays === 0
                            ? `Due Today: "${itemName}"`
                            : `Due in ${diffDays} day${diffDays !== 1 ? 's' : ''}: "${itemName}"`;
                        body = `Friendly reminder: "${itemName}" is due on ${dueDate.toLocaleDateString()}.`;
                        dueSoonCount++;
                    }

                    if (reminderType) {
                        const dedupKey = `${req.id}_${reminderType}_${dateStr}`;
                        const res = await this.dispatchNotification({
                            recipientId: req.borrower_id,
                            actorId: req.lender_id || null,
                            type: reminderType,
                            title,
                            body,
                            actionUrl: `activity.html?request=${req.id}`,
                            requestId: req.id,
                            bookId: req.book_id || null,
                            itemId: req.item_id || null,
                            circleId: req.circle_id || null,
                            metadata: {
                                dedup_key: dedupKey,
                                due_date: dueDate.toISOString(),
                                diff_days: diffDays
                            }
                        });

                        if (res && res.success && !res.dedupSkipped) {
                            remindersSent++;
                        }
                    }
                }

                return {
                    success: true,
                    totalEvaluated,
                    remindersSent,
                    dueSoonCount,
                    overdueCount,
                    evaluatedAt: now.toISOString()
                };
            } catch (err) {
                console.error('Error checking due date reminders:', err);
                return {
                    success: false,
                    totalEvaluated,
                    remindersSent,
                    error: err.message
                };
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
