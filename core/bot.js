import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    getAggregateVotesInPollMessage, 
    isJidNewsletter, 
    isPnUser,
    downloadAndProcessHistorySyncNotification,
    WAMessageAddressingMode,
    delay, 
    proto 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
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
        this.usePairingCode = config.get('auth.usePairingCode', false);
        this.isFirstConnection = true;

        // Initialize store
        this.store = makeInMemoryStore({
            logger: logger.child({ module: 'store' }),
            filePath: './whatsapp-store.json',
            autoSaveInterval: 30000
        });
        
        this.store.loadFromFile();
        
        // Cache setup (official way)
        this.msgRetryCounterCache = new NodeCache();
        this.onDemandMap = new Map();
        
        // Memory cleanup
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

        // Official LID mapping update listener (Baileys 6.8.0+)
        this.store.on('lid-mapping.update', (mapping) => {
            logger.debug(`🔑 LID Mapping Update: ${Object.keys(mapping).length} mappings`);
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
        logger.info('🔧 Initializing HyperWa Userbot...');

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
                version,
                logger: logger.child({ module: 'baileys' }),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger.child({ module: 'keys' })),
                },
                msgRetryCounterCache: this.msgRetryCounterCache,
                generateHighQualityLinkPreview: true,
                getMessage: this.getMessage.bind(this),
                browser: ['HyperWa', 'Chrome', '3.0'],
                markOnlineOnConnect: false,
                printQRInTerminal: false
            });

            // Bind store to socket (official way)
            this.store.bind(this.sock.ev);
            logger.info('🔗 Store bound to socket');

            // Official: Pairing code for Web clients
            if (this.usePairingCode && !this.sock.authState.creds.registered) {
                const phoneNumber = config.get('auth.phoneNumber');
                if (phoneNumber) {
                    const code = await this.sock.requestPairingCode(phoneNumber);
                    logger.info(`📱 Pairing code: ${code}`);
                    
                    if (this.telegramBridge) {
                        try {
                            await this.telegramBridge.sendMessage(`🔐 *Pairing Code*\n\nYour pairing code is: \`${code}\`\n\nEnter this code in WhatsApp Web to link your device.`);
                        } catch (error) {
                            logger.warn('⚠️ Failed to send pairing code via Telegram:', error.message);
                        }
                    }
                } else {
                    logger.warn('⚠️ Pairing code enabled but no phone number configured. Set auth.phoneNumber in config.');
                }
            }

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

            this.setupEventHandlers(saveCreds);
            await connectionPromise;
        } catch (error) {
            logger.error('❌ Failed to initialize WhatsApp socket:', error);
            logger.info('🔄 Retrying with new QR code...');
            setTimeout(() => this.startWhatsApp(), 5000);
        }
    }

    // Official getMessage implementation (returns undefined, not fake messages)
    async getMessage(key) {
        try {
            if (!key?.remoteJid || !key?.id) {
                return undefined;
            }

            // Try to get from store
            const storedMessage = this.store.loadMessage(key.remoteJid, key.id);
            if (storedMessage?.message) {
                logger.debug(`📨 Retrieved from store: ${key.id}`);
                return storedMessage.message;
            }

            // Try alternate JID if available (LID/PN)
            if (key.remoteJidAlt) {
                const altMessage = this.store.loadMessage(key.remoteJidAlt, key.id);
                if (altMessage?.message) {
                    logger.debug(`📨 Retrieved from store via alt JID: ${key.id}`);
                    return altMessage.message;
                }
            }

            // Return undefined - Baileys will handle retry
            return undefined;
            
        } catch (error) {
            logger.debug('⚠️ getMessage error:', error.message);
            return undefined;
        }
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.process(async (events) => {
            try {
                // Connection update
                if (events['connection.update']) {
                    await this.handleConnectionUpdate(events['connection.update']);
                }

                // Credentials update
                if (events['creds.update']) {
                    await saveCreds();
                }

                // Messages upsert
                if (events['messages.upsert']) {
                    await this.handleMessagesUpsert(events['messages.upsert']);
                }

                // Label association
                if (events['labels.association']) {
                    logger.info('📋 Label association:', events['labels.association']);
                }

                // Label edit
                if (events['labels.edit']) {
                    logger.info('📝 Label edit:', events['labels.edit']);
                }

                // Call events
                if (events.call) {
                    logger.info('📞 Call event:', events.call);
                }

                // History sync
                if (events['messaging-history.set']) {
                    const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set'];
                    
                    if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
                        logger.info('📥 Received on-demand history sync, messages:', messages.length);
                    }
                    
                    logger.info(`📊 recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`);
                }

                // Messages update
                if (events['messages.update']) {
                    logger.info('📝 Messages update:', JSON.stringify(events['messages.update'], undefined, 2));
                    
                    for (const { key, update } of events['messages.update']) {
                        if (update.pollUpdates) {
                            const pollCreation = this.store.loadMessage(key.remoteJid, key.id);
                            if (pollCreation?.message) {
                                const aggregateVotes = getAggregateVotesInPollMessage({
                                    message: pollCreation.message,
                                    pollUpdates: update.pollUpdates,
                                });
                                logger.info('📊 Poll update, aggregation:', aggregateVotes);
                            }
                        }
                    }
                }

                // Message receipt update
                if (events['message-receipt.update']) {
                    logger.debug('📨 Message receipt update:', events['message-receipt.update']);
                }

                // Reactions
                if (events['messages.reaction']) {
                    logger.info(`😀 Reactions (${events['messages.reaction'].length}):`, events['messages.reaction']);
                }

                // Presence update
                if (events['presence.update']) {
                    logger.debug('👤 Presence update:', events['presence.update']);
                }

                // Chats update
                if (events['chats.update']) {
                    logger.debug('💬 Chats update:', events['chats.update']);
                }

                // Contacts update with profile picture handling
                if (events['contacts.update']) {
                    for (const contact of events['contacts.update']) {
                        if (typeof contact.imgUrl !== 'undefined') {
                            const newUrl = contact.imgUrl === null
                                ? null
                                : await this.sock.profilePictureUrl(contact.id).catch(() => null);
                            logger.info(`👤 Contact ${contact.id} has new profile pic: ${newUrl}`);
                        }
                    }
                }

                // Chats delete
                if (events['chats.delete']) {
                    logger.info('🗑️ Chats deleted:', events['chats.delete']);
                }

            } catch (error) {
                logger.warn('⚠️ Event processing error:', error.message);
            }
        });
    }

    async handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !this.usePairingCode) {
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
            // Official: Use Boom for proper error handling
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect && !this.isShuttingDown) {
                logger.warn('🔄 Connection closed, reconnecting...');
                this.store.saveToFile();
                setTimeout(() => this.startWhatsApp(), 5000);
            } else {
                logger.error('❌ Connection closed permanently. You are logged out.');

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

        logger.info('🔄 connection update', update);
    }

    async handleMessagesUpsert(upsert) {
        logger.info('📨 recv messages:', JSON.stringify(upsert, undefined, 2));

        // Check for placeholder message
        if (upsert.requestId) {
            logger.info('📦 Placeholder message received for request id=' + upsert.requestId, upsert);
        }

        if (upsert.type === 'notify') {
            for (const msg of upsert.messages) {
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                
                if (!text) continue;

                // Handle requestPlaceholder command
                if (text === "requestPlaceholder" && !upsert.requestId) {
                    const messageId = await this.sock.requestPlaceholderResend(msg.key);
                    logger.info('🔄 Requested placeholder resync, id=', messageId);
                    continue;
                }

                // Handle onDemandHistSync command
                if (text === "onDemandHistSync") {
                    const messageId = await this.sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp);
                    logger.info('📥 Requested on-demand sync, id=', messageId);
                    continue;
                }
            }
        }

        // Call existing message handler
        try {
            await this.messageHandler.handleMessages({ 
                messages: upsert.messages, 
                type: upsert.type 
            });
        } catch (error) {
            logger.warn('⚠️ Message handler error:', error.message);
        }
    }

    async onConnectionOpen() {
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
        const owner = config.get('bot.owner');
        if (!owner) return;

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

    // Official: Send message with typing indicator
    async sendMessageWithTyping(content, jid) {
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }

        try {
            await this.sock.presenceSubscribe(jid);
            await delay(500);

            await this.sock.sendPresenceUpdate('composing', jid);
            await delay(2000);

            await this.sock.sendPresenceUpdate('paused', jid);

            return await this.sock.sendMessage(jid, content);
        } catch (error) {
            logger.error('❌ Send message with typing error:', error);
            throw error;
        }
    }

    // ==================== LID-Compatible Helper Methods ====================

    /**
     * Get contact information (LID-compatible)
     * Uses contact.id as preferred identifier
     */
    getContactInfo(jid) {
        if (!jid) return null;
        
        const contact = this.store.contacts[jid];
        if (contact) return contact;
        
        // Try alternate format via LID mapping
        if (this.sock?.signalRepository?.lidMapping) {
            if (jid.endsWith('@s.whatsapp.net')) {
                const lid = this.sock.signalRepository.lidMapping.getLIDForPN(jid);
                if (lid) return this.store.contacts[lid];
            } else if (jid.endsWith('@lid')) {
                const pn = this.sock.signalRepository.lidMapping.getPNForLID(jid);
                if (pn) return this.store.contacts[pn];
            }
        }
        
        return null;
    }

    /**
     * Get chat info
     */
    getChatInfo(jid) {
        return this.store.chats[jid] || null;
    }

    /**
     * Get chat messages (LID-compatible)
     */
    getChatMessages(jid, limit = 50) {
        let messages = this.store.getMessages(jid);
        
        if (messages.length === 0 && this.sock?.signalRepository?.lidMapping) {
            if (jid.endsWith('@s.whatsapp.net')) {
                const lid = this.sock.signalRepository.lidMapping.getLIDForPN(jid);
                if (lid) messages = this.store.getMessages(lid);
            } else if (jid.endsWith('@lid')) {
                const pn = this.sock.signalRepository.lidMapping.getPNForLID(jid);
                if (pn) messages = this.store.getMessages(pn);
            }
        }
        
        return messages.slice(-limit).reverse();
    }

    /**
     * Get group info with LID fields (official structure)
     */
    getGroupInfo(jid) {
        const metadata = this.store.groupMetadata[jid];
        const chat = this.store.chats[jid];
        
        if (!metadata) return null;
        
        // Participants use new Contact structure: id, lid, phoneNumber
        const participants = metadata.participants?.map(p => {
            const contact = this.getContactInfo(p.id);
            return {
                id: p.id,
                lid: p.lid,
                phoneNumber: p.phoneNumber,
                name: contact?.name || contact?.notify || 'Unknown',
                admin: p.admin,
                isSuperAdmin: p.isSuperAdmin
            };
        }) || [];
        
        return {
            metadata,
            chat,
            participants,
            owner: metadata.owner,
            ownerPn: metadata.ownerPn,
            descOwner: metadata.descOwner,
            descOwnerPn: metadata.descOwnerPn
        };
    }

    /**
     * Get user statistics (checks all message key fields)
     */
    getUserStats(jid) {
        let messageCount = 0;
        let lastMessageTime = null;
        
        let alternateJid = null;
        if (this.sock?.signalRepository?.lidMapping) {
            if (jid.endsWith('@s.whatsapp.net')) {
                alternateJid = this.sock.signalRepository.lidMapping.getLIDForPN(jid);
            } else if (jid.endsWith('@lid')) {
                alternateJid = this.sock.signalRepository.lidMapping.getPNForLID(jid);
            }
        }
        
        for (const chatId of Object.keys(this.store.messages)) {
            const messages = this.store.getMessages(chatId);
            
            for (const msg of messages) {
                const key = msg.key;
                
                // Check all official key fields (6.8.0+)
                const isUserMessage = (
                    key.participant === jid ||
                    key.participantAlt === jid ||
                    key.remoteJid === jid ||
                    key.remoteJidAlt === jid ||
                    (alternateJid && (
                        key.participant === alternateJid ||
                        key.participantAlt === alternateJid ||
                        key.remoteJid === alternateJid ||
                        key.remoteJidAlt === alternateJid
                    ))
                );
                
                if (isUserMessage) {
                    messageCount++;
                    
                    const msgTime = msg.messageTimestamp * 1000;
                    if (!lastMessageTime || msgTime > lastMessageTime) {
                        lastMessageTime = msgTime;
                    }
                }
            }
        }
        
        return {
            messageCount,
            lastMessageTime: lastMessageTime ? new Date(lastMessageTime) : null,
            isActive: lastMessageTime && (Date.now() - lastMessageTime) < (7 * 24 * 60 * 60 * 1000)
        };
    }

    /**
     * Search messages
     */
    searchMessages(query, jid = null) {
        const results = [];
        let chatsToSearch = Object.keys(this.store.messages);
        
        if (jid) {
            const searchJids = [jid];
            if (this.sock?.signalRepository?.lidMapping) {
                if (jid.endsWith('@s.whatsapp.net')) {
                    const lid = this.sock.signalRepository.lidMapping.getLIDForPN(jid);
                    if (lid) searchJids.push(lid);
                } else if (jid.endsWith('@lid')) {
                    const pn = this.sock.signalRepository.lidMapping.getPNForLID(jid);
                    if (pn) searchJids.push(pn);
                }
            }
            chatsToSearch = chatsToSearch.filter(chatId => searchJids.includes(chatId));
        }
        
        for (const chatId of chatsToSearch) {
            const messages = this.store.getMessages(chatId);
            
            for (const msg of messages) {
                const text = msg.message?.conversation || 
                           msg.message?.extendedTextMessage?.text || '';
                
                if (text.toLowerCase().includes(query.toLowerCase())) {
                    const senderJid = msg.key.fromMe ? this.sock.user?.id : 
                                     (msg.key.participant || msg.key.remoteJid);
                    const senderContact = this.getContactInfo(senderJid);
                    
                    results.push({
                        chatId,
                        message: msg,
                        text,
                        sender: senderContact?.name || senderJid,
                        timestamp: new Date(msg.messageTimestamp * 1000)
                    });
                }
            }
        }
        
        return results.slice(0, 100);
    }

    /**
     * Check if JID is a user (replaces deprecated isJidUser)
     */
    isPnUser(jid) {
        return jid?.endsWith('@s.whatsapp.net') || jid?.endsWith('@lid');
    }

    // ==================== Core Methods ====================

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
