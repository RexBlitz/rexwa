import fs from 'fs';
import chalk from 'chalk';
import { EventEmitter } from 'events';
import pino from 'pino';

class InMemoryStore extends EventEmitter {
    constructor(options = {}) {
        super();
        this.contacts = {};
        this.chats = {};
        this.messages = {};
        this.presences = {};
        this.groupMetadata = {};
        this.callOffer = {};
        this.stickerPacks = {};
        this.authState = {};
        this.syncedHistory = {};
        this.poll_message = { message: [] };
        this.logger = options.logger || pino({ level: 'silent' });
        this.filePath = options.filePath || './store.json';
        this.autoSaveInterval = options.autoSaveInterval || 30000;
        this.autoSaveTimer = null;

        if (this.autoSaveInterval > 0) {
            this.startAutoSave();
        }
    }

    startAutoSave() {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
        }

        this.autoSaveTimer = setInterval(() => {
            this.saveToFile();
        }, this.autoSaveInterval);
    }

    stopAutoSave() {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }
    }

    load(state = {}) {
        try {
            Object.assign(this, {
                contacts: state.contacts || {},
                chats: state.chats || {},
                messages: state.messages || {},
                presences: state.presences || {},
                groupMetadata: state.groupMetadata || {},
                callOffer: state.callOffer || {},
                stickerPacks: state.stickerPacks || {},
                authState: state.authState || {},
                syncedHistory: state.syncedHistory || {},
                poll_message: state.poll_message || { message: [] }
            });
            this.logger.info('Store loaded successfully');
        } catch (e) {
            this.logger.error('Failed to load store: ' + e.message);
        }
    }

    loadFromFile() {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf8');
                const state = JSON.parse(data);
                this.load(state);
                this.logger.info(`Store loaded from file: ${this.filePath}`);
            } else {
                this.logger.info('No existing store file found, starting fresh');
            }
        } catch (e) {
            this.logger.error('Failed to load store from file: ' + e.message);
        }
    }

    save() {
        try {
            const state = {
                contacts: this.contacts,
                chats: this.chats,
                messages: this.messages,
                presences: this.presences,
                groupMetadata: this.groupMetadata,
                callOffer: this.callOffer,
                stickerPacks: this.stickerPacks,
                authState: this.authState,
                syncedHistory: this.syncedHistory,
                poll_message: this.poll_message,
                timestamp: Date.now()
            };
            this.logger.debug('Store saved to memory');
            return state;
        } catch (e) {
            this.logger.error('Failed to save store: ' + e.message);
            return {};
        }
    }

    saveToFile() {
        try {
            const state = this.save();
            fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
            this.logger.debug(`Store saved to file: ${this.filePath}`);
        } catch (e) {
            this.logger.error('Failed to save store to file: ' + e.message);
        }
    }

    clear() {
        this.contacts = {};
        this.chats = {};
        this.messages = {};
        this.presences = {};
        this.groupMetadata = {};
        this.callOffer = {};
        this.stickerPacks = {};
        this.authState = {};
        this.syncedHistory = {};
        this.poll_message = { message: [] };
        this.logger.info('Store cleared');
    }

    setContacts(contacts = {}) {
        if (typeof contacts !== 'object') return;
        this.contacts = { ...this.contacts, ...contacts };
        this.emit('contacts.set', contacts);
    }

    upsertContact(contact = {}) {
        if (!contact.id) return;
        this.contacts[contact.id] = { ...this.contacts[contact.id], ...contact };
        this.emit('contacts.upsert', [contact]);
    }

    updateContact(update = []) {
        if (!Array.isArray(update)) return;
        for (const contact of update) {
            if (contact.id && this.contacts[contact.id]) {
                this.contacts[contact.id] = { ...this.contacts[contact.id], ...contact };
                this.emit('contacts.update', [contact]);
            }
        }
    }

    deleteContact(ids = []) {
        if (!Array.isArray(ids)) return;
        for (const id of ids) {
            delete this.contacts[id];
        }
        this.emit('contacts.delete', ids);
    }

    setChats(chats = {}) {
        if (typeof chats !== 'object') return;
        this.chats = { ...this.chats, ...chats };
        this.emit('chats.set', chats);
    }

    upsertChat(chat = {}) {
        if (!chat.id) return;
        this.chats[chat.id] = { ...this.chats[chat.id], ...chat };
        this.emit('chats.upsert', [chat]);
    }

    updateChat(update = []) {
        if (!Array.isArray(update)) return;
        for (const chat of update) {
            if (chat.id && this.chats[chat.id]) {
                this.chats[chat.id] = { ...this.chats[chat.id], ...chat };
                this.emit('chats.update', [chat]);
            }
        }
    }

    deleteChat(ids = []) {
        if (!Array.isArray(ids)) return;
        for (const id of ids) {
            delete this.chats[id];
            delete this.messages[id];
        }
        this.emit('chats.delete', ids);
    }

    setMessages(chatId, messages = []) {
        if (!chatId || !Array.isArray(messages)) return;
        this.messages[chatId] = messages.reduce((acc, msg) => {
            if (msg?.key?.id) acc[msg.key.id] = msg;
            return acc;
        }, {});
        this.emit('messages.set', { chatId, messages });
    }

    upsertMessage(message = {}, type = 'append') {
        try {
            const chatId = message?.key?.remoteJid;
            if (!chatId || !message?.key?.id) return;
            if (!this.messages[chatId]) this.messages[chatId] = {};

            this.messages[chatId][message.key.id] = JSON.parse(JSON.stringify(message));
            this.emit('messages.upsert', { messages: [message], type });
        } catch (error) {
            this.logger.error('Error upserting message:', error);
        }
    }

    updateMessage(updates = []) {
        if (!Array.isArray(updates)) return;
        for (const update of updates) {
            const chatId = update?.key?.remoteJid;
            const msgId = update?.key?.id;
            if (chatId && msgId && this.messages[chatId]?.[msgId]) {
                this.messages[chatId][msgId] = { ...this.messages[chatId][msgId], ...update };
                this.emit('messages.update', [update]);
            }
        }
    }

    deleteMessage(keys = []) {
        if (!Array.isArray(keys)) return;
        for (const key of keys) {
            const chatId = key?.remoteJid;
            const msgId = key?.id;
            if (chatId && msgId && this.messages[chatId]?.[msgId]) {
                delete this.messages[chatId][msgId];
                this.emit('messages.delete', [key]);
            }
        }
    }

    loadMessage(jid, id) {
        try {
            if (!jid || !id) return undefined;
            const message = this.messages[jid]?.[id];
            if (message) {
                return JSON.parse(JSON.stringify(message));
            }
            return undefined;
        } catch (error) {
            this.logger.error('Error loading message:', error);
            return undefined;
        }
    }

    getMessages(jid) {
        if (!jid || !this.messages[jid]) return [];
        return Object.values(this.messages[jid]);
    }

    setPresence(chatId, presence = {}) {
        if (!chatId || !presence?.participant) {
            this.logger.warn(`Presence set: invalid chatId or participant`);
            return;
        }
        if (!this.presences[chatId]) this.presences[chatId] = {};
        this.presences[chatId][presence.participant] = presence;
        this.emit('presence.set', { chatId, presence });
    }

    updatePresence(chatId, presence = {}) {
        if (!chatId || !presence?.participant) {
            this.logger.warn(`Presence update: invalid chatId or participant`);
            return;
        }
        if (!this.presences[chatId]) this.presences[chatId] = {};
        this.presences[chatId][presence.participant] = { ...this.presences[chatId][presence.participant], ...presence };
        this.emit('presence.update', { chatId, presence });
    }

    setGroupMetadata(groupId, metadata = {}) {
        if (!groupId) return;
        this.groupMetadata[groupId] = metadata;
        this.emit('groups.update', [{ id: groupId, ...metadata }]);
    }

    updateGroupMetadata(update = []) {
        if (!Array.isArray(update)) return;
        for (const data of update) {
            if (data.id && this.groupMetadata[data.id]) {
                this.groupMetadata[data.id] = { ...this.groupMetadata[data.id], ...data };
                this.emit('groups.update', [data]);
            }
        }
    }

    setCallOffer(peerJid, offer = {}) {
        if (!peerJid) return;
        this.callOffer[peerJid] = offer;
        this.emit('call', [{ peerJid, ...offer }]);
    }

    clearCallOffer(peerJid) {
        if (!peerJid) return;
        delete this.callOffer[peerJid];
        this.emit('call.update', [{ peerJid, state: 'ENDED' }]);
    }

    setStickerPacks(packs = []) {
        if (!Array.isArray(packs)) return;
        this.stickerPacks = packs.reduce((acc, pack) => {
            if (pack?.id) acc[pack.id] = pack;
            return acc;
        }, {});
        this.emit('sticker-packs.set', packs);
    }

    upsertStickerPack(pack = {}) {
        if (!pack?.id) return;
        this.stickerPacks[pack.id] = { ...this.stickerPacks[pack.id], ...pack };
        this.emit('sticker-packs.upsert', [pack]);
    }

    setAuthState(state = {}) {
        this.authState = state;
    }

    getAuthState() {
        return this.authState;
    }

    markHistorySynced(jid) {
        if (!jid) return;
        this.syncedHistory[jid] = true;
    }

    isHistorySynced(jid) {
        if (!jid) return false;
        return !!this.syncedHistory[jid];
    }

    bind(ev) {
        if (!ev?.on) throw new Error('Event emitter is required for binding');

        const safeHandler = (handler) => {
            return (...args) => {
                try {
                    handler(...args);
                } catch (error) {
                    this.logger.error('Store event handler error:', error);
                }
            };
        };

        ev.on('contacts.set', safeHandler((contacts) => this.setContacts(contacts)));
        ev.on('contacts.upsert', safeHandler((contacts) => Array.isArray(contacts) && contacts.forEach(this.upsertContact.bind(this))));
        ev.on('contacts.update', safeHandler(this.updateContact.bind(this)));
        ev.on('contacts.delete', safeHandler(this.deleteContact.bind(this)));

        ev.on('chats.set', safeHandler((chats) => this.setChats(chats)));
        ev.on('chats.upsert', safeHandler((chats) => Array.isArray(chats) && chats.forEach(this.upsertChat.bind(this))));
        ev.on('chats.update', safeHandler(this.updateChat.bind(this)));
        ev.on('chats.delete', safeHandler(this.deleteChat.bind(this)));

        ev.on('messages.set', safeHandler(({ messages, jid }) => this.setMessages(jid, messages)));
        ev.on('messages.upsert', safeHandler(({ messages, type }) => Array.isArray(messages) && messages.forEach(msg => this.upsertMessage(msg, type))));
        ev.on('messages.update', safeHandler(this.updateMessage.bind(this)));
        ev.on('messages.delete', safeHandler(this.deleteMessage.bind(this)));

        ev.on('presence.update', safeHandler(({ id, presences }) => {
            if (presences && typeof presences === 'object') {
                Object.entries(presences).forEach(([participant, presence]) => {
                    this.updatePresence(id, { participant, ...presence });
                });
            }
        }));

        ev.on('groups.update', safeHandler(this.updateGroupMetadata.bind(this)));
        ev.on('groups.upsert', safeHandler((groups) => Array.isArray(groups) && groups.forEach(group => this.setGroupMetadata(group.id, group))));

        ev.on('call', safeHandler((calls) => Array.isArray(calls) && calls.forEach(call => {
            if (call.offer) {
                this.setCallOffer(call.from, call);
            } else if (call.status === 'timeout' || call.status === 'reject') {
                this.clearCallOffer(call.from);
            }
        })));

        this.logger.info('Store events bound successfully');
    }

    cleanup() {
        this.stopAutoSave();
        this.saveToFile();
        this.logger.info('Store cleanup completed');
    }
}

function makeInMemoryStore(options = {}) {
    return new InMemoryStore(options);
}

export { makeInMemoryStore, InMemoryStore };
