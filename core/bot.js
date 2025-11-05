import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    isJidNewsletter, 
    delay, 
    proto,
    isPnUser // Replaced isJidUser
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
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
        
        // Initialize enhanced store with LID support
        this.store = makeInMemoryStore({
            logger: logger.child({ module: 'store' }),
            filePath: './whatsapp-store.json',
            autoSaveInterval: 30000
        });
        
        this.store.loadFromFile();
        this.msgRetryCounterCache = new NodeCache();
        this.onDemandMap = new Map();
        
        this.setupStoreEventListeners();
    }

    setupStoreEventListeners() {
        // LID mapping update listener - CRITICAL for LID system
        this.store.on('lid-mapping.update', (mapping) => {
            logger.info(`🔑 LID Mapping Update: ${Object.keys(mapping).length} mappings received`);
            this.store.storeLIDMappings(mapping);
            
            // Update contacts with new mappings
            this.updateContactsWithLIDMappings(mapping);
        });

        this.store.on('messages.upsert', (data) => {
            logger.debug(`📝 Store: ${data.messages.length} messages cached`);
        });

        this.store.on('contacts.upsert', (contacts) => {
            logger.debug(`👥 Store: ${contacts.length} contacts cached`);
            this.processContactsWithLID(contacts);
        });

        this.store.on('chats.upsert', (chats) => {
            logger.debug(`💬 Store: ${chats.length} chats cached`);
        });

        // Log LID statistics periodically
        setInterval(() => {
            this.logLIDStats();
        }, 300000);
    }

    /**
     * Process contacts to handle LID/PN information
     */
    processContactsWithLID(contacts) {
        for (const contact of contacts) {
            // Contact now has id (preferred), phoneNumber, and lid fields
            if (contact.phoneNumber && contact.id !== contact.phoneNumber) {
                // Store the mapping
                this.store.pnMappings.set(contact.phoneNumber, contact.id);
                this.store.lidMappings.set(contact.id, contact.phoneNumber);
            }
        }
    }

    /**
     * Update existing contacts when new LID mappings arrive
     */
    updateContactsWithLIDMappings(mapping) {
        for (const [lid, pn] of Object.entries(mapping)) {
            // Update contact if it exists
            if (this.store.contacts[pn]) {
                this.store.contacts[pn].id = lid; // Update to preferred ID
                this.store.contacts[pn].lid = lid;
                this.store.contacts[pn].phoneNumber = pn;
            }
            
            // Also create reverse mapping entry if needed
            if (this.store.contacts[lid]) {
                this.store.contacts[lid].phoneNumber = pn;
            }
        }
    }

    /**
     * Log LID system statistics
     */
    logLIDStats() {
        const lidCount = this.store.lidMappings.size;
        const pnCount = this.store.pnMappings.size;
        const contactCount = Object.keys(this.store.contacts).length;
        
        logger.info(`📊 LID Stats - Mappings: ${lidCount} LID->PN, ${pnCount} PN->LID, Contacts: ${contactCount}`);
        
        // Log sample mappings for debugging
        if (lidCount > 0) {
            const sampleLid = Array.from(this.store.lidMappings.keys())[0];
            const samplePn = this.store.lidMappings.get(sampleLid);
            logger.debug(`🔍 Sample mapping: ${sampleLid} -> ${samplePn}`);
        }
    }

    async initialize() {
        logger.info('🔧 Initializing HyperWa Userbot with Official LID Support...');
        
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
            } catch (error) {
                logger.warn('⚠️ Telegram bridge failed to initialize:', error.message);
                this.telegramBridge = null;
            }
        }

        await this.moduleLoader.loadModules();
        await this.startWhatsApp();
        logger.info('✅ HyperWa Userbot with Official LID Support initialized!');
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
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger.child({ module: 'keys' })),
                },
                version,
                logger: logger.child({ module: 'baileys' }),
                msgRetryCounterCache: this.msgRetryCounterCache,
                generateHighQualityLinkPreview: true,
                getMessage: this.getMessage.bind(this),
                browser: ['HyperWa', 'Chrome', '3.0'],
                markOnlineOnConnect: false,
                printQRInTerminal: false,
                // LID-compatible configuration
                shouldIgnoreJid: (jid) => isJidNewsletter(jid),
            });

            // Bind store to socket events
            this.store.bind(this.sock.ev);
            logger.info('🔗 Store bound to socket events');

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
            setTimeout(() => this.startWhatsApp(), 5000);
        }
    }

    // Enhanced getMessage with LID-aware lookup
    async getMessage(key) {
        try {
            if (!key?.remoteJid || !key?.id) {
                return undefined;
            }

            // Resolve JID to handle LID/PN properly
            const resolvedJid = this.store.resolveJID(key.remoteJid);
            const lookupKey = { ...key, remoteJid: resolvedJid };

            // Try to get from store with resolved JID
            const storedMessage = this.store.loadMessage(resolvedJid, key.id);
            if (storedMessage?.message) {
                logger.debug(`📨 Retrieved from store: ${key.id} (resolved JID: ${resolvedJid})`);
                return storedMessage.message;
            }

            return undefined;
        } catch (error) {
            logger.debug('⚠️ getMessage error:', error.message);
            return undefined;
        }
    }

    // LID-AWARE HELPER METHODS

    /**
     * Get contact information (LID-compatible)
     */
    getContactInfo(jid) {
        return this.store.getContactEnhanced(jid);
    }

    /**
     * Get LID for phone number JID using official method
     */
    getLIDForJID(jid) {
        // First try the store mapping
        const storeLid = this.store.getLIDForPN(jid);
        if (storeLid) return storeLid;

        // Then try the socket's signal repository (official method)
        if (this.sock?.signalRepository?.lidMapping) {
            return this.sock.signalRepository.lidMapping.getLIDForPN(jid);
        }

        return null;
    }

    /**
     * Get PN for LID using official method
     */
    getPNForLID(lid) {
        // First try the store mapping
        const storePn = this.store.getPNForLID(lid);
        if (storePn) return storePn;

        // Then try the socket's signal repository (official method)
        if (this.sock?.signalRepository?.lidMapping) {
            return this.sock.signalRepository.lidMapping.getPNForLID(lid);
        }

        return null;
    }

    /**
     * Resolve JID to preferred format (official method)
     */
    resolveJID(jid) {
        if (!jid) return jid;

        // Use contact's preferred ID if available
        const contact = this.getContactInfo(jid);
        if (contact?.id) {
            return contact.id;
        }

        // For LIDs, try to find if we have mapping
        if (this.store.isLID(jid)) {
            const pn = this.getPNForLID(jid);
            return pn || jid; // Return PN if available, otherwise keep LID
        }

        return jid;
    }

    /**
     * Send message with LID-aware JID resolution
     */
    async sendMessage(jid, content, options = {}) {
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }

        // Resolve JID before sending
        const resolvedJid = this.resolveJID(jid);
        
        logger.debug(`📤 Sending message to: ${jid} -> ${resolvedJid}`);
        
        return await this.sock.sendMessage(resolvedJid, content, options);
    }

    /**
     * Enhanced group metadata retrieval with LID handling
     */
    getGroupInfo(jid) {
        const metadata = this.store.groupMetadata[jid];
        const chat = this.store.chats[jid];
        
        if (metadata?.participants) {
            // Process participants to resolve LID/PN
            const processedParticipants = metadata.participants.map(participant => ({
                ...participant,
                resolvedId: this.resolveJID(participant.id),
                isLID: this.store.isLID(participant.id),
                phoneNumber: this.getPNForLID(participant.id) || participant.id
            }));
            
            return {
                metadata: {
                    ...metadata,
                    participants: processedParticipants
                },
                chat,
                participants: processedParticipants
            };
        }
        
        return { metadata, chat, participants: [] };
    }

    setupEnhancedEventHandlers(saveCreds) {
        this.sock.ev.process(async (events) => {
            try {
                if (events['connection.update']) {
                    await this.handleConnectionUpdate(events['connection.update']);
                }

                if (events['creds.update']) {
                    await saveCreds();
                }

                // Handle LID mapping updates specifically
                if (events['lid-mapping.update']) {
                    const mappings = events['lid-mapping.update'];
                    logger.info(`🔄 Received LID mapping updates: ${Object.keys(mappings).length} mappings`);
                    this.store.storeLIDMappings(mappings);
                }

                if (events['messages.upsert']) {
                    await this.handleMessagesUpsert(events['messages.upsert']);
                }

                // Other event handlers remain the same but are LID-aware
                if (events['contacts.update']) {
                    this.processContactsWithLID(events['contacts.update']);
                }

                if (events['messaging-history.set']) {
                    const { chats, contacts, messages, syncType } = events['messaging-history.set'];
                    logger.info(`📥 History sync: ${messages.length} messages, type: ${syncType}`);
                    
                    // Process contacts from history sync for LID info
                    if (contacts) {
                        this.processContactsWithLID(contacts);
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
                logger.error('❌ Connection closed permanently.');
                this.cleanupAuth();
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
                    // Process message with LID handling
                    this.store.processMessageWithLID(msg);
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

    async onConnectionOpen() {
        logger.info(`✅ Connected to WhatsApp! User: ${this.sock.user?.id || 'Unknown'}`);
        
        // Log LID information about our own user
        if (this.sock.user?.id) {
            const userJid = this.sock.user.id;
            const isLID = this.store.isLID(userJid);
            logger.info(`👤 User JID type: ${isLID ? 'LID' : 'PN'} (${userJid})`);
            
            if (isLID) {
                const pn = this.getPNForLID(userJid);
                logger.info(`📞 User PN: ${pn || 'Not available'}`);
            }
        }

        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to: ${this.sock.user.id}`);
        }

        if (this.isFirstConnection) {
            await this.sendStartupMessage();
            this.isFirstConnection = false;
        }

        logger.info('🔑 LID System: Ready and operational');
    }

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) return;

        const userJid = this.sock.user?.id;
        const isLID = userJid && this.store.isLID(userJid);
        const jidType = isLID ? 'LID' : 'PN';
        
        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *HyperWa Features Active:*\n` +
                              `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                              `Type *${config.get('bot.prefix')}help* for available commands!`;


        try {
            await this.sendMessage(owner, { text: startupMessage });
        } catch (error) {
            logger.warn('⚠️ Failed to send startup message:', error.message);
        }
    }

    async cleanupAuth() {
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
    }

    async shutdown() {
        logger.info('🛑 Shutting down HyperWa Userbot...');
        this.isShuttingDown = true;

        // Save LID mappings
        this.store.saveToFile();

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
