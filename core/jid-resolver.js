import logger from './logger.js';

export default class JidResolver {
    constructor(whatsappBot, contactMappings) {
        this.whatsappBot = whatsappBot;
        this.lidMappings = new Map();
        this.contactMappings = contactMappings || new Map();
    }

    async resolveLidToPn(jid) {
        try {
            if (!jid.includes('@lid')) return jid;
            const cached = this.lidMappings.get(jid);
            if (cached?.pn) return cached.pn;

            logger.debug(`🔄 Resolving LID to PN: ${jid}`);
            const pnJid = await this.whatsappBot.sock.signalRepository.lidMapping?.getPNForLID?.(jid);
            if (pnJid) {
                this.lidMappings.set(jid, { pn: pnJid });
                logger.info(`✅ Resolved LID ${jid} → PN ${pnJid}`);
                return pnJid;
            }
            return jid;
        } catch (err) {
            logger.error(`❌ Error resolving LID ${jid}:`, err);
            return jid;
        }
    }

    async getDisplayName(jid) {
        try {
            const pnJid = await this.resolveLidToPn(jid);
            const phone = pnJid.split('@')[0];

            const cached = this.contactMappings.get(phone);
            if (cached) return cached;

            const contact = this.whatsappBot.sock.store?.contacts?.[pnJid]
                || this.whatsappBot.sock.store?.contacts?.[jid];
            let name = contact?.name || contact?.notify || contact?.verifiedName;
            if (name && name.length > 2 && !name.startsWith('+')) {
                this.contactMappings.set(phone, name);
                return name;
            }
            return `+${phone}`;
        } catch (err) {
            logger.error(`❌ Error getting display name for ${jid}:`, err);
            return `+${jid.split('@')[0]}`;
        }
    }
}
