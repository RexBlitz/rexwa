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
import readline from 'readline';
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

    // Create readline interface for pairing code input
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

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

    // Enhanced LID mapping listener
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

  // Helper method to ask questions via readline
  question(text) {
    return new Promise((resolve) => this.rl.question(text, resolve));
  }

  async initialize() {
    logger.info('🔧 Initializing HyperWa Userbot with Enhanced LID & Pairing Support...');
    
    try {
      this.db = await connectDb();
      logger.info('✅ Database connected successfully!');
    } catch (error) {
      logger.error('❌ Failed to connect to database:', error);
      process.exit(1);
    }

    if (config.get('telegram.enabled')) {
      await this.initializeTelegramBridge();
    }

    await this.moduleLoader.loadModules();
    await this.startWhatsApp();
    logger.info('✅ HyperWa Userbot with Enhanced LID & Pairing Support initialized successfully!');
  }

  async initializeTelegramBridge() {
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
      // Enhanced socket configuration with LID support
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
        
        // Enhanced browser configuration
        browser: config.get('bot.browser') || Browsers.macOS('Chrome'),
        
        // Critical performance options
        markOnlineOnConnect: config.get('bot.markOnlineOnConnect', false),
        syncFullHistory: config.get('bot.syncFullHistory', false),
        shouldSyncHistoryMessage: config.get('bot.shouldSyncHistory', () => true),
        fireInitQueries: config.get('bot.fireInitQueries', true),
        retryRequestDelayMs: config.get('bot.retryDelay', 1000),
        
        // Group metadata caching to avoid rate limits
        cachedGroupMetadata: this.getCachedGroupMetadata.bind(this),
        
        // Security
        firewall: config.get('bot.firewall', true),
        printQRInTerminal: config.get('bot.printQRInTerminal', false)
      });

      // Bind store to socket events
      this.store.bind(this.sock.ev);
      logger.info('🔗 Store bound to socket');

      // Handle pairing code if enabled and not registered
      if (this.usePairingCode && !state.creds.registered) {
        await this.handlePairingCode();
      }

      const connectionPromise = new Promise((resolve, reject) => {
        const connectionTimeout = setTimeout(() => {
          if (!this.sock.user) {
            logger.warn('❌ Connection timed out after 30 seconds');
            this.sock.ev.removeAllListeners();
            this.sock.end();
            this.sock = null;
            reject(new Error('Connection timed out'));
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

  // Handle pairing code authentication
  async handlePairingCode() {
    try {
      logger.info('🔐 Pairing code authentication requested');
      
      let phoneNumber = config.get('auth.phoneNumber');
      
      // If phone number not in config, ask user
      if (!phoneNumber) {
        phoneNumber = await this.question('Please enter your phone number (with country code, e.g., 1234567890):\n');
        
        // Validate phone number format
        if (!this.isValidPhoneNumber(phoneNumber)) {
          logger.error('❌ Invalid phone number format. Please include country code without + sign.');
          process.exit(1);
        }
      }

      logger.info(`📱 Requesting pairing code for: ${phoneNumber}`);
      
      // Request pairing code
      this.pairingCode = await this.sock.requestPairingCode(phoneNumber);
      
      logger.info(`🔢 Pairing code: ${this.pairingCode}`);
      
      // Send pairing code via Telegram if bridge is enabled
      if (this.telegramBridge) {
        try {
          await this.telegramBridge.sendPairingCode(this.pairingCode, phoneNumber);
        } catch (error) {
          logger.warn('⚠️ Failed to send pairing code via Telegram:', error.message);
        }
      }
      
      // Also show in console
      console.log('\n' + '='.repeat(50));
      console.log(`🔢 WHATSAPP PAIRING CODE: ${this.pairingCode}`);
      console.log('='.repeat(50) + '\n');
      
      logger.info('⏳ Waiting for pairing confirmation...');
      
    } catch (error) {
      logger.error('❌ Failed to request pairing code:', error);
      throw error;
    }
  }

  // Validate phone number format (E.164 without +)
  isValidPhoneNumber(phone) {
    // Basic validation - should contain only digits and be between 10-15 digits
    return /^\d{10,15}$/.test(phone);
  }

  // Enhanced group metadata caching
  async getCachedGroupMetadata(jid) {
    try {
      let metadata = this.groupMetadataCache.get(jid);
      
      if (!metadata) {
        metadata = await this.sock.groupMetadata(jid);
        this.groupMetadataCache.set(jid, metadata, 300);
        logger.debug(`💾 Cached group metadata for: ${jid}`);
      }
      
      return metadata;
    } catch (error) {
      logger.warn(`⚠️ Failed to get group metadata for ${jid}:`, error.message);
      return null;
    }
  }

  // Enhanced getMessage with better error handling
  async getMessage(key) {
    try {
      if (!key?.remoteJid || !key?.id) {
        return undefined;
      }

      const effectiveJid = key.remoteJidAlt || key.remoteJid;
      const effectiveParticipant = key.participantAlt || key.participant;

      const storedMessage = this.store.loadMessage(effectiveJid, key.id);
      if (storedMessage?.message) {
        logger.debug(`📨 Retrieved from store: ${key.id}`);
        return storedMessage.message;
      }

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

  // Enhanced LID-aware contact resolution
  getContactInfo(jid) {
    let contact = this.store.contacts[jid];
    if (contact) return contact;

    if (this.sock?.signalRepository?.lidMapping) {
      if (isPnUser(jid)) {
        const lid = this.sock.signalRepository.lidMapping.getLIDForPN(jid);
        if (lid) {
          contact = this.store.contacts[lid];
        }
      } else {
        const pn = this.sock.signalRepository.lidMapping.getPNForLID(jid);
        if (pn) {
          contact = this.store.contacts[pn];
        }
      }
    }

    return contact || null;
  }

  // Enhanced JID resolution with LID support
  resolveJID(jid) {
    const contact = this.getContactInfo(jid);
    return contact?.id || jid;
  }

  // Get preferred JID format (LID if available)
  getPreferredJID(jid) {
    if (!this.sock?.signalRepository?.lidMapping) return jid;
    
    if (isPnUser(jid)) {
      const lid = this.sock.signalRepository.lidMapping.getLIDForPN(jid);
      return lid || jid;
    }
    
    return jid;
  }

  // Enhanced message search with LID support
  searchMessages(query, jid = null) {
    const results = [];
    const chatsToSearch = jid ? [jid] : Object.keys(this.store.messages);
    
    for (const chatId of chatsToSearch) {
      const messages = this.store.getMessages(chatId);
      for (const msg of messages) {
        const text = msg.message?.conversation || 
                    msg.message?.extendedTextMessage?.text || 
                    msg.message?.imageMessage?.caption || '';
        
        if (text.toLowerCase().includes(query.toLowerCase())) {
          const senderJid = msg.key.fromMe ? 
            'You' : 
            this.resolveSenderInfo(msg.key.participantAlt || msg.key.participant);
          
          results.push({
            chatId,
            message: msg,
            text,
            sender: senderJid,
            timestamp: msg.messageTimestamp
          });
        }
      }
    }
    
    return results.slice(0, 100);
  }

  resolveSenderInfo(jid) {
    if (!jid) return 'Unknown';
    
    const contact = this.getContactInfo(jid);
    if (contact?.name) return contact.name;
    
    if (this.sock?.signalRepository?.lidMapping) {
      if (isPnUser(jid)) {
        const lid = this.sock.signalRepository.lidMapping.getLIDForPN(jid);
        if (lid) {
          const lidContact = this.store.contacts[lid];
          if (lidContact?.name) return lidContact.name;
        }
      }
    }
    
    return jid;
  }

  setupEnhancedEventHandlers(saveCreds) {
    this.sock.ev.process(async (events) => {
      try {
        if (events['connection.update']) {
          await this.handleConnectionUpdate(events['connection.update']);
        }
        
        if (events['creds.update']) {
          await saveCreds();
          logger.debug('💾 Credentials updated and saved');
        }
        
        if (events['messages.upsert']) {
          await this.handleMessagesUpsert(events['messages.upsert']);
        }
        
        // Enhanced LID mapping handling
        if (events['lid-mapping.update']) {
          logger.info('🔄 LID mapping update received');
          this.handleLIDMappingUpdate(events['lid-mapping.update']);
        }
        
        // Handle pairing completion
        if (events['connection.update'] && events['connection.update'].isNewLogin) {
          logger.info('🎉 New login detected - pairing completed successfully!');
          if (this.telegramBridge) {
            try {
              await this.telegramBridge.sendMessage('✅ Pairing completed successfully!');
            } catch (error) {
              logger.warn('⚠️ Failed to send pairing completion via Telegram:', error.message);
            }
          }
        }
        
        // Handle other events...
        if (!process.env.DOCKER) {
          if (events['labels.association']) {
            logger.info('📋 Label association update:', events['labels.association']);
          }
          if (events['labels.edit']) {
            logger.info('📝 Label edit update:', events['labels.edit']);
          }
          if (events.call) {
            logger.info('📞 Call event received');
          }
          if (events['messaging-history.set']) {
            const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set'];
            if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
              logger.info('📥 Received on-demand history sync, messages:', messages.length);
            }
            logger.info(`📊 History sync: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs`);
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
    const { connection, lastDisconnect, qr, isNewLogin } = update;
    
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
    
    if (isNewLogin) {
      logger.info('🎉 New login detected!');
    }
    
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect && !this.isShuttingDown) {
        logger.warn('🔄 Connection closed, reconnecting...');
        this.store.saveToFile();
        setTimeout(() => this.startWhatsApp(), 5000);
      } else {
        logger.error('❌ Connection closed permanently. Please restart the bot.');
        await this.clearAuthState();
        this.store.saveToFile();
        process.exit(1);
      }
    } else if (connection === 'open') {
      await this.onConnectionOpen();
    }
  }

  async clearAuthState() {
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

    // Handle special commands
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

    // Close readline interface after successful connection
    if (this.rl) {
      this.rl.close();
    }
  }

  async sendStartupMessage() {
    const owner = config.get('bot.owner');
    if (!owner) return;
    
    const authMethod = this.useMongoAuth ? 'MongoDB' : 'File-based';
    const authType = this.usePairingCode ? 'Pairing Code' : 'QR Code';
    const storeStats = this.getStoreStats();
    
    const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
      `🔥 *Enhanced Features:*\n` +
      `• 🔐 LID Support: ✅\n` +
      `• 🔑 Auth Type: ${authType}\n` +
      `• 💾 Storage: ${authMethod}\n` +
      `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
      `• 📊 Store: ${storeStats.chats} chats, ${storeStats.contacts} contacts\n\n` +
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
    
    const preferredJid = this.getPreferredJID(jid);
    return await this.sock.sendMessage(preferredJid, content);
  }

  async shutdown() {
    logger.info('🛑 Shutting down HyperWa Userbot...');
    this.isShuttingDown = true;
    
    // Cleanup store
    this.store.cleanup();
    this.store.saveToFile();
    
    // Close readline interface
    if (this.rl) {
      this.rl.close();
    }
    
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

  // Method to manually trigger pairing code (useful for commands)
  async requestNewPairingCode(phoneNumber = null) {
    if (!this.sock) {
      throw new Error('WhatsApp socket not initialized');
    }

    try {
      let targetPhone = phoneNumber;
      
      if (!targetPhone) {
        targetPhone = await this.question('Please enter your phone number (with country code, e.g., 1234567890):\n');
        
        if (!this.isValidPhoneNumber(targetPhone)) {
          throw new Error('Invalid phone number format');
        }
      }

      this.pairingCode = await this.sock.requestPairingCode(targetPhone);
      logger.info(`🔢 New pairing code: ${this.pairingCode}`);
      
      return this.pairingCode;
    } catch (error) {
      logger.error('❌ Failed to request new pairing code:', error);
      throw error;
    }
  }
}

export { HyperWaBot };
export default HyperWaBot;
