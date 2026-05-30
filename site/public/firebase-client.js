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
                if (category !== 'all') {
                    query = query.where('category', '==', category);
                }
                const snapshot = await query.get();
                let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
                // Circle-scoped visibility filtering
                if (userId) {
                    const memberships = await this.getMyMemberships(userId);
                    const myCircleIds = new Set(memberships.map(m => m.circle_id));
                    items = items.filter(item => !item.circle_id || myCircleIds.has(item.circle_id));
                } else {
                    // Unauthenticated: only show items with no circle_id
                    items = items.filter(item => !item.circle_id);
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

        requestToJoinCircle: async function(circleId, profileId) {
            try {
                const id = `${circleId}_${profileId}`;
                await firebase.firestore().collection('circle_join_requests').doc(id).set({
                    circle_id: circleId,
                    profile_id: profileId,
                    status: 'pending',
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
                const requests = [];
                for (const doc of snapshot.docs) {
                    const data = doc.data();
                    // Only show pending requests (approved/denied are deleted, but filter for safety)
                    if (!data.status || data.status === 'pending') {
                        const profile = await this.getProfile(data.profile_id);
                        requests.push({ id: doc.id, ...data, profile });
                    }
                }
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

        // Confirm (approve) a borrow request.
        // For giveaway listings, the item is automatically deleted after approval.
        confirmBorrowRequest: async function(requestId, itemId, listingType) {
            try {
                await firebase.firestore().collection('requests').doc(requestId).update({
                    status: 'approved',
                    confirmed_at: firebase.firestore.FieldValue.serverTimestamp()
                });
                if (listingType === 'giveaway') {
                    await this.deleteItem(itemId);
                }
            } catch (err) {
                console.error("Error confirming borrow request:", err);
                throw err;
            }
        },

        declineBorrowRequest: async function(requestId) {
            try {
                await firebase.firestore().collection('requests').doc(requestId).update({
                    status: 'declined',
                    declined_at: firebase.firestore.FieldValue.serverTimestamp()
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
                
                // Fetch profiles in parallel or sequentially
                for (const post of posts) {
                    const profile = await this.getProfile(post.profile_id);
                    post.profiles = profile;
                }
                
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

        markReturned: async function(requestId) {
            try {
                await firebase.firestore().collection('requests').doc(requestId).update({
                    status: 'returned',
                    returned_at: firebase.firestore.FieldValue.serverTimestamp()
                });
            } catch (err) {
                console.error("Error marking as returned:", err);
                throw err;
            }
        },

        confirmReturn: async function(requestId) {
            try {
                const reqDoc = await firebase.firestore().collection('requests').doc(requestId).get();
                if (!reqDoc.exists) throw new Error("Request not found");
                const reqData = reqDoc.data();
                
                // Set request completed
                await firebase.firestore().collection('requests').doc(requestId).update({
                    status: 'completed',
                    completed_at: firebase.firestore.FieldValue.serverTimestamp()
                });

                // Fetch item to know the owner (lender)
                const itemDoc = await firebase.firestore().collection('items').doc(reqData.item_id).get();
                if (itemDoc.exists) {
                    const itemData = itemDoc.data();
                    const lenderId = itemData.owner_id;
                    const borrowerId = reqData.borrower_id;

                    // Increment carbon_saved_kg by 2 on lender profile
                    const lenderProfileRef = firebase.firestore().collection('profiles').doc(lenderId);
                    await firebase.firestore().runTransaction(async (transaction) => {
                        const lenderDoc = await transaction.get(lenderProfileRef);
                        const currentLenderCarbon = lenderDoc.exists ? (lenderDoc.data().carbon_saved_kg || 0) : 0;
                        transaction.update(lenderProfileRef, { carbon_saved_kg: currentLenderCarbon + 2 });
                    });

                    // Increment carbon_saved_kg by 2 on borrower profile as well
                    const borrowerProfileRef = firebase.firestore().collection('profiles').doc(borrowerId);
                    await firebase.firestore().runTransaction(async (transaction) => {
                        const borrowerDoc = await transaction.get(borrowerProfileRef);
                        const currentBorrowerCarbon = borrowerDoc.exists ? (borrowerDoc.data().carbon_saved_kg || 0) : 0;
                        transaction.update(borrowerProfileRef, { carbon_saved_kg: currentBorrowerCarbon + 2 });
                    });
                }
            } catch (err) {
                console.error("Error confirming return:", err);
                throw err;
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

        createRating: async function(ratingData) {
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
                
                await firebase.firestore().collection('profiles').doc(rateeId).update({
                    reputation_score: avgScore
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
                for (const r of ratings) {
                    r.rater_profile = await this.getProfile(r.rater_id);
                }
                
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
