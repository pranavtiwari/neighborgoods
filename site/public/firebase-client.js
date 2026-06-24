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

    // Helper function to handle Google Login with profile picker
    window.loginWithGoogle = async function(redirectTo = 'explore.html') {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
            const result = await firebase.auth().signInWithPopup(provider);
            const user = result.user;
            
            // Check if profile exists, if not create one
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
            window.location.href = redirectTo;
        } catch (error) {
            console.error('Login error:', error);
            alert('Login failed: ' + error.message);
        }
    };

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
        getItems: async function(category = 'all', userId = null) {
            try {
                let query = firebase.firestore().collection('items');
                const snapshot = await query.get();
                let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
                // Category filtering
                if (category !== 'all') {
                    items = items.filter(item => {
                        if (item.categories && Array.isArray(item.categories)) {
                            return item.categories.includes(category);
                        }
                        return item.category === category;
                    });
                }
                
                // Circle-scoped visibility filtering
                if (userId) {
                    const memberships = await this.getMyMemberships(userId);
                    const myCircleIds = new Set(memberships.map(m => m.circle_id));
                    items = items.filter(item => {
                        if (item.circle_ids && item.circle_ids.length > 0) {
                            return item.circle_ids.some(cid => myCircleIds.has(cid));
                        }
                        return !item.circle_id || myCircleIds.has(item.circle_id);
                    });
                } else {
                    // Unauthenticated: only show items with no circle_id and no circle_ids
                    items = items.filter(item => !item.circle_id && (!item.circle_ids || item.circle_ids.length === 0));
                }

                // Sort in memory by created_at descending
                items.sort((a, b) => {
                    const dateA = a.created_at?.toDate ? a.created_at.toDate() : new Date(a.created_at || 0);
                    const dateB = b.created_at?.toDate ? b.created_at.toDate() : new Date(b.created_at || 0);
                    return dateB - dateA;
                });
                return items;
            } catch (err) {
                console.error("Error getting items:", err);
                return [];
            }
        },

        getMyItems: async function(ownerId) {
            try {
                const snapshot = await firebase.firestore().collection('items')
                    .where('owner_id', '==', ownerId).get();
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            } catch (err) {
                console.error("Error getting my items:", err);
                return [];
            }
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

                const ref = await firebase.firestore().collection('items').add({
                    ...itemData,
                    owner_name: ownerName,
                    owner_avatar: ownerAvatar,
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                });
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
                await firebase.firestore().collection('items').doc(itemId).delete();
            } catch (err) {
                console.error("Error deleting item:", err);
                throw err;
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
                    
                    const newRequestRef = db.collection('requests').doc();
                    transaction.set(newRequestRef, {
                        ...requestData,
                        circle_id: circleId,
                        circle_ids: circleIds,
                        status: 'pending',
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
                    transaction.update(itemRef, {
                        status: 'approved',
                        is_available: false
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
                });
            } catch (err) {
                console.error("Error marking as returned:", err);
                throw err;
            }
        },

        confirmReturn: async function(requestId) {
            try {
                const db = firebase.firestore();
                const requestRef = db.collection('requests').doc(requestId);

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

                        // Mark item as available again (or completed if giveaway)
                        if (itemData.listing_type === 'giveaway') {
                            transaction.update(itemRef, {
                                status: 'completed',
                                is_available: false
                            });
                        } else {
                            transaction.update(itemRef, {
                                status: 'available',
                                is_available: true
                            });
                        }

                        // Increment carbon_saved_kg by 2 on lender profile
                        const lenderProfileRef = db.collection('profiles').doc(lenderId);
                        const lenderDoc = await transaction.get(lenderProfileRef);
                        const currentLenderCarbon = lenderDoc.exists ? (lenderDoc.data().carbon_saved_kg || 0) : 0;
                        transaction.update(lenderProfileRef, { carbon_saved_kg: currentLenderCarbon + 2 });

                        // Increment carbon_saved_kg by 2 on borrower profile as well
                        const borrowerProfileRef = db.collection('profiles').doc(borrowerId);
                        const borrowerDoc = await transaction.get(borrowerProfileRef);
                        const currentBorrowerCarbon = borrowerDoc.exists ? (borrowerDoc.data().carbon_saved_kg || 0) : 0;
                        transaction.update(borrowerProfileRef, { carbon_saved_kg: currentBorrowerCarbon + 2 });
                    }
                });
            } catch (err) {
                console.error("Error confirming return:", err);
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
                    
                    // Revert item status to available
                    transaction.update(itemRef, {
                        status: 'available',
                        is_available: true
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
                const requestRef = db.collection('requests').doc(requestId);
                
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
                    const isGiveaway = itemData.listing_type === 'giveaway';
                    
                    // Revert request status to returned (or approved if giveaway)
                    const targetStatus = isGiveaway ? 'approved' : 'returned';
                    transaction.update(requestRef, {
                        status: targetStatus,
                        completed_at: null
                    });
                    
                    // Revert item status to returned (or approved if giveaway) and make unavailable
                    transaction.update(itemRef, {
                        status: targetStatus,
                        is_available: false
                    });
                    
                    // Revert carbon savings (-2 for both profiles)
                    const lenderId = itemData.owner_id;
                    const borrowerId = requestData.borrower_id;
                    delete this.profilesCache[lenderId];
                    delete this.profilesCache[borrowerId];
                    
                    const lenderProfileRef = db.collection('profiles').doc(lenderId);
                    const lenderDoc = await transaction.get(lenderProfileRef);
                    const currentLenderCarbon = lenderDoc.exists ? (lenderDoc.data().carbon_saved_kg || 0) : 0;
                    transaction.update(lenderProfileRef, { carbon_saved_kg: Math.max(0, currentLenderCarbon - 2) });
                    
                    const borrowerProfileRef = db.collection('profiles').doc(borrowerId);
                    const borrowerDoc = await transaction.get(borrowerProfileRef);
                    const currentBorrowerCarbon = borrowerDoc.exists ? (borrowerDoc.data().carbon_saved_kg || 0) : 0;
                    transaction.update(borrowerProfileRef, { carbon_saved_kg: Math.max(0, currentBorrowerCarbon - 2) });
                });
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

        _ratingsSummaryCache: null,

        getRatingsSummary: async function() {
            if (this._ratingsSummaryCache) {
                return this._ratingsSummaryCache;
            }
            try {
                const user = firebase.auth().currentUser;
                let requestsDocs = [];
                
                if (user) {
                    const db = firebase.firestore();
                    const [borrowerSnap, lenderSnap] = await Promise.all([
                        db.collection('requests').where('borrower_id', '==', user.uid).get(),
                        db.collection('requests').where('lender_id', '==', user.uid).get()
                    ]);
                    requestsDocs = [...borrowerSnap.docs, ...lenderSnap.docs];
                }

                const ratingsSnap = await firebase.firestore().collection('ratings').get();
                
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
                for (const doc of ratingsSnap.docs) {
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
                this._ratingsSummaryCache = summary;
                return summary;
            } catch (err) {
                console.error("Error getting ratings summary:", err);
                return { listingRatings: {}, userRatings: {}, requestsMap: {} };
            }
        },

        createRating: async function(ratingData) {
            this._ratingsSummaryCache = null; // Clear ratings cache
            if (ratingData.ratee_id) {
                delete this.profilesCache[ratingData.ratee_id];
            }
            try {
                const ref = await firebase.firestore().collection('ratings').add({
                    ...ratingData,
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                });
                
                // Update ratee's reputation_score on their profile
                const rateeId = ratingData.ratee_id;
                const ratingsSnap = await firebase.firestore().collection('ratings')
                    .where('ratee_id', '==', rateeId)
                    .get();
                
                const ratings = ratingsSnap.docs.map(d => d.data());
                let totalScore = ratingData.score;
                let count = 1;
                let foundNew = false;
                
                ratings.forEach(r => {
                    if (r.request_id === ratingData.request_id && r.rater_id === ratingData.rater_id) {
                        foundNew = true;
                    }
                    totalScore += r.score;
                    count++;
                });
                
                if (foundNew) {
                    totalScore -= ratingData.score;
                    count--;
                }

                const avgScore = Number((totalScore / count).toFixed(1));
                
                try {
                    await firebase.firestore().collection('profiles').doc(rateeId).update({
                        reputation_score: avgScore
                    });
                } catch (profileUpdateErr) {
                    console.warn("Could not update profile reputation_score client-side (this is expected if reputation_score direct-write rules are disabled):", profileUpdateErr);
                }

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
