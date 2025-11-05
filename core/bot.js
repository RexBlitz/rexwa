import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    getAggregateVotesInPollMessage, 
    isJidNewsletter,
    isPnUser, // ✅ Correct import
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
        this.store.on('messages.upsert', (data) => {
            logger.debug(`📝 Store: ${data.messages.length} messages cached`);
        });

        this.store.on('contacts.upsert', (contacts) => {
            logger.debug(`👥 Store: ${contacts.length} contacts cached`);
        });

        this.store.on('chats.upsert', (chats) => {
            logger.debug(`💬 Store: ${chats.length} chats cached`);
        });

        // ✅ CRITICAL: LID mapping update listener
        this.store.on('lid-mapping.update', (mapping) => {
            logger.info(`🔑 LID Mapping Update: ${Object.keys(mapping).length} new mappings`);
            // Log sample for debugging
            const sampleKeys = Object.keys(mapping).slice(0, 3);
            sampleKeys.forEach(key => {
                logger.debug(`  ${key} -> ${mapping[key]}`);
            });
        });

        setInterval(() => {
            const stats = this.getStoreStats();
            logger.info(`📊 Store Stats - Chats: ${stats.chats}, Contacts: ${stats.contacts}, Messages: ${stats.messages}`);
        }, 300000);
    }

    getStoreStats() {
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
        logger.info('🔧 Initializing HyperWa Userbot with LID Support...');

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

        logger.info('✅ HyperWa Userbot initialized successfully!');
    }

    async startWhatsApp() {
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
                
                // ✅ FIX: Validate that MongoDB auth has required LID fields
                if (!state.keys) {
                    logger.error('❌ MongoDB auth state missing keys object!');
                    throw new Error('Invalid auth state: missing keys');
                }
                
                // Warn if LID mapping is missing (it might be empty initially)
                if (!state.keys['lid-mapping']) {
                    logger.warn('⚠️ No LID mapping in auth state - will be populated on first sync');
                }
                
                logger.info('✅ MongoDB auth state loaded with LID support');
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
                    // ✅ CRITICAL: This is what enables LID persistence
                    keys: makeCacheableSignalKeyStore(state.keys, logger.child({ module: 'keys' })),
                },
                version,
                logger: logger.child({ module: 'baileys' }),
                msgRetryCounterCache: this.msgRetryCounterCache,
                generateHighQualityLinkPreview: true,
                getMessage: this.getMessage.bind(this), 
                browser: ['HyperWa', 'Chrome', '3.0'],
                markOnlineOnConnect: false,
                firewall: true,
                printQRInTerminal: false
            });

            // ✅ FIX: Bind store IMMEDIATELY after socket creation
            this.store.bind(this.sock.ev);
            logger.info('🔗 Store bound to socket (LID mapping will sync)');

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

    // ========================================
    // ✅ LID-AWARE HELPER METHODS
    // ========================================

    /**
     * Get chat information from store
     */
    getChatInfo(jid) {
        return this.store.chats[jid] || null;
    }

    /**
     * ✅ IMPROVED: Get contact info with better LID handling
     */
    getContactInfo(jid) {
        if (!jid) return null;

        // Try direct lookup first
        let contact = this.store.contacts[jid];
        if (contact) {
            return contact;
        }

        // If no LID mapping available, return null
        if (!this.sock?.signalRepository?.lidMapping) {
            logger.debug(`No LID mapping available for ${jid}`);
            return null;
        }

        const lidStore = this.sock.signalRepository.lidMapping;
        
        try {
            if (isPnUser(jid)) {
                // User provided a PN, try to find contact by LID
                const lid = lidStore.getLIDForPN(jid);
                if (lid) {
                    contact = this.store.contacts[lid];
                    if (contact) {
                        logger.debug(`Found contact by LID for PN: ${jid}`);
                    }
                }
            } else {
                // User provided a LID, try to find contact by PN
                const pn = lidStore.getPNForLID(jid);
                if (pn) {
                    contact = this.store.contacts[pn];
                    if (contact) {
                        logger.debug(`Found contact by PN for LID: ${jid}`);
                    }
                }
            }
        } catch (error) {
            logger.debug(`Error in LID/PN lookup for ${jid}:`, error.message);
        }
        
        return contact || null;
    }

    /**
     * Get LID for phone number JID
     */
    getLIDForJID(jid) {
        if (!this.sock?.signalRepository?.lidMapping || !isPnUser(jid)) return null;
        try {
            return this.sock.signalRepository.lidMapping.getLIDForPN(jid);
        } catch (error) {
            logger.debug(`Error getting LID for ${jid}:`, error.message);
            return null;
        }
    }

    /**
     * Get PN (phone number) for LID
     */
    getPNForLID(lid) {
        if (!this.sock?.signalRepository?.lidMapping || isPnUser(lid)) return null;
        try {
            return this.sock.signalRepository.lidMapping.getPNForLID(lid);
        } catch (error) {
            logger.debug(`Error getting PN for ${lid}:`, error.message);
            return null;
        }
    }

    /**
     * ✅ IMPROVED: Resolve JID with better error handling
     */
    resolveJID(jid) {
        const contact = this.getContactInfo(jid);
        // As per docs, contact.id is the preferred ID
        return contact?.id || jid; 
    }

    /**
     * ✅ IMPROVED: Get message author with Alt JID support
     * Returns both primary and alternate JIDs
     */
    getMessageAuthor(msg) {
        if (!msg?.key) return null;

        if (msg.key.remoteJid?.endsWith('@g.us')) {
            // Group message - use participant and participantAlt
            return {
                id: msg.key.participant,
                altId: msg.key.participantAlt,
                isGroup: true,
                chatId: msg.key.remoteJid
            };
        } else {
            // Direct message - use remoteJid and remoteJidAlt
            return {
                id: msg.key.remoteJid,
                altId: msg.key.remoteJidAlt,
                isGroup: false,
                chatId: msg.key.remoteJid
            };
        }
    }

    /**
     * Get all messages for a chat
     */
    getChatMessages(jid, limit = 50) {
        const messages = this.store.getMessages(jid);
        return messages.slice(-limit).reverse();
    }

    /**
     * Search messages by text content
     */
    searchMessages(query, jid = null) {
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
                        text,
                        author: this.getMessageAuthor(msg) // ✅ Include author info
                    });
                }
            }
        }
        return results.slice(0, 100);
    }

    /**
     * ✅ IMPROVED: Get group metadata with LID/PN fields
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
            // ✅ Expose both LID and PN for owner (as per docs)
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
            descId: metadata.descId,
            // ✅ Participants now have .id, .phoneNumber, .lid fields
            participants: metadata.participants || [],
            participantCount: metadata.participants?.length || 0,
            chat: chat,
            // ✅ NEW: Include addressing mode if available
            addressingMode: metadata.addressingMode
        };
    }

    /**
     * ✅ IMPROVED: Get user stats with comprehensive LID/PN/Alt checking
     */
    getUserStats(jid) {
        let messageCount = 0;
        let lastMessageTime = null;
        
        // Build comprehensive set of identifiers to check
        const jidsToCheck = new Set([jid]);
        
        if (this.sock?.signalRepository?.lidMapping) {
            try {
                if (isPnUser(jid)) {
                    const lid = this.sock.signalRepository.lidMapping.getLIDForPN(jid);
                    if (lid) jidsToCheck.add(lid);
                } else {
                    const pn = this.sock.signalRepository.lidMapping.getPNForLID(jid);
                    if (pn) jidsToCheck.add(pn);
                }
            } catch (error) {
                logger.debug(`Error building JID set for ${jid}:`, error.message);
            }
        }

        logger.debug(`Checking user stats for identifiers: ${Array.from(jidsToCheck).join(', ')}`);

        for (const chatId of Object.keys(this.store.messages)) {
            const messages = this.store.getMessages(chatId);
            
            const userMessages = messages.filter(msg => {
                const author = this.getMessageAuthor(msg);
                if (!author) return false;
                
                // ✅ Check both primary ID and alternate ID
                return jidsToCheck.has(author.id) || 
                       (author.altId && jidsToCheck.has(author.altId));
            });
            
            messageCount += userMessages.length;
            
            if (userMessages.length > 0) {
                const lastMsg = userMessages[userMessages.length - 1];
                const msgTime = (typeof lastMsg.messageTimestamp === 'number' 
                    ? lastMsg.messageTimestamp 
                    : lastMsg.messageTimestamp.toNumber()) * 1000;
                    
                if (!lastMessageTime || msgTime > lastMessageTime) {
                    lastMessageTime = msgTime;
                }
            }
        }
        
        return {
            messageCount,
            lastMessageTime: lastMessageTime ? new Date(lastMessageTime) : null,
            isActive: lastMessageTime && (Date.now() - lastMessageTime) < (7 * 24 * 60 * 60 * 1000),
            checkedIdentifiers: Array.from(jidsToCheck) // ✅ Include for debugging
        };
    }

    /**
     * Export chat history
     */
    async exportChatHistory(jid, format = 'json') {
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
                const timestamp = new Date((typeof msg.messageTimestamp === 'number' 
                    ? msg.messageTimestamp 
                    : msg.messageTimestamp.toNumber()) * 1000).toLocaleString();
                    
                const author = this.getMessageAuthor(msg);
                const sender = msg.key.fromMe 
                    ? 'You' 
                    : (contact?.name || author?.id || 'Unknown');
                    
                const text = msg.message?.conversation || 
                           msg.message?.extendedTextMessage?.text || 
                           '[Media/Other]';
                           
                textExport += `[${timestamp}] ${sender}: ${text}\n`;
            }
            
            return textExport;
        }

        return exportData;
    }

    // ========================================
    // EVENT HANDLERS
    // ========================================

    setupEnhancedEventHandlers(saveCreds) {
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
                    if (events['message-receipt.update']) { 
                        logger.debug('📨 Message receipt update'); 
                    }
                    if (events['messages.reaction']) { 
                        logger.info(`😀 Message reactions: ${events['messages.reaction'].length}`); 
                    }
                    if (events['presence.update']) { 
                        logger.debug('👤 Presence updates'); 
                    }
                    if (events['chats.update']) { 
                        logger.debug('💬 Chats updated'); 
                    }
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
                logger.error('❌ Connection closed permanently. Clearing auth...');

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
            await this.messageHandler.handleMessages({ 
                messages: upsert.messages, 
                type: upsert.type 
            });
        } catch (error) {
            logger.warn('⚠️ Original message handler error:', error.message);
        }
    }

    async processIncomingMessage(msg, upsert) {
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
        logger.info(`✅ Connected to WhatsApp! User: ${this.sock.user?.id || 'Unknown'}`);

        // ✅ Log LID mapping status
        if (this.sock?.signalRepository?.lidMapping) {
            logger.info('✅ LID mapping system available');
        } else {
            logger.warn('⚠️ LID mapping system not available');
        }

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
        const owner = config.get('bot.owner');
        if (!owner) return;
        
        const authMethod = this.useMongoAuth ? 'MongoDB' : 'File-based';
        const storeStats = this.getStoreStats();
        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *Features Active:*\n` +
                              `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                              `• 🔑 LID Support: ✅\n` +
                              `• 📊 Store Stats: ${storeStats.messages} messages, ${storeStats.contacts} contacts\n\n` +
                              `Type *${config.get('bot.prefix')}help* for available commands!`;
        
        try {
            await this.sendMessage(owner, { text: startupMessage });
        } catch (error) {
            logger.warn('⚠️ Failed to send startup message:', error.message);
        }
        
        if (this.telegramBridge) {
            try {
                await this.telegramBridge.logToTelegram('🚀 HyperWa Bot Started', startupMessage);
            } catch (err) {
                logger.warn('⚠️ Telegram log failed:', err.message);
            }
        }
    }

    async connect() {
        if (!this.sock) {
            await this.startWhatsApp();
        }
        return this.sock;
    }

    async sendMessage(jid, content) {
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }
        return await this.sock.sendMessage(jid, content);
    }

    async shutdown() {
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
