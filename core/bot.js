import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    getAggregateVotesInPollMessage, 
    isJidNewsletter,
    isPnUser, // <-- ADDED: As per the guide, replaces isJidUser
    delay, 
    proto 
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs-extra';
import path from 'path';
import NodeCache from '@cacheable/node-cache';
import { makeInMemoryStore } from './store.js';
import config from '../config.js';
import logger from './logger.js';
import MessageHandler from './message-handler.js';
import { connectDb } from '../utils/db.js';
import ModuleLoader from './module-loader.js';
// ✅ CRITICAL NOTE: Ensure your useMongoAuthState implementation
// correctly saves and loads state.keys.lidMapping and state.keys.deviceIndex!
import { useMongoAuthState } from '../utils/mongoAuthState.js';

class HyperWaBot {
    constructor() {
        this.sock = null;
        this.authPath = './auth_info';
        this.messageHandler = new MessageHandler(this);
        this.telegramBridge = null;
        this.isShuttingDown = false;
        this.db = null;
        this.moduleLoader = new ModuleLoader(this);
        this.qrCodeSent = false;
        this.useMongoAuth = config.get('auth.useMongoAuth', false);
        this.isFirstConnection = true;
        
        this.store = makeInMemoryStore({
            logger: logger.child({ module: 'store' }),
            filePath: './whatsapp-store.json',
            autoSaveInterval: 30000
        });
    
        this.store.loadFromFile();
    
        this.msgRetryCounterCache = new NodeCache();
        this.onDemandMap = new Map();
    
        setInterval(() => {
            if (this.onDemandMap.size > 100) {
                this.onDemandMap.clear();
            }
        }, 300000); 

        this.setupStoreEventListeners();
    }

    setupStoreEventListeners() {
        // ... (Your existing setupStoreEventListeners code - it's already correct)
        // [OMITTED FOR BREVITY - NO CHANGES NEEDED HERE]
        // It correctly handles 'lid-mapping.update'
        this.store.on('messages.upsert', (data) => {
            logger.debug(`📝 Store: ${data.messages.length} messages cached`);
        });

        this.store.on('contacts.upsert', (contacts) => {
            logger.debug(`👥 Store: ${contacts.length} contacts cached`);
        });

        this.store.on('chats.upsert', (chats) => {
            logger.debug(`💬 Store: ${chats.length} chats cached`);
        });

        // LID mapping update listener (Baileys 6.8.0+)
        this.store.on('lid-mapping.update', (mapping) => {
            logger.debug(`🔑 LID Mapping Update: ${Object.keys(mapping).length} mappings`);
        });

        // Log store statistics periodically
        setInterval(() => {
            const stats = this.getStoreStats();
            logger.info(`📊 Store Stats - Chats: ${stats.chats}, Contacts: ${stats.contacts}, Messages: ${stats.messages}`);
        }, 300000); // Every 5 minutes
    }


    getStoreStats() {
        // ... (Your existing getStoreStats code - no changes needed)
        // [OMITTED FOR BREVITY]
        const chatCount = Object.keys(this.store.chats).length;
        const contactCount = Object.keys(this.store.contacts).length;
        const messageCount = Object.values(this.store.messages)
            .reduce((total, chatMessages) => total + Object.keys(chatMessages).length, 0);
        
        return {
            chats: chatCount,
            contacts: contactCount,
            messages: messageCount
        };
    }

    async initialize() {
        // ... (Your existing initialize code - no changes needed)
        // [OMITTED FOR BREVITY]
        logger.info('🔧 Initializing HyperWa Userbot with Enhanced Store...');

        try {
            this.db = await connectDb();
            logger.info('✅ Database connected successfully!');
        } catch (error) {
            logger.error('❌ Failed to connect to database:', error);
            process.exit(1);
        }

        if (config.get('telegram.enabled')) {
            try {
                const { default: TelegramBridge } = await import('../telegram/bridge.js');
                this.telegramBridge = new TelegramBridge(this);
                await this.telegramBridge.initialize();
                logger.info('✅ Telegram bridge initialized');

                try {
                    await this.telegramBridge.sendStartMessage();
                } catch (err) {
                    logger.warn('⚠️ Failed to send start message via Telegram:', err.message);
                }
            } catch (error) {
                logger.warn('⚠️ Telegram bridge failed to initialize:', error.message);
                this.telegramBridge = null;
            }
        }

        await this.moduleLoader.loadModules();
        await this.startWhatsApp();

        logger.info('✅ HyperWa Userbot with Enhanced Store initialized successfully!');
    }

    async startWhatsApp() {
        // ... (Your existing startWhatsApp logic is correct)
        // It correctly passes state.keys to makeCacheableSignalKeyStore,
        // which is required for LID-mapping persistence.
        // [OMITTED FOR BREVITY]
        let state, saveCreds;

        if (this.sock) {
            logger.info('🧹 Cleaning up existing WhatsApp socket');
            this.sock.ev.removeAllListeners();
            await this.sock.end();
            this.sock = null;
        }

        if (this.useMongoAuth) {
            logger.info('🔧 Using MongoDB auth state...');
            try {
                ({ state, saveCreds } = await useMongoAuthState());
            } catch (error) {
                logger.error('❌ Failed to initialize MongoDB auth state:', error);
                logger.info('🔄 Falling back to file-based auth...');
                ({ state, saveCreds } = await useMultiFileAuthState(this.authPath));
            }
        } else {
            logger.info('🔧 Using file-based auth state...');
            ({ state, saveCreds } = await useMultiFileAuthState(this.authPath));
        }

        const { version, isLatest } = await fetchLatestBaileysVersion();
        logger.info(`📱 Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        try {
            this.sock = makeWASocket({
                auth: {
                    creds: state.creds,
                    // This is CRITICAL for LIDs.
                    keys: makeCacheableSignalKeyStore(state.keys, logger.child({ module: 'keys' })),
                },
                version,
                logger: logger.child({ module: 'baileys' }),
                msgRetryCounterCache: this.msgRetryCounterCache,
                generateHighQualityLinkPreview: true,
                getMessage: this.getMessage.bind(this), 
                browser: ['HyperWa', 'Chrome', '3.0'],
                markOnlineOnConnect: false ,
                firewall: true,
                printQRInTerminal: false
            });

    
            this.store.bind(this.sock.ev);
            logger.info('🔗 Store bound to socket');

            const connectionPromise = new Promise((resolve, reject) => {
                const connectionTimeout = setTimeout(() => {
                    if (!this.sock.user) {
                        logger.warn('❌ QR code scan timed out after 30 seconds');
                        this.sock.ev.removeAllListeners();
                        this.sock.end();
                        this.sock = null;
                        reject(new Error('QR code scan timed out'));
                    }
                }, 30000);

                this.sock.ev.on('connection.update', update => {
                    if (update.connection === 'open') {
                        clearTimeout(connectionTimeout);
                        resolve();
                    }
                });
            });

            this.setupEnhancedEventHandlers(saveCreds);
            await connectionPromise;
        } catch (error) {
            logger.error('❌ Failed to initialize WhatsApp socket:', error);
            logger.info('🔄 Retrying with new QR code...');
            setTimeout(() => this.startWhatsApp(), 5000);
        }
    }

    async getMessage(key) {
        // ... (Your existing getMessage logic is correct)
        // [OMITTED FOR BREVITY]
        try {
            if (!key?.remoteJid || !key?.id) {
                return undefined;
            }

            const storedMessage = this.store.loadMessage(key.remoteJid, key.id);
            if (storedMessage?.message) {
                logger.debug(`📨 Retrieved from store: ${key.id}`);
                return storedMessage.message;
            }
            return undefined;
            
        } catch (error) {
            logger.debug('⚠️ getMessage error:', error.message);
            return undefined;
        }
    }

    //
    // -----------------------------------------------------------------
    // ✅ REFINED LID-AWARE HELPER METHODS
    // -----------------------------------------------------------------
    //

    /**
     * Get chat information from store
     */
    getChatInfo(jid) {
        return this.store.chats[jid] || null;
    }

    /**
     * Get contact information from store (LID-compatible)
     * This is now robust and can resolve from PN or LID.
     */
    getContactInfo(jid) {
        let contact = this.store.contacts[jid];
        if (contact) {
            return contact;
        }

        if (!this.sock?.signalRepository?.lidMapping) {
            return null;
        }

        const lidStore = this.sock.signalRepository.lidMapping;
        
        if (isPnUser(jid)) {
            // User provided a PN, try to find contact by LID
            const lid = lidStore.getLIDForPN(jid);
            if (lid) {
                contact = this.store.contacts[lid];
            }
        } else {
            // User provided a LID, try to find contact by PN
            const pn = lidStore.getPNForLID(jid);
            if (pn) {
                contact = this.store.contacts[pn];
            }
        }
        
        return contact || null;
    }

    /**
     * Get LID for phone number JID
     */
    getLIDForJID(jid) {
        if (!this.sock?.signalRepository?.lidMapping || !isPnUser(jid)) return null;
        return this.sock.signalRepository.lidMapping.getLIDForPN(jid);
    }

    /**
     * Get PN (phone number) for LID
     */
    getPNForLID(lid) {
        if (!this.sock?.signalRepository?.lidMapping || isPnUser(lid)) return null;
        return this.sock.signalRepository.lidMapping.getPNForLID(lid);
    }

    /**
     * Resolve JID (works with both LID and PN)
     * Returns the 'id' field from the contact, which is the preferred JID.
     */
    resolveJID(jid) {
        const contact = this.getContactInfo(jid);
        // As per docs, contact.id is the preferred ID
        return contact?.id || jid; 
    }

    /**
     * (NEW HELPER) Gets the author of a message, accounting for DMs and groups.
     * @returns {{id: string, altId: string | undefined}}
     */
    getMessageAuthor(msg) {
        if (msg.key.remoteJid.endsWith('@g.us')) {
            // Group message
            return {
                id: msg.key.participant,
                altId: msg.key.participantAlt
            };
        } else {
            // Direct message (DM)
            return {
                id: msg.key.remoteJid,
                altId: msg.key.remoteJidAlt
            };
        }
    }


    /**
     * Get all messages for a chat
     */
    getChatMessages(jid, limit = 50) {
        const messages = this.store.getMessages(jid);
        return messages.slice(-limit).reverse(); // Get latest messages
    }

    /**
     * Search messages by text content
     */
    searchMessages(query, jid = null) {
        // ... (Your existing searchMessages code - no changes needed)
        // [OMITTED FOR BREVITY]
        const results = [];
        const chatsToSearch = jid ? [jid] : Object.keys(this.store.messages);
        
        for (const chatId of chatsToSearch) {
            const messages = this.store.getMessages(chatId);
            for (const msg of messages) {
                const text = msg.message?.conversation || 
                           msg.message?.extendedTextMessage?.text || '';
                if (text.toLowerCase().includes(query.toLowerCase())) {
                    results.push({
                        chatId,
                        message: msg,
                        text
                    });
                }
            }
        }
        return results.slice(0, 100);
    }

    /**
     * Get group metadata with participant info (REFINED)
     * Exposes new LID/PN fields from metadata.
     */
    getGroupInfo(jid) {
        const metadata = this.store.groupMetadata[jid];
        const chat = this.store.chats[jid];
        
        if (!metadata) {
            return null;
        }

        return {
            id: metadata.id,
            subject: metadata.subject,
            // Expose both LID and PN for owner
            owner: { 
                id: metadata.owner, 
                pn: metadata.ownerPn 
            },
            descOwner: {
                id: metadata.descOwner,
                pn: metadata.descOwnerPn
            },
            creation: metadata.creation,
            desc: metadata.desc,
            // Note: participants is an array of Contact objects
            // Each object has .id, .phoneNumber, .lid
            participants: metadata.participants || [],
            chat: chat
        };
    }

    /**
     * Get user's message history statistics (LID-compatible REFINED)
     * Robustly finds user messages by checking both LID and PN.
     */
    getUserStats(jid) {
        let messageCount = 0;
        let lastMessageTime = null;
        
        // Get both LID and PN for the user
        const lidStore = this.sock?.signalRepository?.lidMapping;
        let pn = null;
        let lid = null;
        
        if (lidStore) {
            pn = isPnUser(jid) ? jid : lidStore.getPNForLID(jid);
            lid = !isPnUser(jid) ? jid : lidStore.getLIDForPN(jid);
        } else {
            pn = isPnUser(jid) ? jid : null;
            lid = !isPnUser(jid) ? jid : null;
        }

        const jidsToCheck = new Set([pn, lid].filter(Boolean));
        if (jidsToCheck.size === 0) {
            jidsToCheck.add(jid); // Fallback
        }

        for (const chatId of Object.keys(this.store.messages)) {
            const messages = this.store.getMessages(chatId);
            
            const userMessages = messages.filter(msg => {
                // Check both DM and Group contexts
                const author = this.getMessageAuthor(msg);
                return jidsToCheck.has(author.id) || (author.altId && jidsToCheck.has(author.altId));
            });
            
            messageCount += userMessages.length;
            
            if (userMessages.length > 0) {
                const lastMsg = userMessages[userMessages.length - 1];
                const msgTime = (typeof lastMsg.messageTimestamp === 'number' ? lastMsg.messageTimestamp : lastMsg.messageTimestamp.toNumber()) * 1000;
                if (!lastMessageTime || msgTime > lastMessageTime) {
                    lastMessageTime = msgTime;
                }
            }
        }
        
        return {
            messageCount,
            lastMessageTime: lastMessageTime ? new Date(lastMessageTime) : null,
            isActive: lastMessageTime && (Date.now() - lastMessageTime) < (7 * 24 * 60 * 60 * 1000) // Active in last 7 days
        };
    }

    /**
     * Export chat history
     */
    async exportChatHistory(jid, format = 'json') {
        // ... (Your existing exportChatHistory code - no changes needed)
        // [OMITTED FOR BREVITY]
        const chat = this.getChatInfo(jid);
        const messages = this.getChatMessages(jid, 1000); 
        const contact = this.getContactInfo(jid);
        
        const exportData = {
            chat,
            contact,
            messages,
            exportedAt: new Date().toISOString(),
            totalMessages: messages.length
        };

        if (format === 'txt') {
            let textExport = `Chat Export for ${contact?.name || jid}\n`;
            textExport += `Exported on: ${new Date().toISOString()}\n`;
            textExport += `Total Messages: ${messages.length}\n\n`;
            textExport += '='.repeat(50) + '\n\n';
            
            for (const msg of messages) {
                const timestamp = new Date((typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp.toNumber()) * 1000).toLocaleString();
                const sender = msg.key.fromMe ? 'You' : (contact?.name || msg.key.participant || 'Unknown');
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[Media/Other]';
                textExport += `[${timestamp}] ${sender}: ${text}\n`;
            }
            
            return textExport;
        }

        return exportData;
    }


    //
    // -----------------------------------------------------------------
    // END OF REFINED HELPERS
    // -----------------------------------------------------------------
    //


    setupEnhancedEventHandlers(saveCreds) {
        // ... (Your existing setupEnhancedEventHandlers code is excellent)
        // It already logs 'labels.association', 'call', 'messaging-history.set', etc.
        // [OMITTED FOR BREVITY]
        this.sock.ev.process(async (events) => {
            try {
                if (events['connection.update']) {
                    await this.handleConnectionUpdate(events['connection.update']);
                }

                if (events['creds.update']) {
                    await saveCreds();
                }

                if (events['messages.upsert']) {
                    await this.handleMessagesUpsert(events['messages.upsert']);
                }

                if (!process.env.DOCKER) {
                    if (events['labels.association']) {
                        logger.info('📋 Label association update:', events['labels.association']);
                    }
                    if (events['labels.edit']) {
                        logger.info('📝 Label edit update:', events['labels.edit']);
                    }
                    if (events.call) {
                        logger.info('📞 Call event received:', events.call);
                        for (const call of events.call) {
                            this.store.setCallOffer(call.from, call);
                        }
                    }
                    if (events['messaging-history.set']) {
                        const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set'];
                        if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
                            logger.info('📥 Received on-demand history sync, messages:', messages.length);
                        }
                        logger.info(`📊 History sync: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (latest: ${isLatest}, progress: ${progress}%)`);
                    }
                    if (events['messages.update']) {
                        for (const { key, update } of events['messages.update']) {
                            if (update.pollUpdates) {
                                logger.info('📊 Poll update received');
                            }
                        }
                    }
                    if (events['message-receipt.update']) { logger.debug('📨 Message receipt update'); }
                    if (events['messages.reaction']) { logger.info(`😀 Message reactions: ${events['messages.reaction'].length}`); }
                    if (events['presence.update']) { logger.debug('👤 Presence updates'); }
                    if (events['chats.update']) { logger.debug('💬 Chats updated'); }
                    if (events['contacts.update']) {
                        for (const contact of events['contacts.update']) {
                            if (typeof contact.imgUrl !== 'undefined') {
                                logger.info(`👤 Contact ${contact.id} profile pic updated`);
                            }
                        }
                    }
                    if (events['chats.delete']) {
                        logger.info('🗑️ Chats deleted:', events['chats.delete']);
                    }
                }
            } catch (error) {
                logger.warn('⚠️ Event processing error:', error.message);
            }
        });
    }

    async handleConnectionUpdate(update) {
        // ... (Your existing handleConnectionUpdate code is correct)
        // [OMITTED FOR BREVITY]
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logger.info('📱 WhatsApp QR code generated');
            qrcode.generate(qr, { small: true });

            if (this.telegramBridge) {
                try {
                    await this.telegramBridge.sendQRCode(qr);
                } catch (error) {
                    logger.warn('⚠️ TelegramBridge failed to send QR:', error.message);
                }
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect && !this.isShuttingDown) {
                logger.warn('🔄 Connection closed, reconnecting...');
                this.store.saveToFile();
                setTimeout(() => this.startWhatsApp(), 5000);
            } else {
                logger.error('❌ Connection closed permanently. Please delete auth_info and restart.');

                if (this.useMongoAuth) {
                    try {
                        const db = await connectDb();
                        const coll = db.collection("auth");
                        await coll.deleteOne({ _id: "session" });
                        logger.info('🗑️ MongoDB auth session cleared');
                    } catch (error) {
                        logger.error('❌ Failed to clear MongoDB auth session:', error);
                    }
                }
                this.store.saveToFile();
                process.exit(1);
            }
        } else if (connection === 'open') {
            await this.onConnectionOpen();
        }
    }

    async handleMessagesUpsert(upsert) {
        // ... (Your existing handleMessagesUpsert code is correct)
        // [OMITTED FOR BREVITY]
        if (upsert.type === 'notify') {
            for (const msg of upsert.messages) {
                try {
                    await this.processIncomingMessage(msg, upsert);
                } catch (error) {
                    logger.warn('⚠️ Message processing error:', error.message);
                }
            }
        }

        try {
            await this.messageHandler.handleMessages({ messages: upsert.messages, type: upsert.type });
        } catch (error) {
            logger.warn('⚠️ Original message handler error:', error.message);
        }
    }

    async processIncomingMessage(msg, upsert) {
        // ... (Your existing processIncomingMessage code is correct)
        // [OMITTED FOR BREVITY]
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
        if (!text) return;
        if (text === "requestPlaceholder" && !upsert.requestId) {
            const messageId = await this.sock.requestPlaceholderResend(msg.key);
            logger.info('🔄 Requested placeholder resync, ID:', messageId);
            return;
        }
        if (text === "onDemandHistSync") {
            const messageId = await this.sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp);
            logger.info('📥 Requested on-demand sync, ID:', messageId);
            return;
        }
    }

    async onConnectionOpen() {
        // ... (Your existing onConnectionOpen code is correct)
        // `this.sock.user.id` is the correct way to get the bot's own JID.
        // [OMITTED FOR BREVITY]
        logger.info(`✅ Connected to WhatsApp! User: ${this.sock.user?.id || 'Unknown'}`);

        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to: ${this.sock.user.id}`);
        }

        if (this.telegramBridge) {
            try {
                await this.telegramBridge.setupWhatsAppHandlers();
            } catch (err) {
                logger.warn('⚠️ Failed to setup Telegram WhatsApp handlers:', err.message);
            }
        }

        if (this.isFirstConnection) {
            await this.sendStartupMessage();
            this.isFirstConnection = false;
        } else {
            logger.info('🔄 Reconnected - skipping startup message');
        }

        if (this.telegramBridge) {
            try {
                await this.telegramBridge.syncWhatsAppConnection();
            } catch (err) {
                logger.warn('⚠️ Telegram sync error:', err.message);
            }
        }
    }

    async sendStartupMessage() {
        // ... (Your existing sendStartupMessage code is correct)
        // [OMITTED FOR BREVITY]
        const owner = config.get('bot.owner');
        if (!owner) return;
        const authMethod = this.useMongoAuth ? 'MongoDB' : 'File-based';
        const storeStats = this.getStoreStats();
        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *HyperWa Features Active:*\n` +
                              `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                              `Type *${config.get('bot.prefix')}help* for available commands!`;
        try {
            await this.sendMessage(owner, { text: startupMessage });
        } catch {}
        if (this.telegramBridge) {
            try {
                await this.telegramBridge.logToTelegram('🚀 HyperWa Bot Started', startupMessage);
            } catch (err) {
                logger.warn('⚠️ Telegram log failed:', err.message);
            }
        }
    }

    async connect() {
        // ... (Your existing connect code - no changes needed)
        // [OMITTED FOR BREVITY]
        if (!this.sock) {
            await this.startWhatsApp();
        }
        return this.sock;
    }

    async sendMessage(jid, content) {
        // ... (Your existing sendMessage code - no changes needed)
        // [OMITTED FOR BREVITY]
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }
        return await this.sock.sendMessage(jid, content);
    }

    async shutdown() {
        // ... (Your existing shutdown code - no changes needed)
        // [OMITTED FOR BREVITY]
        logger.info('🛑 Shutting down HyperWa Userbot...');
        this.isShuttingDown = true;
        this.store.cleanup();
        if (this.telegramBridge) {
            try {
                await this.telegramBridge.shutdown();
            } catch (err) {
                logger.warn('⚠️ Telegram shutdown error:', err.message);
            }
        }
        if (this.sock) {
            await this.sock.end();
        }
        logger.info('✅ HyperWa Userbot shutdown complete');
    }
}

export { HyperWaBot };
export default HyperWaBot;
