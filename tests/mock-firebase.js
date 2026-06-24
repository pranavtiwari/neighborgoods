// Mock Firebase Compat SDK for testing firebase-client.js logic in-memory

class MockDocRef {
    constructor(collectionName, id, firestore) {
        this.collectionName = collectionName;
        this.id = id;
        this.firestore = firestore;
    }

    async get() {
        await this.firestore._checkErrorAndDelay();
        const data = this.firestore._getData(this.collectionName, this.id);
        return {
            exists: !!data,
            id: this.id,
            data: () => data ? JSON.parse(JSON.stringify(data)) : undefined,
            ref: this
        };
    }

    async set(data, options = {}) {
        await this.firestore._checkErrorAndDelay();
        this.firestore._setData(this.collectionName, this.id, data, options.merge);
    }

    async update(data) {
        await this.firestore._checkErrorAndDelay();
        this.firestore._setData(this.collectionName, this.id, data, true);
    }

    async delete() {
        await this.firestore._checkErrorAndDelay();
        this.firestore._deleteData(this.collectionName, this.id);
    }
}

class MockQuery {
    constructor(collectionName, firestore, filters = []) {
        this.collectionName = collectionName;
        this.firestore = firestore;
        this.filters = filters;
    }

    where(field, op, value) {
        return new MockQuery(this.collectionName, this.firestore, [...this.filters, { field, op, value }]);
    }

    async get() {
        await this.firestore._checkErrorAndDelay();
        let docs = this.firestore._getCollectionDocs(this.collectionName);
        for (const filter of this.filters) {
            docs = docs.filter(doc => {
                const val = doc[filter.field];
                if (filter.op === '==') {
                    return val === filter.value;
                } else if (filter.op === 'in') {
                    return Array.isArray(filter.value) && filter.value.includes(val);
                } else if (filter.op === 'array-contains') {
                    return Array.isArray(val) && val.includes(filter.value);
                }
                return true;
            });
        }

        const mappedDocs = docs.map(d => ({
            id: d.id,
            data: () => JSON.parse(JSON.stringify(d)),
            ref: new MockDocRef(this.collectionName, d.id, this.firestore)
        }));

        return {
            docs: mappedDocs,
            size: mappedDocs.length,
            forEach: (cb) => mappedDocs.forEach(cb)
        };
    }

    onSnapshot(callback, errorCallback) {
        const trigger = async () => {
            try {
                const snap = await this.get();
                const wrappedSnap = {
                    ...snap,
                    docChanges: () => snap.docs.map(doc => ({
                        type: 'added',
                        doc: doc
                    }))
                };
                callback(wrappedSnap);
            } catch (err) {
                if (errorCallback) errorCallback(err);
            }
        };
        
        trigger();
        this.firestore._registerListener(this.collectionName, trigger);

        return () => {
            this.firestore._unregisterListener(this.collectionName, trigger);
        };
    }
}

class MockCollection {
    constructor(name, firestore) {
        this.name = name;
        this.firestore = firestore;
    }

    doc(id) {
        const finalId = id || Math.random().toString(36).substring(2, 15);
        return new MockDocRef(this.name, finalId, this.firestore);
    }

    async add(data) {
        await this.firestore._checkErrorAndDelay();
        const id = Math.random().toString(36).substring(2, 15);
        this.firestore._setData(this.name, id, data, false);
        const ref = new MockDocRef(this.name, id, this.firestore);
        return ref;
    }

    where(field, op, value) {
        return new MockQuery(this.name, this.firestore, [{ field, op, value }]);
    }

    async get() {
        return new MockQuery(this.name, this.firestore).get();
    }
}

class MockBatch {
    constructor(firestore) {
        this.firestore = firestore;
        this.operations = [];
    }

    update(ref, data) {
        this.operations.push({ action: 'update', ref, data });
        return this;
    }

    async commit() {
        await this.firestore._checkErrorAndDelay();
        for (const op of this.operations) {
            if (op.action === 'update') {
                await op.ref.update(op.data);
            }
        }
    }
}

class MockTransaction {
    constructor(firestore) {
        this.firestore = firestore;
        this.writes = [];
        this.readVersions = {};
    }

    async get(ref) {
        const key = `${ref.collectionName}/${ref.id}`;
        this.readVersions[key] = this.firestore._docVersions[key] || 0;
        return ref.get();
    }

    set(ref, data) {
        this.writes.push({ action: 'set', ref, data, merge: false });
        return this;
    }

    update(ref, data) {
        this.writes.push({ action: 'update', ref, data });
        return this;
    }

    async _commit() {
        for (const w of this.writes) {
            if (w.action === 'set') {
                await w.ref.set(w.data, { merge: w.merge });
            } else if (w.action === 'update') {
                await w.ref.update(w.data);
            }
        }
    }
}

class MockFirestore {
    constructor() {
        this.db = {};
        this.listeners = {};
        this._docVersions = {};
        this._errorToInject = null;
        this._latencyMs = 0;
    }

    async _checkErrorAndDelay() {
        if (this._errorToInject) {
            throw this._errorToInject;
        }
        if (this._latencyMs) {
            await new Promise(r => setTimeout(r, this._latencyMs));
        }
    }

    collection(name) {
        if (!this.db[name]) {
            this.db[name] = {};
        }
        return new MockCollection(name, this);
    }

    batch() {
        return new MockBatch(this);
    }

    async runTransaction(cb) {
        await this._checkErrorAndDelay();
        const tx = new MockTransaction(this);
        const result = await cb(tx);
        
        // Optimistic concurrency control verification
        for (const [key, versionAtRead] of Object.entries(tx.readVersions)) {
            const currentVersion = this._docVersions[key] || 0;
            if (currentVersion !== versionAtRead) {
                throw new Error("Transaction failed due to concurrent modification (optimistic concurrency control).");
            }
        }
        
        await tx._commit();
        return result;
    }

    async enablePersistence() {
        return Promise.resolve();
    }

    FieldValue = {
        serverTimestamp: () => new Date().toISOString()
    };

    _getData(collectionName, id) {
        const col = this.db[collectionName];
        if (!col || !col[id]) return null;
        return { ...col[id], id };
    }

    _setData(collectionName, id, data, merge = false) {
        if (!this.db[collectionName]) {
            this.db[collectionName] = {};
        }
        
        const resolvedData = { ...data };
        for (const key of Object.keys(resolvedData)) {
            if (resolvedData[key] && resolvedData[key].constructor && resolvedData[key].constructor.name === 'Function') {
                resolvedData[key] = resolvedData[key]();
            }
        }

        if (merge && this.db[collectionName][id]) {
            this.db[collectionName][id] = {
                ...this.db[collectionName][id],
                ...resolvedData
            };
        } else {
            this.db[collectionName][id] = resolvedData;
        }

        const docKey = `${collectionName}/${id}`;
        this._docVersions[docKey] = (this._docVersions[docKey] || 0) + 1;

        this._triggerListeners(collectionName);
    }

    _deleteData(collectionName, id) {
        if (this.db[collectionName] && this.db[collectionName][id]) {
            delete this.db[collectionName][id];
            
            const docKey = `${collectionName}/${id}`;
            delete this._docVersions[docKey];

            this._triggerListeners(collectionName);
        }
    }

    _getCollectionDocs(collectionName) {
        const col = this.db[collectionName] || {};
        return Object.keys(col).map(id => ({ id, ...col[id] }));
    }

    _registerListener(collectionName, cb) {
        if (!this.listeners[collectionName]) {
            this.listeners[collectionName] = [];
        }
        this.listeners[collectionName].push(cb);
    }

    _unregisterListener(collectionName, cb) {
        if (this.listeners[collectionName]) {
            this.listeners[collectionName] = this.listeners[collectionName].filter(l => l !== cb);
        }
    }

    _triggerListeners(collectionName) {
        const list = this.listeners[collectionName] || [];
        list.forEach(cb => {
            try {
                cb();
            } catch (e) {}
        });
    }
}

class MockAuth {
    constructor() {
        this.currentUser = null;
        this.listeners = [];
        this.users = {};
    }

    onAuthStateChanged(callback) {
        this.listeners.push(callback);
        queueMicrotask(() => {
            callback(this.currentUser);
        });
        return () => {
            this.listeners = this.listeners.filter(l => l !== callback);
        };
    }

    _triggerAuthChange() {
        queueMicrotask(() => {
            this.listeners.forEach(cb => cb(this.currentUser));
        });
    }

    async signInWithPopup(provider) {
        const uid = 'google_user_123';
        this.currentUser = {
            uid,
            displayName: 'Google Neighbor',
            email: 'google@neighbor.com',
            photoURL: 'https://i.pravatar.cc/150?u=google_user_123'
        };
        this._triggerAuthChange();
        return { user: this.currentUser };
    }

    async signInWithEmailAndPassword(email, password) {
        const userRecord = this.users[email];
        if (!userRecord || userRecord.password !== password) {
            throw new Error('auth/invalid-login-credentials');
        }
        this.currentUser = {
            uid: userRecord.uid,
            displayName: userRecord.displayName,
            email: email
        };
        this._triggerAuthChange();
        return { user: this.currentUser };
    }

    async createUserWithEmailAndPassword(email, password) {
        if (this.users[email]) {
            throw new Error('auth/email-already-in-use');
        }
        const uid = 'email_user_' + Math.random().toString(36).substring(2, 10);
        const newUser = {
            uid,
            password,
            displayName: 'New Neighbor',
            email
        };
        this.users[email] = newUser;
        this.currentUser = {
            uid,
            displayName: newUser.displayName,
            email
        };
        this._triggerAuthChange();
        return { user: this.currentUser };
    }

    async signOut() {
        this.currentUser = null;
        this._triggerAuthChange();
    }
}

class MockStorageRef {
    constructor(path) {
        this.path = path;
    }

    child(path) {
        return new MockStorageRef(this.path ? `${this.path}/${path}` : path);
    }

    async put(file) {
        return {
            ref: {
                getDownloadURL: async () => `https://mockstorage.com/files/${this.path}`
            }
        };
    }
}

class MockStorage {
    ref() {
        return new MockStorageRef('');
    }
}

class FirebaseCompat {
    constructor() {
        this._firestore = new MockFirestore();
        this._auth = new MockAuth();
        this._storage = new MockStorage();
        
        this.firestore = () => this._firestore;
        this.auth = () => this._auth;
        this.storage = () => this._storage;
        
        this.firestore.FieldValue = this._firestore.FieldValue;
        this.auth.GoogleAuthProvider = class GoogleAuthProvider {
            setCustomParameters() {}
        };
    }

    initializeApp() {
        return this;
    }
}

export default FirebaseCompat;
