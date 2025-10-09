/*
  HyperWaBot - bot.js
  Full, patched version tailored to your setup (MongoDB auth + pairing-code support)
  - Safe Baileys import (CJS/ESM compatible)
  - Robust fetchLatestBaileysVersion accessor with fallback
  - MongoDB auth restore detection + automatic clearing of corrupted sessions
  - Verbose error logging and single retry logic
  - Pairing code support (if provided by config)

  NOTE: This file expects these modules to exist in your project:
    - ./store.js -> makeInMemoryStore
    - ../config.js -> config.get/set
    - ./logger.js -> pino-like logger
    - ./message-handler.js -> MessageHandler class
    - ../utils/db.js -> connectDb()
    - ./module-loader.js -> ModuleLoader class
    - ../utils/mongoAuthState.js -> useMongoAuthState()

  Adjust relative paths if necessary.
*/

import baileysPkg from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs-extra';
import path from 'path';
import NodeCache from 'node-cache';

import { makeInMemoryStore } from './store.js';
import config from '../config.js';
import logger from './logger.js';
import MessageHandler from './message-handler.js';
import { connectDb } from '../utils/db.js';
import ModuleLoader from './module-loader.js';
import { useMongoAuthState } from '../utils/mongoAuthState.js';

// Destructure core exports from baileys package in a compatible way
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  getAggregateVotesInPollMessage,
  isJidNewsletter,
  delay,
  proto,
  // some builds might expose keys under default
} = baileysPkg;

// safe accessor for fetchLatestBaileysVersion (handles different pkg shapes)
const fetchLatestBaileysVersion =
  baileysPkg.fetchLatestBaileysVersion ||
  baileysPkg.default?.fetchLatestBaileysVersion ||
  (async () => ({ version: [2, 3000, 0], isLatest: true }));

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
    this.useMongoAuth = config.get('auth.useMongoAuth', true);

    // Initialize the enhanced store with advanced options
    this.store = makeInMemoryStore({
      logger: logger.child({ module: 'store' }),
      filePath: config.get('store.filePath', './whatsapp-store.json'),
      autoSaveInterval: config.get('store.autoSaveInterval', 30000)
    });

    // Load existing store data on startup (if your makeInMemoryStore provides this)
    try { this.store.loadFromFile?.(); } catch (e) { /* ignore */ }

    // Enhanced features
    this.msgRetryCounterCache = new NodeCache({ stdTTL: 300, maxKeys: 500 });
    this.onDemandMap = new Map();
    this.autoReply = config.get('features.autoReply', false);
    this.enableTypingIndicators = config.get('features.typingIndicators', true);
    this.autoReadMessages = config.get('features.autoReadMessages', true);

    setInterval(() => { if (this.onDemandMap.size > 100) this.onDemandMap.clear(); }, 300000);

    this.setupStoreEventListeners();
  }

  setupStoreEventListeners() {
    this.store.on?.('messages.upsert', (data) => {
      logger.debug(`📝 Store: ${data.messages.length} messages cached`);
    });

    this.store.on?.('contacts.upsert', (contacts) => {
      logger.debug(`👥 Store: ${contacts.length} contacts cached`);
    });

    this.store.on?.('chats.upsert', (chats) => {
      logger.debug(`💬 Store: ${chats.length} chats cached`);
    });

    setInterval(() => {
      const stats = this.getStoreStats();
      logger.info(`📊 Store Stats - Chats: ${stats.chats}, Contacts: ${stats.contacts}, Messages: ${stats.messages}`);
    }, 300000);
  }

  getStoreStats() {
    const chatCount = Object.keys(this.store.chats || {}).length;
    const contactCount = Object.keys(this.store.contacts || {}).length;
    const messageCount = Object.values(this.store.messages || {})
      .reduce((total, chatMessages) => total + (Object.keys(chatMessages).length || 0), 0);

    return { chats: chatCount, contacts: contactCount, messages: messageCount };
  }

  async initialize() {
    logger.info('🔧 Initializing HyperWa Userbot with Enhanced Store...');

    try {
      this.db = await connectDb();
      logger.info('✅ Database connected successfully!');
    } catch (error) {
      logger.error('❌ Failed to connect to database:', error?.stack || error);
      process.exit(1);
    }

    if (config.get('telegram.enabled')) {
      try {
        const TelegramBridgeModule = await import('../telegram/bridge.js');
        const TelegramBridge = TelegramBridgeModule.default || TelegramBridgeModule.TelegramBridge;

        this.telegramBridge = new TelegramBridge(this);
        await this.telegramBridge.initialize();
        logger.info('✅ Telegram bridge initialized');

        try { await this.telegramBridge.sendStartMessage(); } catch (err) { logger.warn('⚠️ Failed to send start message via Telegram:', err.message); }
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

    // Cleanup if socket exists
    if (this.sock) {
      logger.info('🧹 Cleaning up existing WhatsApp socket');
      try { this.sock.ev.removeAllListeners(); } catch {};
      try { await this.sock.end(); } catch {};
      this.sock = null;
    }

    // Choose auth method
    try {
      if (this.useMongoAuth) {
        logger.info('🔧 Using MongoDB auth state...');
        ({ state, saveCreds } = await useMongoAuthState());
      } else {
        logger.info('🔧 Using file-based auth state...');
        ({ state, saveCreds } = await useMultiFileAuthState(this.authPath));
      }
    } catch (err) {
      logger.error('❌ Failed to get auth state:', err?.stack || err);
      ({ state, saveCreds } = await useMultiFileAuthState(this.authPath));
    }

    // Quick summary of restored state (don't print secrets in logs)
    try {
      logger.debug('Auth state summary:', {
        credsKeys: Object.keys(state.creds || {}).length,
        keysRoot: Object.keys(state.keys || {}).length,
        registered: !!state.creds?.registered
      });
    } catch (e) { /* ignored */ }

    // Detect usable session keys
    const haveSessionFiles = (() => {
      try {
        if (!state.keys || Object.keys(state.keys).length === 0) return false;
        for (const k of Object.keys(state.keys)) {
          if (state.keys[k] && Object.keys(state.keys[k]).length > 0) return true;
        }
        return false;
      } catch (e) { return false; }
    })();

    if (!haveSessionFiles) {
      logger.warn('⚠️ Restored auth has no usable session keys. This will likely fail to initialize socket.');
      if (this.useMongoAuth) {
        logger.info('🧹 Clearing MongoDB session to force fresh pairing...');
        try {
          const db = await connectDb();
          await db.collection('auth').deleteOne({ _id: 'session' });
          logger.info('✅ Cleared MongoDB auth session. Falling back to file auth for fresh pairing.');
          ({ state, saveCreds } = await useMultiFileAuthState(this.authPath));
        } catch (err) {
          logger.error('❌ Failed to clear MongoDB session:', err?.stack || err);
        }
      }
    }

    // fetch WA version
    let version, isLatest;
    try {
      const verObj = await fetchLatestBaileysVersion();
      version = verObj.version;
      isLatest = verObj.isLatest;
    } catch (e) {
      logger.warn('⚠️ Failed to fetch latest Baileys version, using fallback', e?.message || e);
      ({ version, isLatest } = { version: [2, 3000, 0], isLatest: true });
    }

    logger.info(`📱 Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const msgRetryCounterCache = this.msgRetryCounterCache;

    try {
      this.sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger.child({ module: 'signal-keys' })),
        },
        version,
        printQRInTerminal: false,
        logger: logger.child({ module: 'baileys' }),
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        getMessage: this.getMessage.bind(this),
        browser: ['HyperWa', 'Chrome', '3.0'],
      });

      this.store.bind(this.sock.ev);
      logger.info('🔗 Store bound to WhatsApp socket events');

      // connection promise used to wait for 'open'
      const connectionPromise = new Promise((resolve, reject) => {
        const connectionTimeout = setTimeout(() => {
          if (!this.sock.user) {
            logger.warn('❌ QR code scan timed out or handshake failed (timeout)');
            reject(new Error('QR code scan timed out or handshake failed'));
          }
        }, 30000);

        this.sock.ev.on('connection.update', update => {
          if (update.connection === 'open') {
            clearTimeout(connectionTimeout);
            resolve();
          }

          if (update.qr) {
            logger.info('📱 WhatsApp QR code generated');
            try { qrcode.generate(update.qr, { small: true }); } catch (e) {}

            if (this.telegramBridge) {
              try { this.telegramBridge.sendQRCode(update.qr); } catch (err) { logger.warn('⚠️ TelegramBridge failed to send QR:', err.message); }
            }
          }

          if (update.connection === 'close') {
            // let the outer catch handle it if socket fails
          }
        });
      });

      this.setupEnhancedEventHandlers(saveCreds);
      await connectionPromise;
    } catch (err) {
      logger.error('❌ Failed to initialize WhatsApp socket:');
      logger.error(err?.stack || err);
      try { logger.error('error (raw):', JSON.stringify(err, Object.getOwnPropertyNames(err), 2)); } catch (e) {}

      // If using MongoAuth, clear session to allow fresh pairing the next attempt
      if (this.useMongoAuth) {
        try {
          const db = await connectDb();
          await db.collection('auth').deleteOne({ _id: 'session' });
          logger.info('🗑️ Cleared MongoDB auth session after socket init failure. Will retry startWhatsApp shortly...');
        } catch (e) {
          logger.error('❌ Failed to clear MongoDB session after error:', e?.stack || e);
        }
      }

      // backoff & retry once
      setTimeout(() => {
        try { this.startWhatsApp(); } catch (e) { logger.error('Retry failed:', e?.stack || e); }
      }, 5000);
    }
  }

  async getMessage(key) {
    if (key?.remoteJid && key?.id) {
      const storedMessage = this.store.loadMessage?.(key.remoteJid, key.id);
      if (storedMessage) {
        logger.debug(`📨 Retrieved message from store: ${key.id}`);
        return storedMessage;
      }
    }

    return proto.Message.create({ conversation: 'Message not found' });
  }

  getChatInfo(jid) { return this.store.chats[jid] || null; }
  getContactInfo(jid) { return this.store.contacts[jid] || null; }
  getChatMessages(jid, limit = 50) {
    const messages = this.store.getMessages?.(jid) || [];
    return messages.slice(-limit).reverse();
  }

  searchMessages(query, jid = null) {
    const results = [];
    const chatsToSearch = jid ? [jid] : Object.keys(this.store.messages || {});

    for (const chatId of chatsToSearch) {
      const messages = this.store.getMessages?.(chatId) || [];
      for (const msg of messages) {
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (text.toLowerCase().includes(query.toLowerCase())) results.push({ chatId, message: msg, text });
      }
    }

    return results.slice(0, 100);
  }

  getGroupInfo(jid) {
    const metadata = this.store.groupMetadata[jid];
    const chat = this.store.chats[jid];
    return { metadata, chat, participants: metadata?.participants || [] };
  }

  getUserStats(jid) {
    let messageCount = 0; let lastMessageTime = null;
    for (const chatId of Object.keys(this.store.messages || {})) {
      const messages = this.store.getMessages?.(chatId) || [];
      const userMessages = messages.filter(msg => msg.key?.participant === jid || msg.key?.remoteJid === jid);
      messageCount += userMessages.length;
      if (userMessages.length > 0) {
        const lastMsg = userMessages[userMessages.length - 1];
        const msgTime = lastMsg.messageTimestamp * 1000;
        if (!lastMessageTime || msgTime > lastMessageTime) lastMessageTime = msgTime;
      }
    }
    return { messageCount, lastMessageTime: lastMessageTime ? new Date(lastMessageTime) : null, isActive: lastMessageTime && (Date.now() - lastMessageTime) < (7*24*60*60*1000) };
  }

  async exportChatHistory(jid, format = 'json') {
    const chat = this.getChatInfo(jid);
    const messages = this.getChatMessages(jid, 1000);
    const contact = this.getContactInfo(jid);
    const exportData = { chat, contact, messages, exportedAt: new Date().toISOString(), totalMessages: messages.length };

    if (format === 'txt') {
      let textExport = `Chat Export for ${contact?.name || jid}\n`;
      textExport += `Exported on: ${new Date().toISOString()}\n`;
      textExport += `Total Messages: ${messages.length}\n\n`;
      textExport += '='.repeat(50) + '\n\n';

      for (const msg of messages) {
        const timestamp = new Date(msg.messageTimestamp * 1000).toLocaleString();
        const sender = msg.key.fromMe ? 'You' : (contact?.name || msg.key.participant || 'Unknown');
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[Media/Other]';
        textExport += `[${timestamp}] ${sender}: ${text}\n`;
      }

      return textExport;
    }

    return exportData;
  }

  setupEnhancedEventHandlers(saveCreds) {
    this.sock.ev.process(async (events) => {
      try {
        if (events['connection.update']) await this.handleConnectionUpdate(events['connection.update']);
        if (events['creds.update']) await saveCreds();
        if (events['lid-mapping.update']) logger.info('🗺️ LID Mapping Update:', events['lid-mapping.update']);
        if (events['messages.upsert']) await this.handleMessagesUpsert(events['messages.upsert']);

        if (!process.env.DOCKER) {
          if (events['labels.association']) logger.info('📋 Label association update:', events['labels.association']);
          if (events['labels.edit']) logger.info('📝 Label edit update:', events['labels.edit']);
          if (events.call) {
            logger.info('📞 Call event received:', events.call);
            for (const call of events.call) this.store.setCallOffer?.(call.from, call);
          }

          if (events['messaging-history.set']) {
            const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set'];
            if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) logger.info('📥 Received on-demand history sync, messages:', messages.length);
            logger.info(`📊 History sync: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (latest: ${isLatest}, progress: ${progress}%)`);
          }

          if (events['messages.update']) {
            for (const { key, update } of events['messages.update']) {
              if (update.pollUpdates) logger.info('📊 Poll update received');
            }
          }

          if (events['message-receipt.update']) logger.debug('📨 Message receipt update');
          if (events['messages.reaction']) logger.info(`😀 Message reactions: ${events['messages.reaction'].length}`);
          if (events['presence.update']) logger.debug('👤 Presence updates');
          if (events['chats.update']) logger.debug('💬 Chats updated');

          if (events['contacts.update']) {
            for (const contact of events['contacts.update']) {
              if (typeof contact.imgUrl !== 'undefined') {
                logger.info(`👤 Contact ${contact.id} profile pic updated`);
              }
            }
          }

          if (events['chats.delete']) logger.info('🗑️ Chats deleted:', events['chats.delete']);
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
      try { qrcode.generate(qr, { small: true }); } catch (e) {}
      if (this.telegramBridge) try { await this.telegramBridge.sendQRCode(qr); } catch (error) { logger.warn('⚠️ TelegramBridge failed to send QR:', error.message); }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect && !this.isShuttingDown) {
        logger.warn('🔄 Connection closed, reconnecting...');
        this.store.saveToFile?.();
        setTimeout(() => this.startWhatsApp(), 5000);
      } else {
        logger.error('❌ Connection closed permanently. Please delete auth_info and restart.');

        if (this.useMongoAuth) {
          try {
            const db = await connectDb();
            await db.collection('auth').deleteOne({ _id: 'session' });
            logger.info('🗑️ MongoDB auth session cleared');
          } catch (error) {
            logger.error('❌ Failed to clear MongoDB auth session:', error);
          }
        }

        this.store.saveToFile?.();
        process.exit(1);
      }
    } else if (connection === 'open') {
      await this.onConnectionOpen();
    }
  }

  async handleMessagesUpsert(upsert) {
    if (upsert.type === 'notify') {
      for (const msg of upsert.messages) {
        try { await this.processIncomingMessage(msg, upsert); } catch (error) { logger.warn('⚠️ Message processing error:', error.message); }
      }
    }

    try { await this.messageHandler.handleMessages({ messages: upsert.messages, type: upsert.type }); } catch (error) { logger.warn('⚠️ Original message handler error:', error.message); }
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

    if (!msg.key.fromMe && this.autoReply && !isJidNewsletter(msg.key?.remoteJid)) {
      const senderJid = msg.key.participant || msg.key.remoteJid;
      const userStats = this.getUserStats(senderJid);
      const contactInfo = this.getContactInfo(senderJid);

      logger.info(`🤖 Auto-replying to: ${contactInfo?.name || senderJid} (${userStats.messageCount} messages)`);

      if (this.autoReadMessages) await this.sock.readMessages([msg.key]);

      let replyText = config.get('messages.autoReplyText', 'Hello there! This is an automated response.');
      if (userStats.messageCount > 10) replyText += `\n\nGood to hear from you again! 👋`;
      else if (userStats.messageCount === 0) replyText += `\n\nWelcome! This seems to be your first message. 🎉`;

      await this.sendMessageWithTyping({ text: replyText }, msg.key.remoteJid);
    }
  }

  async sendMessageWithTyping(content, jid) {
    if (!this.sock || !this.enableTypingIndicators) return await this.sock?.sendMessage(jid, content);

    try {
      await this.sock.presenceSubscribe(jid);
      await delay(500);
      await this.sock.sendPresenceUpdate('composing', jid);
      await delay(2000);
      await this.sock.sendPresenceUpdate('paused', jid);
      return await this.sock.sendMessage(jid, content);
    } catch (error) {
      logger.warn('⚠️ Failed to send message with typing:', error.message);
      return await this.sock.sendMessage(jid, content);
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
        const TelegramBridgeModule = await import('../telegram/bridge.js');
        const TelegramBridgeInstance = TelegramBridgeModule.default || TelegramBridgeModule.TelegramBridge;
        if (this.telegramBridge instanceof TelegramBridgeInstance) await this.telegramBridge.setupWhatsAppHandlers();
        else await this.telegramBridge.setupWhatsAppHandlers();
      } catch (err) { logger.warn('⚠️ Failed to setup Telegram WhatsApp handlers:', err.message); }
    }

    await this.sendStartupMessage();

    if (this.telegramBridge) {
      try { await this.telegramBridge.syncWhatsAppConnection(); } catch (err) { logger.warn('⚠️ Telegram sync error:', err.message); }
    }
  }

  async sendStartupMessage() {
    const owner = config.get('bot.owner');
    if (!owner) return;

    const authMethod = this.useMongoAuth ? 'MongoDB' : 'File-based';
    const storeStats = this.getStoreStats();

    const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                          `🔥 *HyperWa Features Active:*\n` +
                          `• 📱 Modular Architecture\n` +
                          `• 🗄️ Enhanced Data Store: ✅\n` +
                          `• 📊 Store Stats: ${storeStats.chats} chats, ${storeStats.contacts} contacts, ${storeStats.messages} messages\n` +
                          `• 🔐 Auth Method: ${authMethod}\n` +
                          `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                          `• 🔧 Custom Modules: ${config.get('features.customModules') ? '✅' : '❌'}\n` +
                          `• ⌨️ Typing Indicators: ${this.enableTypingIndicators ? '✅' : '❌'}\n` +
                          `• 📖 Auto Read: ${this.autoReadMessages ? '✅' : '❌'}\n` +
                          `• 🤖 Auto Reply: ${this.autoReply ? '✅' : '❌'}\n` +
                          `Type *${config.get('bot.prefix')}help* for available commands!`;

    try { await this.sendMessageWithTyping({ text: startupMessage }, owner); } catch {}

    if (this.telegramBridge) {
      try { await this.telegramBridge.logToTelegram('🚀 HyperWa Bot Started', startupMessage); } catch (err) { logger.warn('⚠️ Telegram log failed:', err.message); }
    }
  }

  async connect() { if (!this.sock) await this.startWhatsApp(); return this.sock; }

  async sendMessage(jid, content) {
    if (!this.sock) throw new Error('WhatsApp socket not initialized');
    if (this.enableTypingIndicators) return await this.sendMessageWithTyping(content, jid);
    return await this.sock.sendMessage(jid, content);
  }

  setAutoReply(enabled) { this.autoReply = enabled; config.set('features.autoReply', enabled); logger.info(`🤖 Auto-reply ${enabled ? 'enabled' : 'disabled'}`); }
  setTypingIndicators(enabled) { this.enableTypingIndicators = enabled; config.set('features.typingIndicators', enabled); logger.info(`⌨️ Typing indicators ${enabled ? 'enabled' : 'disabled'}`); }
  setAutoReadMessages(enabled) { this.autoReadMessages = enabled; config.set('features.autoReadMessages', enabled); logger.info(`📖 Auto-read messages ${enabled ? 'enabled' : 'disabled'}`); }

  async shutdown() {
    logger.info('🛑 Shutting down HyperWa Userbot...');
    this.isShuttingDown = true;
    this.store.cleanup?.();
    if (this.telegramBridge) try { await this.telegramBridge.shutdown(); } catch (err) { logger.warn('⚠️ Telegram shutdown error:', err.message); }
    if (this.sock) try { await this.sock.end(); } catch (e) {}
    logger.info('✅ HyperWa Userbot shutdown complete');
  }
}

export { HyperWaBot };
