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

    // Helper function to handle Google Login with profile picker
    window.loginWithGoogle = async function(redirectTo = 'explore.html') {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
            const result = await firebase.auth().signInWithPopup(provider);
            const user = result.user;
            
            // Check if profile exists, if not create one
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
            window.location.href = redirectTo;
        } catch (error) {
            console.error('Login error:', error);
            alert('Login failed: ' + error.message);
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
        if (!user && 
            !window.location.pathname.includes('join-community.html') && 
            window.location.pathname !== '/' && 
            !window.location.pathname.includes('index.html')) {
            window.location.href = 'join-community.html';
        }
    });

    // --- Unified Database (Firestore) & Storage API ---
    window.db = {
        // --- Profiles ---
        getProfile: async function(profileId) {
            try {
                const doc = await firebase.firestore().collection('profiles').doc(profileId).get();
                return doc.exists ? { id: doc.id, ...doc.data() } : null;
            } catch (err) {
                console.error("Error getting profile:", err);
                return null;
            }
        },

        updateProfile: async function(profileId, profileData) {
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
                console.warn("Storage upload failed or is disabled. Falling back to Base64 data URL:", err);
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = (e) => reject(new Error("Failed to read file as data URL: " + e.target.error));
                    reader.readAsDataURL(file);
                });
            }
        },

        // --- Items ---
        getItems: async function(category = 'all') {
            try {
                let query = firebase.firestore().collection('items');
                if (category !== 'all') {
                    query = query.where('category', '==', category);
                }
                const snapshot = await query.get();
                const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
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
                const snapshot = await firebase.firestore().collection('items')
                    .where('circle_id', '==', circleId).get();
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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

        // --- Circles ---
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
                const members = [];
                for (const m of memberships) {
                    const profile = await this.getProfile(m.profile_id);
                    if (profile) {
                        members.push({ ...profile, role: m.role, joined_at: m.joined_at });
                    }
                }
                return members;
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

        // --- Borrow Requests ---
        createBorrowRequest: async function(requestData) {
            try {
                const ref = await firebase.firestore().collection('requests').add({
                    ...requestData,
                    status: 'pending',
                    created_at: firebase.firestore.FieldValue.serverTimestamp()
                });
                return { id: ref.id };
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
                                .where('item_id', 'in', chunk).get();
                            requests.push(...snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
                        }
                    }
                }

                // Populate related details
                for (const req of requests) {
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
                }

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

                // Populate sender and receiver profiles
                for (const msg of messages) {
                    const senderProfile = await this.getProfile(msg.sender_id);
                    msg.sender = senderProfile;
                    
                    const receiverProfile = await this.getProfile(msg.receiver_id);
                    msg.receiver = receiverProfile;
                }

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
                const ref = await firebase.firestore().collection('messages').add({
                    sender_id: senderId,
                    receiver_id: receiverId,
                    item_id: itemId || null,
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
            return firebase.firestore().collection('messages')
                .where('participants', 'array-contains', currentUserId)
                .onSnapshot((snapshot) => {
                    snapshot.docChanges().forEach((change) => {
                        if (change.type === 'added') {
                            const data = { id: change.doc.id, ...change.doc.data() };
                            // Convert Firestore Timestamp to string or date for page consumption
                            if (data.created_at && data.created_at.toDate) {
                                data.created_at = data.created_at.toDate().toISOString();
                            }
                            // Only process messages between currentUserId and targetUserId
                            const otherId = data.sender_id === currentUserId ? data.receiver_id : data.sender_id;
                            if (otherId === targetUserId) {
                                callback(data);
                            }
                        }
                    });
                }, (error) => {
                    console.error("Realtime listener error:", error);
                });
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
