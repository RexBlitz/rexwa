import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  delay,
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
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;

    // Readline for pairing input
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Enhanced in-memory store
    this.store = makeInMemoryStore({
      logger: logger.child({ module: 'store' }),
      filePath: './whatsapp-store.json',
      autoSaveInterval: 30000,
    });
    this.store.loadFromFile();

    // Cache
    this.msgRetryCounterCache = new NodeCache();
    this.groupMetadataCache = new NodeCache();
    this.onDemandMap = new Map();

    // Cleanup old data
    setInterval(() => {
      if (this.onDemandMap.size > 100) this.onDemandMap.clear();
    }, 300000);

    this.setupStoreEventListeners();
  }

  setupStoreEventListeners() {
    this.store.on('messages.upsert', (data) => {
      logger.debug(`Store: ${data.messages.length} messages cached`);
    });
    this.store.on('contacts.upsert', (contacts) => {
      logger.debug(`Store: ${contacts.length} contacts cached`);
    });
    this.store.on('chats.upsert', (chats) => {
      logger.debug(`Store: ${chats.length} chats cached`);
    });
    this.store.on('lid-mapping.update', (mapping) => {
      logger.debug(`LID Mapping Update: ${Object.keys(mapping).length} mappings`);
    });

    setInterval(() => {
      const stats = this.getStoreStats();
      logger.info(`Store Stats - Chats: ${stats.chats}, Contacts: ${stats.contacts}, Messages: ${stats.messages}`);
    }, 300000);
  }

  getStoreStats() {
    const chatCount = Object.keys(this.store.chats).length;
    const contactCount = Object.keys(this.store.contacts).length;
    const messageCount = Object.values(this.store.messages)
      .reduce((total, chatMessages) => total + Object.keys(chatMessages).length, 0);
    return { chats: chatCount, contacts: contactCount, messages: messageCount };
  }

  question(text) {
    return new Promise((resolve) => this.rl.question(text, resolve));
  }

  async initialize() {
    logger.info('Initializing HyperWa Userbot...');

    try {
      this.db = await connectDb();
      logger.info('Database connected successfully!');
    } catch (error) {
      logger.error('Failed to connect to database:', error);
      process.exit(1);
    }

    if (config.get('telegram.enabled')) {
      try {
        const { default: TelegramBridge } = await import('../telegram/bridge.js');
        this.telegramBridge = new TelegramBridge(this);
        await this.telegramBridge.initialize();
        logger.info('Telegram bridge initialized');
        await this.telegramBridge.sendStartMessage().catch(() => {});
      } catch (error) {
        logger.warn('Telegram bridge failed:', error.message);
        this.telegramBridge = null;
      }
    }

    await this.moduleLoader.loadModules();
    await this.startWhatsApp();
    logger.info('HyperWa Userbot initialized successfully!');
  }

  async startWhatsApp() {
    const delay = (ms) => new Promise((res) => setTimeout(res, ms));

    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      let state, saveCreds;

      try {
        // Cleanup old socket
        if (this.sock) {
          logger.info('Cleaning up existing WhatsApp socket');
          this.sock.ev.removeAllListeners();
          await this.sock.end().catch(() => {});
          this.sock = null;
        }

        // Auth state
        if (this.useMongoAuth) {
          logger.info('Using MongoDB auth state...');
          try {
            ({ state, saveCreds } = await useMongoAuthState());
          } catch (error) {
            logger.error('MongoDB auth failed:', error);
            logger.info('Falling back to file-based auth...');
            ({ state, saveCreds } = await useMultiFileAuthState(this.authPath));
          }
        } else {
          logger.info('Using file-based auth state...');
          ({ state, saveCreds } = await useMultiFileAuthState(this.authPath));
        }

        const { version, isLatest } = await fetchLatestBaileysVersion();
        logger.info(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        // Create socket
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
          retryRequestDelayMs: 1000,
          connectTimeoutMs: 60000,
          defaultQueryTimeoutMs: 60000,
          printQRInTerminal: false,
        });

        this.store.bind(this.sock.ev);
        logger.info('Store bound to socket');

        // Pairing code flow
        if (this.usePairingCode && !state.creds.registered) {
          await this.handlePairingCode();
        }

        // Wait for connection
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (!this.sock?.user) {
              logger.warn('Connection timed out after 60s');
              reject(new Error('Timeout'));
            }
          }, 60000);

          this.sock.ev.once('connection.update', (update) => {
            if (update.connection === 'open') {
              clearTimeout(timeout);
              this.reconnectAttempts = 0;
              resolve();
            }
          });
        });

        this.setupEnhancedEventHandlers(saveCreds);
        logger.info(`Connected! User: ${this.sock.user?.id}`);
        return;

      } catch (error) {
        this.reconnectAttempts++;
        const backoff = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 60000);
        logger.error(`Connection failed (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}):`, error.message);
        logger.info(`Retrying in ${backoff / 1000}s...`);
        await delay(backoff);
      }
    }

    logger.error('Max reconnect attempts reached. Exiting.');
    await this.clearAuthState();
    process.exit(1);
  }

  async handlePairingCode() {
    return new Promise(async (resolve, reject) => {
      try {
        logger.info('Pairing code authentication requested');

        let phoneNumber = config.get('auth.phoneNumber');
        if (!phoneNumber) {
          phoneNumber = await this.question('Enter phone number (e.g., 1234567890):\n');
          if (!/^\d{10,15}$/.test(phoneNumber)) {
            logger.error('Invalid phone number');
            return reject(new Error('Invalid phone'));
          }
        }

        logger.info(`Requesting pairing code for: ${phoneNumber}`);
        this.pairingCode = await this.sock.requestPairingCode(phoneNumber.trim());
        logger.info(`Pairing code: ${this.pairingCode}`);

        if (this.telegramBridge) {
          this.telegramBridge.sendPairingCode(this.pairingCode, phoneNumber).catch(() => {});
        }

        console.log('\n' + '='.repeat(50));
        console.log(`WHATSAPP PAIRING CODE: ${this.pairingCode}`);
        console.log('='.repeat(50) + '\n');
        logger.info('Waiting for pairing confirmation...');

        const timeout = setTimeout(() => {
          logger.error('Pairing timed out after 60s');
          reject(new Error('Pairing timeout'));
        }, 60000);

        const handler = (update) => {
          const { connection, isNewLogin } = update;
          if (connection === 'open' || isNewLogin) {
            clearTimeout(timeout);
            this.sock.ev.removeListener('connection.update', handler);
            logger.info('Pairing completed successfully!');
            resolve();
          } else if (connection === 'close') {
            clearTimeout(timeout);
            this.sock.ev.removeListener('connection.update', handler);
            reject(new Error('Connection closed during pairing'));
          }
        };

        this.sock.ev.on('connection.update', handler);

      } catch (error) {
        logger.error('Failed to request pairing code:', error);
        reject(error);
      }
    });
  }

  async getMessage(key) {
    if (!key?.remoteJid || !key?.id) return undefined;
    const msg = this.store.loadMessage(key.remoteJid, key.id);
    if (msg?.message) return msg.message;
    if (key.remoteJidAlt) {
      const alt = this.store.loadMessage(key.remoteJidAlt, key.id);
      if (alt?.message) return alt.message;
    }
    return undefined;
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
      } catch (error) {
        logger.warn('Event processing error:', error.message);
      }
    });
  }

  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr && !this.usePairingCode) {
      qrcode.generate(qr, { small: true });
      if (this.telegramBridge) this.telegramBridge.sendQRCode(qr).catch(() => {});
    }

    if (isNewLogin) {
      logger.info('New login detected!');
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = status !== DisconnectReason.loggedOut;
      if (!shouldReconnect || this.isShuttingDown) {
        logger.error('Connection closed permanently.');
        await this.clearAuthState();
        process.exit(1);
      }
    } else if (connection === 'open') {
      await this.onConnectionOpen();
    }
  }

  async onConnectionOpen() {
    logger.info(`Connected to WhatsApp! User: ${this.sock.user?.id}`);

    if (!config.get('bot.owner') && this.sock.user) {
      config.set('bot.owner', this.sock.user.id);
      logger.info(`Owner set to: ${this.sock.user.id}`);
    }

    if (this.telegramBridge) {
      this.telegramBridge.setupWhatsAppHandlers().catch(() => {});
    }

    if (this.isFirstConnection) {
      await this.sendStartupMessage();
      this.isFirstConnection = false;
    }

    if (this.rl) this.rl.close();
  }

  async sendStartupMessage() {
    const owner = config.get('bot.owner');
    if (!owner) return;

    const stats = this.getStoreStats();
    const message = `HyperWa v${config.get('bot.version')} is online!\n\n` +
      `Auth: ${this.usePairingCode ? 'Pairing Code' : 'QR'}\n` +
      `Storage: ${this.useMongoAuth ? 'MongoDB' : 'File'}\n` +
      `Telegram: ${config.get('telegram.enabled') ? 'ON' : 'OFF'}\n` +
      `Store: ${stats.chats} chats, ${stats.contacts} contacts\n\n` +
      `Type *${config.get('bot.prefix')}help*`;

    await this.sendMessage(owner, { text: message }).catch(() => {});
    if (this.telegramBridge) {
      this.telegramBridge.logToTelegram('Bot Started', message).catch(() => {});
    }
  }

  async handleMessagesUpsert(upsert) {
    if (upsert.type !== 'notify') return;
    for (const msg of upsert.messages) {
      if (!msg.message) continue;
      await this.messageHandler.handleMessages({ messages: [msg], type: 'notify' }).catch(() => {});
    }
  }

  async clearAuthState() {
    if (this.useMongoAuth) {
      try {
        const db = await connectDb();
        await db.collection('auth').deleteMany({});
        logger.info('MongoDB auth cleared');
      } catch (e) {
        logger.error('Failed to clear MongoDB auth:', e);
      }
    } else {
      await fs.remove(this.authPath).catch(() => {});
    }
  }

  async sendMessage(jid, content) {
    if (!this.sock) throw new Error('Not connected');
    return await this.sock.sendMessage(jid, content);
  }

  async shutdown() {
    logger.info('Shutting down...');
    this.isShuttingDown = true;
    this.store.saveToFile();
    if (this.rl) this.rl.close();
    if (this.telegramBridge) await this.telegramBridge.shutdown().catch(() => {});
    if (this.sock) await this.sock.end().catch(() => {});
    logger.info('Shutdown complete');
  }
}

export { HyperWaBot };
export default HyperWaBot;
