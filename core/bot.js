import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  makeCacheableSignalKeyStore, 
  getAggregateVotesInPollMessage, 
  isJidNewsletter, 
  delay, 
  proto,
  Browsers,
  isPnUser
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
    this.usePairingCode = config.get('auth.usePairingCode', false);
    this.pairingCode = null;
    this.retryCount = 0;

    // Enhanced store with LID support
    this.store = makeInMemoryStore({
      logger: logger.child({ module: 'store' }),
      filePath: './whatsapp-store.json',
      autoSaveInterval: 30000
    });

    // Load existing data
    this.store.loadFromFile();

    // Cache setup
    this.msgRetryCounterCache = new NodeCache();
    this.groupMetadataCache = new NodeCache();
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
      this.updateLIDMappings(contacts);
    });

    this.store.on('chats.upsert', (chats) => {
      logger.debug(`💬 Store: ${chats.length} chats cached`);
    });

    this.store.on('lid-mapping.update', (mapping) => {
      logger.debug(`🔑 LID Mapping Update: ${Object.keys(mapping).length} mappings`);
      this.handleLIDMappingUpdate(mapping);
    });

    setInterval(() => {
      const stats = this.getStoreStats();
      logger.info(`📊 Store Stats - Chats: ${stats.chats}, Contacts: ${stats.contacts}, Messages: ${stats.messages}`);
    }, 300000);
  }

  handleLIDMappingUpdate(mapping) {
    Object.entries(mapping).forEach(([pn, lid]) => {
      logger.debug(`🔄 LID Mapping: ${pn} -> ${lid}`);
    });
  }

  updateLIDMappings(contacts) {
    if (!this.sock?.signalRepository?.lidMapping) return;

    contacts.forEach(contact => {
      if (contact.id && contact.phoneNumber) {
        this.sock.signalRepository.lidMapping.storeLIDPNMapping(contact.id, contact.phoneNumber);
      }
    });
  }

  getStoreStats() {
    const chatCount = Object.keys(this.store.chats).length;
    const contactCount = Object.keys(this.store.contacts).length;
    const messageCount = Object.values(this.store.messages)
      .reduce((total, chatMessages) => total + Object.keys(chatMessages).length, 0);
    
    return { chats: chatCount, contacts: contactCount, messages: messageCount };
  }

    async initialize() {
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
    let state, saveCreds;

    // Clean up existing socket
    if (this.sock) {
      logger.info('🧹 Cleaning up existing WhatsApp socket');
      this.sock.ev.removeAllListeners();
      await this.sock.end();
      this.sock = null;
    }

    // Auth state initialization
    if (this.useMongoAuth) {
      logger.info('🔧 Using MongoDB auth state...');
      try {
        ({ state, saveCreds } = await useMongoAuthState());
        
        // Check if session is valid
        if (state.creds.registered === false || !state.creds.me) {
          logger.warn('🔄 Session is invalid/expired, clearing auth data...');
          await this.clearAuthState();
          ({ state, saveCreds } = await useMongoAuthState());
        }
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
      // Socket configuration
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
        browser: Browsers.macOS('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        fireInitQueries: false,
        retryRequestDelayMs: 2000,
        cachedGroupMetadata: this.getCachedGroupMetadata.bind(this),
        firewall: true,
        printQRInTerminal: false
      });

      // Bind store to socket events
      this.store.bind(this.sock.ev);
      logger.info('🔗 Store bound to socket');

      // Handle pairing code if enabled
      if (this.usePairingCode && !state.creds.registered) {
        await this.handlePairingCode();
      }

      // Wait for connection
      const connectionPromise = new Promise((resolve, reject) => {
        const connectionTimeout = setTimeout(() => {
          if (!this.sock.user) {
            logger.warn('❌ Connection timed out after 60 seconds');
            reject(new Error('Connection timed out'));
          }
        }, 60000);

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
      
      // Clear auth on critical errors
      if (error.message?.includes('logged out') || error.message?.includes('401')) {
        logger.warn('🔄 Session expired, clearing auth data...');
        await this.clearAuthState();
      }
      
      // Exponential backoff
      this.retryCount++;
      const backoffDelay = Math.min(5000 * Math.pow(2, this.retryCount), 30000);
      logger.info(`🔄 Retrying in ${backoffDelay/1000}s... (Attempt: ${this.retryCount})`);
      setTimeout(() => this.startWhatsApp(), backoffDelay);
    }
  }

  async handlePairingCode() {
    try {
      const phoneNumber = config.get('auth.phoneNumber');
      if (!phoneNumber) {
        logger.error('❌ No phone number configured for pairing');
        this.usePairingCode = false;
        return;
      }

      logger.info(`📱 Requesting pairing code for: ${phoneNumber}`);
      
      // Wait for socket to be ready
      await delay(2000);
      
      this.pairingCode = await this.sock.requestPairingCode(phoneNumber);
      
      // Display pairing code clearly
      console.log('\n' + '='.repeat(50));
      console.log('🔢 WHATSAPP PAIRING CODE');
      console.log('='.repeat(50));
      console.log(`📱 Code: ${this.pairingCode}`);
      console.log(`📞 Phone: ${phoneNumber}`);
      console.log('='.repeat(50));
      console.log('💡 Instructions:');
      console.log('1. Open WhatsApp on your phone');
      console.log('2. Go to Settings → Linked Devices → Link a Device');
      console.log('3. Enter the code above');
      console.log('⏳ Waiting for pairing...');
      console.log('='.repeat(50) + '\n');
      
      logger.info(`🔢 Pairing code generated: ${this.pairingCode}`);
      
    } catch (error) {
      logger.error('❌ Failed to request pairing code:', error.message);
      logger.warn('🔄 Falling back to QR code...');
      this.usePairingCode = false;
    }
  }

  isValidPhoneNumber(phone) {
    return /^\d{10,15}$/.test(phone);
  }

  async getCachedGroupMetadata(jid) {
    try {
      let metadata = this.groupMetadataCache.get(jid);
      if (!metadata) {
        metadata = await this.sock.groupMetadata(jid);
        this.groupMetadataCache.set(jid, metadata, 300);
      }
      return metadata;
    } catch (error) {
      logger.warn(`⚠️ Failed to get group metadata for ${jid}:`, error.message);
      return null;
    }
  }

  async getMessage(key) {
    try {
      if (!key?.remoteJid || !key?.id) return undefined;

      const effectiveJid = key.remoteJidAlt || key.remoteJid;
      const effectiveParticipant = key.participantAlt || key.participant;

      const storedMessage = this.store.loadMessage(effectiveJid, key.id);
      if (storedMessage?.message) return storedMessage.message;

      if (effectiveParticipant && effectiveJid.endsWith('@g.us')) {
        const participantMessages = this.store.messages[effectiveJid];
        if (participantMessages) {
          for (const msg of Object.values(participantMessages)) {
            if (msg.key?.id === key.id && 
                (msg.key.participant === effectiveParticipant || msg.key.participantAlt === effectiveParticipant)) {
              return msg.message;
            }
          }
        }
      }

      return undefined;
    } catch (error) {
      logger.debug('⚠️ getMessage error:', error.message);
      return undefined;
    }
  }

  getContactInfo(jid) {
    if (!jid) return null;
    
    let contact = this.store.contacts[jid];
    if (contact) return contact;

    if (this.sock?.signalRepository?.lidMapping) {
      try {
        const prefix = jid.split('@')[0];
        if (isPnUser(jid)) {
          const lid = this.sock.signalRepository.lidMapping.getLIDForPN(prefix);
          if (lid) contact = this.store.contacts[`${lid}@s.whatsapp.net`];
        } else {
          const pn = this.sock.signalRepository.lidMapping.getPNForLID(prefix);
          if (pn) contact = this.store.contacts[`${pn}@s.whatsapp.net`];
        }
      } catch (error) {
        logger.debug('LID contact resolution failed:', error.message);
      }
    }

    return contact || null;
  }

  resolveJID(jid) {
    const contact = this.getContactInfo(jid);
    return contact?.id || jid;
  }

  getPreferredJID(jid) {
    if (!this.sock?.signalRepository?.lidMapping) return jid;
    if (isPnUser(jid)) {
      const lid = this.sock.signalRepository.lidMapping.getLIDForPN(jid);
      return lid || jid;
    }
    return jid;
  }

  async getPhoneNumberFromJid(jid) {
    if (!jid) return null;
    const prefix = jid.split('@')[0];
    const isGroupOrSpecial = jid.endsWith('@g.us') || jid.includes('broadcast');
    
    if (isGroupOrSpecial) return prefix;

    const contact = this.getContactInfo(jid);
    if (contact?.phoneNumber) return contact.phoneNumber.replace(/^\+/, '');

    if (this.sock?.signalRepository?.lidMapping) {
      try {
        if (/^\d+$/.test(prefix)) return prefix;
        const pn = await this.sock.signalRepository.lidMapping.getPNForLID(prefix);
        if (pn) return pn;
      } catch (err) {
        logger.debug('LID mapping lookup failed:', err.message);
      }
    }

    return prefix.startsWith('+') ? prefix.replace('+', '') : prefix;
  }

  async handleLIDMappingUpdate(mapping) {
    try {
      logger.info(`🔄 Processing ${Object.keys(mapping).length} LID mappings`);
      for (const [pn, lid] of Object.entries(mapping)) {
        logger.debug(`🔁 LID Mapping: ${pn} -> ${lid}`);
      }
      if (this.telegramBridge?.syncContacts) {
        await this.telegramBridge.syncContacts();
      }
    } catch (error) {
      logger.error('❌ Failed to handle LID mapping update:', error);
    }
  }

  getContactName(jid) {
    const contact = this.getContactInfo(jid);
    if (contact?.name) return contact.name;
    
    if (this.sock?.signalRepository?.lidMapping) {
      try {
        const phone = this.getPhoneNumberFromJid(jid);
        if (phone) {
          for (const [contactJid, contactInfo] of Object.entries(this.store.contacts)) {
            if (contactInfo.phoneNumber === phone || contactInfo.phoneNumber === `+${phone}`) {
              return contactInfo.name;
            }
          }
        }
      } catch (error) {
        logger.debug('Contact name resolution failed:', error.message);
      }
    }
    return null;
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
        if (events['messages.upsert']) {
          await this.handleMessagesUpsert(events['messages.upsert']);
        }
        if (events['lid-mapping.update']) {
          this.handleLIDMappingUpdate(events['lid-mapping.update']);
        }
      } catch (error) {
        logger.warn('⚠️ Event processing error:', error.message);
      }
    });
  }

  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, isNewLogin } = update;
    
    if (qr && !this.usePairingCode) {
      logger.info('📱 WhatsApp QR code generated');
      qrcode.generate(qr, { small: true });
    }
    
    if (isNewLogin) {
      logger.info('🎉 New login detected!');
      this.retryCount = 0; // Reset retry counter on successful login
    }
    
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
      
      // In pairing mode, connection failures are normal
      if (this.usePairingCode && !this.sock?.user) {
        logger.debug('🔄 Pairing mode: Connection closed, will reconnect...');
        return;
      }
      
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        logger.warn('🔐 Session logged out, clearing auth data...');
        await this.clearAuthState();
      }
      
      if (shouldReconnect && !this.isShuttingDown) {
        logger.warn('🔄 Connection closed, reconnecting...');
        setTimeout(() => this.startWhatsApp(), 2000);
      } else {
        logger.error('❌ Connection closed permanently.');
        process.exit(1);
      }
    } else if (connection === 'open') {
      await this.onConnectionOpen();
    }
  }
  
  async clearAuthState() {
    logger.info('🗑️ Clearing auth state...');
    
    if (this.useMongoAuth) {
      try {
        const db = await connectDb();
        const coll = db.collection("auth");
        await coll.deleteOne({ _id: "session" });
        logger.info('🗑️ MongoDB auth session cleared');
      } catch (error) {
        logger.error('❌ Failed to clear MongoDB auth session:', error);
      }
    } else {
      try {
        await fs.remove(this.authPath);
        logger.info('🗑️ File-based auth session cleared');
      } catch (error) {
        logger.error('❌ Failed to clear file-based auth session:', error);
      }
    }
    
    try {
      this.store.clear();
      await fs.remove('./whatsapp-store.json').catch(() => {});
      logger.info('🗑️ Store data cleared');
    } catch (error) {
      logger.debug('Could not clear store data:', error.message);
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
    }
    
    this.retryCount = 0; // Reset retry counter on successful connection
  }

  async sendStartupMessage() {
    const owner = config.get('bot.owner');
    if (!owner) return;
    
    const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
      `Type *${config.get('bot.prefix')}help* for available commands!`;
    
    try {
      await this.sendMessage(owner, { text: startupMessage });
    } catch (error) {
      logger.warn('⚠️ Failed to send startup message:', error.message);
    }
  }

  async connect() {
    if (!this.sock) await this.startWhatsApp();
    return this.sock;
  }

  async sendMessage(jid, content) {
    if (!this.sock) throw new Error('WhatsApp socket not initialized');
    const preferredJid = this.getPreferredJID(jid);
    return await this.sock.sendMessage(preferredJid, content);
  }

  async shutdown() {
    logger.info('🛑 Shutting down HyperWa Userbot...');
    this.isShuttingDown = true;
    this.store.cleanup();
    this.store.saveToFile();
    
    if (this.telegramBridge) {
      try {
        await this.telegramBridge.shutdown();
      } catch (err) {
        logger.warn('⚠️ Telegram shutdown error:', err.message);
      }
    }
    
    if (this.sock) await this.sock.end();
    logger.info('✅ HyperWa Userbot shutdown complete');
  }
}

export { HyperWaBot };
export default HyperWaBot;
