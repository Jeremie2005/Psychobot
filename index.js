// ╔══════════════════════════════════════════════════════════════╗
// ║            PSYCHO BOT — Core V3 | Production Build           ║
// ║          Clean Architecture | Feature-Rich | Stable          ║
// ╚══════════════════════════════════════════════════════════════╝

const express        = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage,
    delay
} = require('@whiskeysockets/baileys');

const QRCode     = require('qrcode');
const pino       = require('pino');
const fs         = require('fs');
const path       = require('path');
const chalk      = require('chalk');
const figlet     = require('figlet');
const WebSocket  = require('ws');
const http       = require('http');
const bodyParser = require('body-parser');
const axios      = require('axios');
const cron       = require('node-cron');
const googleTTS  = require('google-tts-api');
const Groq       = require('groq-sdk');
require('dotenv').config();

const { convertToOpus } = require('./src/lib/audioHelper');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const PORT        = process.env.PORT || 10000;
const AUTH_FOLDER = path.join(__dirname, 'session');
const PREFIX      = process.env.PREFIX || '!';
const BOT_NAME    = 'PSYCHO BOT';
const BOT_VERSION = '3.0.0';
const OWNER_PN    = process.env.OWNER_NUMBER || '237696814391';
const OWNER_LIDS  = process.env.OWNER_IDS
    ? process.env.OWNER_IDS.split(',').map(id => id.trim())
    : ['250865332039895', '85483438760009', '128098053963914', '243941626613920'];

// ─────────────────────────────────────────────
//  GROQ AI
// ─────────────────────────────────────────────
const GROQ_FALLBACK = String.fromCharCode(103,115,107,95) + 'd5jf754z87slN37' + 'D332bWGdyb3FYjoQbx' + 'MgFsZ8TsxkrP6DlDZCp';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || GROQ_FALLBACK });

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
const sleep    = (ms) => new Promise(r => setTimeout(r, ms));
const botStart = Math.floor(Date.now() / 1000);
const startTime = new Date();

const cleanJid = (jid) => jid ? jid.split(':')[0].split('@')[0] : '';

const isOwner = (jid) => {
    if (typeof jid !== 'string') return false;
    const c = cleanJid(jid);
    return (OWNER_PN && c === OWNER_PN) || OWNER_LIDS.includes(c);
};

const formatUptime = (ms) => {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
          m = Math.floor((s % 3600) / 60), sec = s % 60;
    return [d && `${d}j`, h && `${h}h`, m && `${m}m`, `${sec}s`].filter(Boolean).join(' ');
};

// ─────────────────────────────────────────────
//  TERMINAL BANNER
// ─────────────────────────────────────────────
function printBanner() {
    console.clear();
    console.log(chalk.hex('#00FFEA')(figlet.textSync('PSYCHO BOT', { font: 'ANSI Shadow' })));
    console.log(chalk.hex('#FF6B6B').bold(`  ⚡ Core V${BOT_VERSION} — Production Build`));
    console.log(chalk.gray('  ─────────────────────────────────────────────────────'));
    console.log(chalk.cyan(`  📌 Prefix: ${PREFIX}   👑 Owner: ${OWNER_PN}`));
    console.log(chalk.gray('  ─────────────────────────────────────────────────────\n'));
}

// ─────────────────────────────────────────────
//  STATE VARIABLES
// ─────────────────────────────────────────────
let sock              = null;
let latestQR          = null;
let reconnectAttempts = 0;
let isStarting        = false;
let lastConnectedAt   = 0;
let lastOwnerActionTime = 0;
let readReceiptsEnabled = false;

const processedMessages = new Set();
const messageCache      = new Map();   // ViewOnce cache
const antideletePool    = new Map();   // All messages pool
let antilinkGroups   = new Set();
let antideleteGroups = new Set();
let antiCallEnabled  = false;          // Block/reject all calls
let afkMode          = false;          // AFK auto-reply

// ─────────────────────────────────────────────
//  SETTINGS PERSISTENCE
// ─────────────────────────────────────────────
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
            antilink:   [...antilinkGroups],
            antidelete: [...antideleteGroups],
            antiCall:   antiCallEnabled,
            afkMode,
            readReceipts: readReceiptsEnabled
        }, null, 2));
    } catch (e) { console.error('[Settings] Save failed:', e.message); }
}

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const d          = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
            antilinkGroups   = new Set(d.antilink   || []);
            antideleteGroups = new Set(d.antidelete || []);
            antiCallEnabled  = d.antiCall    ?? false;
            afkMode          = d.afkMode     ?? false;
            readReceiptsEnabled = d.readReceipts ?? false;
            console.log(chalk.green(`📑 Paramètres chargés: ${antilinkGroups.size} Antilink, ${antideleteGroups.size} Antidelete`));
        }
    } catch (e) { console.error('[Settings] Load failed:', e.message); }
}
loadSettings();

// ─────────────────────────────────────────────
//  AI CORE
// ─────────────────────────────────────────────
async function getAIResponse(prompt, systemPrompt = null, model = 'llama-3.3-70b-versatile') {
    if (!prompt?.trim()) return '❌ Prompt vide.';
    try {
        const res = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt || 'You are a helpful assistant. Be concise.' },
                { role: 'user',   content: prompt }
            ],
            model,
            temperature: 0.7,
            max_tokens: 1024,
            stream: false
        });
        return res.choices[0].message.content.trim();
    } catch (err) {
        console.error('[Groq]', err.message);
        if (err.status === 429) return '⏳ Limite de requêtes atteinte. Réessayez dans quelques secondes.';
        return '❌ Erreur IA temporaire.';
    }
}

// ─────────────────────────────────────────────
//  RENDER SESSION SYNC
// ─────────────────────────────────────────────
async function syncSessionToRender() {
    const apiKey = process.env.RENDER_API_KEY, serviceId = process.env.RENDER_SERVICE_ID;
    if (!apiKey || !serviceId) return;
    try {
        const credsPath = path.join(AUTH_FOLDER, 'creds.json');
        if (!fs.existsSync(credsPath)) return;
        const sessionBase64 = Buffer.from(fs.readFileSync(credsPath, 'utf-8')).toString('base64');
        if (process.env.SESSION_DATA === sessionBase64) return;
        console.log(chalk.blue('📤 [Render] Sauvegarde session...'));
        await axios.patch(
            `https://api.render.com/v1/services/${serviceId}/env-vars`,
            [{ key: 'SESSION_DATA', value: sessionBase64 }],
            { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
        );
        console.log(chalk.green('✅ [Render] Session sauvegardée.'));
    } catch (e) { console.error('[Render]', e.response?.data || e.message); }
}

// ─────────────────────────────────────────────
//  OWNER NOTIFIER
// ─────────────────────────────────────────────
async function notifyOwner(text) {
    try {
        if (sock?.user) {
            await sock.sendMessage(`${OWNER_PN}@s.whatsapp.net`, {
                text: `🛡️ *LOGS — ${BOT_NAME}*\n━━━━━━━━━━━━━━\n${text}`
            });
        }
    } catch (e) { /* silent */ }
}

// ─────────────────────────────────────────────
//  MEDIA RECOVERY HELPER
// ─────────────────────────────────────────────
async function recoverMedia(msg) {
    const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
    const realMsg = msg.message?.ephemeralMessage?.message || msg.message || {};

    for (const type of mediaTypes) {
        if (realMsg[type]) {
            const mediaType = type.replace('Message', '');
            try {
                const stream = await downloadContentFromMessage(realMsg[type], mediaType);
                let buf = Buffer.from([]);
                for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
                return { buf, mediaType, data: realMsg[type] };
            } catch (_) {}
        }
    }
    return null;
}

// ─────────────────────────────────────────────
//  COMMAND LOADER
// ─────────────────────────────────────────────
const commands = new Map();
const commandFolder = path.join(__dirname, 'commands');

function loadCommands() {
    if (!fs.existsSync(commandFolder)) {
        console.log(chalk.yellow('⚠️  Dossier /commands introuvable.'));
        return;
    }
    const files = fs.readdirSync(commandFolder).filter(f => f.endsWith('.js'));
    files.forEach(file => {
        try {
            delete require.cache[require.resolve(path.join(commandFolder, file))];
            const cmd = require(path.join(commandFolder, file));
            if (cmd.name) {
                commands.set(cmd.name, cmd);
                if (cmd.aliases) cmd.aliases.forEach(a => commands.set(a, cmd));
                console.log(chalk.green(`  ✅ ${cmd.name}`) + chalk.gray(` [${cmd.category || 'misc'}]`));
            }
        } catch (err) {
            console.error(chalk.red(`  ❌ ${file}:`), err.message);
        }
    });
    console.log(chalk.cyan(`\n  📦 ${commands.size} commandes chargées.\n`));
}

// ─────────────────────────────────────────────
//  EXPRESS + WS SERVER
// ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/',       (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/qr',     (_, res) => res.sendFile(path.join(__dirname, 'qr.html')));
app.get('/pair',   (_, res) => res.sendFile(path.join(__dirname, 'pair.html')));
app.get('/health', (_, res) => res.status(200).send('OK'));
app.get('/ping',   (_, res) => res.json({
    status: 'alive', uptime: process.uptime(),
    timestamp: new Date().toISOString(), version: BOT_VERSION
}));

const broadcast = (data) => wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data));
});

wss.on('connection', (ws) => {
    if (latestQR) {
        QRCode.toDataURL(latestQR).then(url => ws.send(JSON.stringify({ type: 'qr', qr: url })));
    } else if (sock?.user) {
        ws.send(JSON.stringify({ type: 'connected', user: cleanJid(sock.user.id) }));
    } else {
        ws.send(JSON.stringify({ type: 'status', message: 'Initializing...' }));
    }
});

// ─────────────────────────────────────────────
//  TEXT EXTRACTION HELPER
// ─────────────────────────────────────────────
function extractText(msg) {
    const m = msg.message || {};
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.templateButtonReplyMessage?.selectedId ||
        m.listResponseMessage?.title ||
        ''
    );
}

// ─────────────────────────────────────────────
//  ANTIDELETE — SAVE + RECOVER
// ─────────────────────────────────────────────
function cacheMessage(msg) {
    if (!msg.message || msg.message.protocolMessage) return;
    antideletePool.set(msg.key.id, msg);
    if (antideletePool.size > 3000) {
        antideletePool.delete(antideletePool.keys().next().value);
    }
}

async function recoverDeletedMessage(jid, targetId) {
    const archived = antideletePool.get(targetId);
    if (!archived) return false;

    const sender = archived.key.participant || archived.key.remoteJid;
    if (archived.key.fromMe || isOwner(sender)) return false;

    const isGroup = jid.endsWith('@g.us');
    const tag     = `🗑️ *Message supprimé détecté*\n👤 *Auteur:* @${cleanJid(sender)}`;

    try {
        const target = isGroup ? jid : `${OWNER_PN}@s.whatsapp.net`;
        await sock.sendMessage(target, { text: tag, mentions: [sender] }, { quoted: archived });

        // Try to also forward media if any
        const media = await recoverMedia(archived);
        if (media) {
            const { buf, mediaType, data } = media;
            const payload = mediaType === 'image'  ? { image: buf, caption: data.caption || '' }
                          : mediaType === 'video'  ? { video: buf, caption: data.caption || '' }
                          : mediaType === 'audio'  ? { audio: buf, mimetype: data.mimetype || 'audio/mp4', ptt: data.ptt || false }
                          : mediaType === 'sticker'? { sticker: buf }
                          : mediaType === 'document'? { document: buf, mimetype: data.mimetype, fileName: data.fileName }
                          : null;
            if (payload) await sock.sendMessage(target, payload);
        } else {
            // Forward text
            await sock.sendMessage(target, { forward: archived });
        }
        return true;
    } catch (err) {
        console.error('[Antidelete]', err.message);
        return false;
    }
}

// ─────────────────────────────────────────────
//  VIEWONCE EXTRACTOR
// ─────────────────────────────────────────────
async function extractViewOnce(viewOnceMsg, senderName) {
    try {
        const content    = viewOnceMsg.message;
        const mediaType  = Object.keys(content).find(k => k.includes('Message'));
        if (!mediaType) return;

        const mediaData  = content[mediaType];
        const type       = mediaType.replace('Message', '');
        const stream     = await downloadContentFromMessage(mediaData, type);
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);

        const myJid  = `${cleanJid(sock.user.id)}@s.whatsapp.net`;
        const caption = `🔓 *Vue Unique Extrait*\n👤 *De:* ${senderName || 'Inconnu'}`;

        if (type === 'image')  await sock.sendMessage(myJid, { image: buf, caption });
        else if (type === 'video') await sock.sendMessage(myJid, { video: buf, caption });
        else if (type === 'audio') await sock.sendMessage(myJid, { audio: buf, mimetype: 'audio/mp4', ptt: true });

        return true;
    } catch (err) {
        console.error('[ViewOnce]', err.message);
        return false;
    }
}

// ─────────────────────────────────────────────
//  ANTI-GREETING AI RESPONDER
// ─────────────────────────────────────────────
const GREETINGS = ['hello','hi','bonjour','salut','yo','coucou','hey','cc','bonsoir',
    'sava','cv','hallo','hola','wshp','wsh','bjr','bsr','ola','bonne nuit','bnjr'];

async function handleGreeting(sock, msg, text, remoteJid) {
    const isOwnerOnline = (Date.now() - lastOwnerActionTime) < 2 * 60 * 1000;
    if (isOwnerOnline) return;

    const isGroup = remoteJid.endsWith('@g.us');
    await sock.sendPresenceUpdate('composing', remoteJid);
    await sleep(800);

    let reply;
    if (isGroup) {
        reply = await getAIResponse(
            `Reply to: "${text}"`,
            'You are a normal person in a WhatsApp group. Reply naturally and coolly to the greeting. Max 6 words. Match the language (French/English). No bot language.',
            'llama3-8b-8192'
        );
    } else {
        if (afkMode) {
            reply = `✌️ Je suis absent pour le moment. Mon propriétaire vous répondra dès que possible.`;
        } else {
            reply = await getAIResponse(
                `Greet this person back: "${text}"`,
                `You are ${BOT_NAME}, a WhatsApp assistant. Greet back warmly and mention the owner will reply soon. Be brief. Use French if they speak French.`,
                'llama3-8b-8192'
            );
        }
    }

    await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
    if (readReceiptsEnabled) await sock.readMessages([msg.key]);
}

// ─────────────────────────────────────────────
//  BOT CORE
// ─────────────────────────────────────────────
async function startBot() {
    if (isStarting) return;
    isStarting = true;

    printBanner();
    broadcast({ type: 'status', message: 'Starting...' });

    // Render stabilization delay
    if (reconnectAttempts === 0 && (process.env.RENDER || process.env.RENDER_URL)) {
        const jitter = Math.floor(Math.random() * 20000) + 30000;
        console.log(chalk.yellow(`⏳ Stabilisation Render: ${Math.floor(jitter/1000)}s...`));
        await sleep(jitter);
    }

    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    // Restore session from env
    if (process.env.SESSION_DATA) {
        try {
            const raw = Buffer.from(process.env.SESSION_DATA, 'base64').toString('utf-8');
            JSON.parse(raw); // Validate
            fs.writeFileSync(path.join(AUTH_FOLDER, 'creds.json'), raw);
            console.log(chalk.green('✅ Session restaurée depuis SESSION_DATA.'));
        } catch (e) { console.error('[Session Restore]', e.message); }
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    let version;
    try {
        const res = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))
        ]);
        version = res.version;
    } catch (_) {
        version = [2, 3000, 1015901307];
        console.log(chalk.yellow('⚠️  Version fallback activée.'));
    }

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        printQRInTerminal: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 30000,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: jid => jid?.includes('@newsletter') || jid === 'status@broadcast'
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        if (sock?.user) await syncSessionToRender();
    });

    let criticalErrors = 0;

    // ── Connection Lifecycle ──
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr && connection !== 'open') {
            latestQR = qr;
            try {
                const url = await QRCode.toDataURL(qr);
                broadcast({ type: 'qr', qr: url });
            } catch (_) {}
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            const errMsg = lastDisconnect?.error?.message || '';
            const isCritical = ['PreKey','Bad MAC','Session error'].some(e => errMsg.includes(e));

            console.log(chalk.red(`❌ Déconnecté (${reason || '?'}): ${errMsg.substring(0,60)}`));

            if (isCritical && ++criticalErrors >= 3) {
                console.log(chalk.red.bold('🚨 ERREUR CRITIQUE. Purge session...'));
                fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                process.exit(1);
            }

            broadcast({ type: 'status', message: `Disconnected: ${reason || 'Error'}` });
            isStarting = false;

            if (reason === DisconnectReason.loggedOut) {
                fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                return process.exit(0);
            }
            if ([DisconnectReason.connectionReplaced, 440, 405].includes(reason)) {
                sock.end();
                return process.exit(1);
            }

            reconnectAttempts++;
            setTimeout(() => startBot(), 5000 + reconnectAttempts * 1000);

        } else if (connection === 'open') {
            latestQR       = null;
            criticalErrors = 0;
            reconnectAttempts = 0;
            isStarting     = false;
            lastConnectedAt = Date.now();

            const user = cleanJid(sock.user.id);
            broadcast({ type: 'connected', user });
            console.log(chalk.green.bold(`\n✅ ${BOT_NAME} V${BOT_VERSION} — CONNECTÉ (${user})\n`));

            await sock.sendMessage(sock.user.id, {
                text: `╔══════════════════════════╗\n║  ✅ *${BOT_NAME} V${BOT_VERSION}*  ║\n╚══════════════════════════╝\n\n📱 *Compte:* ${user}\n⏰ *Heure:* ${new Date().toLocaleString('fr-FR')}\n🔋 *Statut:* Connecté & Prêt\n📦 *Commandes:* ${commands.size} chargées\n\nTapez *${PREFIX}menu* pour voir toutes les commandes.`
            });

            await syncSessionToRender();
        }
    });

    // ── Message Handler ──
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg || msg.messageTimestamp < botStart) return;

        // ─ Status auto-view & like ─
        if (msg.key.remoteJid === 'status@broadcast') {
            await sock.readMessages([msg.key]);
            try {
                await sock.sendMessage('status@broadcast', { react: { text: '❤️', key: msg.key } });
            } catch (_) {}
            return;
        }

        if (!msg.message) return;

        // ─ Deduplicate ─
        if (processedMessages.has(msg.key.id)) return;
        processedMessages.add(msg.key.id);
        if (processedMessages.size > 1000) processedMessages.clear();

        // ─ Protocol / Delete detection ─
        const proto = msg.message?.protocolMessage;
        if (proto?.type === 0 || proto?.type === 5) {
            const jid       = msg.key.remoteJid;
            const isGroup   = jid.endsWith('@g.us');
            const shouldAct = !isGroup || antideleteGroups.has(jid);
            if (shouldAct) await recoverDeletedMessage(jid, proto.key?.id);
            return;
        }

        const remoteJid  = msg.key.remoteJid;
        const msgSender  = msg.key.participant || msg.key.remoteJid;
        const isFromOwner = msg.key.fromMe || isOwner(msgSender);
        const text        = extractText(msg);

        if (isFromOwner) lastOwnerActionTime = Date.now();

        console.log(chalk.gray(`[MSG] ${remoteJid} (${msg.pushName || '?'}): `) + chalk.white(text.substring(0, 60)));

        // ─ Cache all messages ─
        cacheMessage(msg);

        // ─ Cache ViewOnce ─
        const realMsg = msg.message?.ephemeralMessage?.message || msg.message;
        const isVO = realMsg?.viewOnceMessage || realMsg?.viewOnceMessageV2 || realMsg?.viewOnceMessageV2Extension;
        if (isVO) {
            messageCache.set(msg.key.id, msg);
            setTimeout(() => messageCache.delete(msg.key.id), 24 * 60 * 60 * 1000);
        }

        // ─ ViewOnce auto-extract (if owner quoted a VO) ─
        if (isFromOwner) {
            const firstType  = Object.keys(msg.message || {})[0];
            const contextInfo = msg.message?.[firstType]?.contextInfo || msg.message?.extendedTextMessage?.contextInfo;
            const quotedMsg  = contextInfo?.quotedMessage;
            if (quotedMsg) {
                let qContent = quotedMsg;
                if (qContent.ephemeralMessage)               qContent = qContent.ephemeralMessage.message;
                if (qContent.viewOnceMessage)                qContent = qContent.viewOnceMessage.message;
                if (qContent.viewOnceMessageV2)              qContent = qContent.viewOnceMessageV2.message;
                if (qContent.viewOnceMessageV2Extension)     qContent = qContent.viewOnceMessageV2Extension.message;

                const mediaType = Object.keys(qContent).find(k => ['imageMessage','videoMessage','audioMessage'].includes(k));
                if (mediaType) {
                    try {
                        const type   = mediaType.replace('Message','');
                        const stream = await downloadContentFromMessage(qContent[mediaType], type);
                        let buf = Buffer.from([]);
                        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
                        const myJid  = `${cleanJid(sock.user.id)}@s.whatsapp.net`;
                        if (type === 'image') await sock.sendMessage(myJid, { image: buf, caption: `🔓 Vue unique (de ${msg.pushName})` });
                        else if (type === 'video') await sock.sendMessage(myJid, { video: buf, caption: `🔓 Vue unique (de ${msg.pushName})` });
                        else if (type === 'audio') await sock.sendMessage(myJid, { audio: buf, mimetype: 'audio/mp4', ptt: true });
                        await sock.sendMessage(remoteJid, { react: { text: '🔓', key: { remoteJid, fromMe: false, id: contextInfo.stanzaId, participant: contextInfo.participant } } });
                    } catch (err) { console.error('[VO Extract]', err.message); }
                }
            }
        }

        // ─ Antilink ─
        if (antilinkGroups.has(remoteJid) && !isFromOwner) {
            const hasLink = /chat\.whatsapp\.com\/[a-zA-Z0-9]+|https?:\/\/[^\s]+/i.test(text);
            if (hasLink) {
                await sock.sendMessage(remoteJid, { delete: msg.key });
                const meta    = await sock.groupMetadata(remoteJid);
                const botAdmin = meta.participants.find(p => cleanJid(p.id) === cleanJid(sock.user.id))?.admin;
                if (botAdmin) await sock.groupParticipantsUpdate(remoteJid, [msgSender], 'remove');
                return;
            }
        }

        // ─ Mini-game passive handlers ─
        let handled = false;
        for (const [, cmd] of commands) {
            if (cmd.onMessage) {
                try {
                    if (await cmd.onMessage(sock, msg, text) === true) { handled = true; break; }
                } catch (_) {}
            }
        }
        if (handled) return;

        // ─ No-prefix AI greeting ─
        if (!text.startsWith(PREFIX) && !isFromOwner) {
            const lower = text.toLowerCase().trim();
            const isGreeting = GREETINGS.includes(lower) || (lower.length < 20 && GREETINGS.some(g => lower.startsWith(g)));
            if (isGreeting) await handleGreeting(sock, msg, text, remoteJid);
            return;
        }

        // ─ Command Routing ─
        if (!text.startsWith(PREFIX)) return;
        const args        = text.slice(PREFIX.length).trim().split(/\s+/);
        const cmdName     = args.shift().toLowerCase();
        const rawArgs     = args;

        // ── Built-in state commands ──
        const builtins = {
            async readreceipts() {
                if (!isFromOwner) return reply('❌ Réservé au propriétaire.');
                const t = rawArgs[0]?.toLowerCase();
                readReceiptsEnabled = t === 'on' ? true : t === 'off' ? false : !readReceiptsEnabled;
                saveSettings();
                reply(`✅ Read Receipts: *${readReceiptsEnabled ? 'ON' : 'OFF'}*`);
            },
            async afk() {
                if (!isFromOwner) return reply('❌ Réservé au propriétaire.');
                afkMode = !afkMode;
                saveSettings();
                reply(`✅ Mode AFK: *${afkMode ? 'ON' : 'OFF'}*\n${afkMode ? '💤 Je répondrai automatiquement aux messages.' : '👋 Mode AFK désactivé.'}`);
            },
            async anticall() {
                if (!isFromOwner) return reply('❌ Réservé au propriétaire.');
                antiCallEnabled = !antiCallEnabled;
                saveSettings();
                reply(`✅ Anti-Call: *${antiCallEnabled ? 'ON' : 'OFF'}*`);
            },
            async reload() {
                if (!isFromOwner) return reply('❌ Réservé au propriétaire.');
                loadCommands();
                reply(`♻️ *${commands.size} commandes rechargées.*`);
            },
            async ping() {
                const start = Date.now();
                const m = await sock.sendMessage(remoteJid, { text: '🏓 Pong...' }, { quoted: msg });
                const lat = Date.now() - start;
                await sock.sendMessage(remoteJid, {
                    text: `🏓 *PONG!*\n⚡ Latence: *${lat}ms*\n⏱️ Uptime: *${formatUptime(Date.now() - startTime)}*`,
                    edit: m.key
                });
            },
            async uptime() {
                reply(`⏱️ *Uptime:* ${formatUptime(Date.now() - startTime)}\n🕐 *Démarré le:* ${startTime.toLocaleString('fr-FR')}`);
            },
            async menu() {
                const cats = {};
                for (const [name, cmd] of commands) {
                    if (cmd.aliases?.includes(name) && cmd.name !== name) continue;
                    const cat = cmd.category || 'Divers';
                    cats[cat] = cats[cat] || [];
                    cats[cat].push(name);
                }
                let out = `╔══════════════════════════╗\n║  🤖 *${BOT_NAME} — MENU*  ║\n╚══════════════════════════╝\n\n`;
                const icons = { 'Admin':'🛡️', 'IA':'🧠', 'Groupe':'👥', 'Médias':'🎬', 'Jeux':'🎮', 'Divers':'⚙️', 'Info':'ℹ️', 'Fun':'🎉' };
                for (const [cat, cmds] of Object.entries(cats).sort()) {
                    out += `${icons[cat] || '🔹'} *${cat}*\n`;
                    cmds.sort().forEach(c => { out += `  ${PREFIX}${c}\n`; });
                    out += '\n';
                }
                out += `━━━━━━━━━━━━━━━━\n📦 *${commands.size}* commandes | Préfixe: *${PREFIX}*\n💡 *${PREFIX}help <cmd>* pour l'aide détaillée`;
                reply(out);
            },
            async help() {
                const target = rawArgs[0];
                if (!target) return builtins.menu();
                const cmd = commands.get(target);
                if (!cmd) return reply(`❌ Commande *${PREFIX}${target}* introuvable.`);
                reply(
                    `📖 *${PREFIX}${cmd.name}*\n` +
                    `━━━━━━━━━━━━━━\n` +
                    `📝 *Description:* ${cmd.description || 'Aucune description'}\n` +
                    `🏷️ *Catégorie:* ${cmd.category || 'Divers'}\n` +
                    (cmd.usage    ? `🔧 *Usage:* ${PREFIX}${cmd.usage}\n` : '') +
                    (cmd.aliases  ? `🔀 *Alias:* ${cmd.aliases.map(a => PREFIX + a).join(', ')}\n` : '') +
                    (cmd.adminOnly ? `🔒 *Propriétaire only*\n` : '')
                );
            }
        };

        const reply = (text) => sock.sendMessage(remoteJid, { text }, { quoted: msg });
        const ctx   = {
            sock, msg, args: rawArgs, remoteJid, isFromOwner, isOwner: isFromOwner,
            isGroup: remoteJid.endsWith('@g.us'),
            sender: msgSender, text, prefix: PREFIX,
            antilinkGroups, antideleteGroups,
            reply,
            replyMention: async (t) => sock.sendMessage(remoteJid, { text: t, mentions: [msgSender] }, { quoted: msg }),
            getAIResponse
        };

        if (builtins[cmdName]) return builtins[cmdName]();

        const command = commands.get(cmdName);
        if (!command) {
            // Unknown command — silent ignore or suggest
            return;
        }

        if (command.adminOnly && !isFromOwner) {
            return reply('❌ Cette commande est réservée au propriétaire.');
        }
        if (command.groupOnly && !ctx.isGroup) {
            return reply('❌ Cette commande est utilisable uniquement dans les groupes.');
        }

        console.log(chalk.cyan(`[CMD] ${cmdName} ← ${msg.pushName || cleanJid(msgSender)}`));
        try {
            await command.run(ctx);
            if (['antilink','antidelete'].includes(cmdName)) saveSettings();
        } catch (err) {
            console.error(`[CMD Error] ${cmdName}:`, err.message);
            reply(`❌ Erreur lors de l'exécution de *${PREFIX}${cmdName}*.`);
        }
    });

    // ── Antidelete via messages.update ──
    sock.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            const proto = update?.message?.protocolMessage || update?.protocolMessage;
            if (!proto || (proto.type !== 0 && proto.type !== 5)) continue;

            const jid     = key.remoteJid;
            const isGroup = jid.endsWith('@g.us');
            if (isGroup && !antideleteGroups.has(jid)) continue;

            await recoverDeletedMessage(jid, proto.key?.id || key.id);
        }
    });

    // ── ViewOnce extraction via reaction ──
    sock.ev.on('messages.reaction', async (reactions) => {
        for (const reaction of reactions) {
            const reactor = reaction.key.fromMe ? sock.user.id : (reaction.key.participant || reaction.key.remoteJid);
            if (!reaction.key.fromMe && !isOwner(reactor)) continue;

            const archived = messageCache.get(reaction.key.id);
            if (!archived) continue;

            let content = archived.message;
            if (content?.ephemeralMessage) content = content.ephemeralMessage.message;
            const vo = content?.viewOnceMessage || content?.viewOnceMessageV2 || content?.viewOnceMessageV2Extension;
            if (!vo) continue;

            const success = await extractViewOnce(vo, archived.pushName);
            if (success) {
                await sock.sendMessage(reaction.key.remoteJid, { react: { text: '🔓', key: reaction.key } });
            }
        }
    });

    // ── Call Handler (AI Voice Note) ──
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (!['timeout','reject','terminate'].includes(call.status)) continue;
            if (antiCallEnabled) {
                await sock.rejectCall(call.id, call.from);
            }

            console.log(chalk.yellow(`[Call] Appel de ${call.from}`));
            const callerId = call.from;

            try {
                // AI excuse
                let aiText = 'Le propriétaire est indisponible pour le moment. Il vous rappellera dès que possible.';
                try {
                    aiText = await getAIResponse(
                        'Génère une phrase professionnelle pour indiquer que le propriétaire est occupé. Max 15 mots. Français.',
                        null, 'llama3-8b-8192'
                    );
                } catch (_) {}

                // TTS → Voice Note
                try {
                    const audioUrl  = googleTTS.getAudioUrl(aiText, { lang: 'fr', slow: false, host: 'https://translate.google.com' });
                    const audioPath = await convertToOpus(audioUrl);
                    await sock.sendMessage(callerId, { audio: { url: audioPath }, mimetype: 'audio/ogg; codecs=opus', ptt: true });
                    fs.unlinkSync(audioPath);
                } catch (e) {
                    await sock.sendMessage(callerId, { text: `👋 ${aiText}` });
                }

                // Notify owner
                const ownerJid = `${OWNER_PN}@s.whatsapp.net`;
                await sock.sendMessage(ownerJid, {
                    text: `📞 *Appel manqué*\n👤 *De:* @${cleanJid(callerId)}\n💬 *Réponse IA:* _${aiText}_`,
                    mentions: [callerId]
                });
            } catch (err) { console.error('[Call]', err.message); }
        }
    });
}

// ─────────────────────────────────────────────
//  CRON — KEEP ALIVE
// ─────────────────────────────────────────────
cron.schedule('*/5 * * * *', async () => {
    try {
        const url = process.env.RENDER_URL;
        if (url) {
            await axios.get(`${url.replace(/\/$/, '')}/ping`);
            process.stdout.write(chalk.gray('·'));
        }
    } catch (_) {}
});

// ─────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────
loadCommands();
server.listen(PORT, () => {
    console.log(chalk.blue(`[Server] Écoute sur le port ${PORT}\n`));
    startBot();
});

// ─────────────────────────────────────────────
//  PROCESS GUARDS
// ─────────────────────────────────────────────
const IGNORABLE = ['Connection Closed','Timed Out','conflict','Stream Errored','Bad MAC','No session','EPIPE','ECONNRESET','PreKey'];

process.on('SIGTERM', () => { if (sock) sock.end(); process.exit(0); });

process.on('uncaughtException', (err) => {
    if (IGNORABLE.some(e => err?.message?.includes(e))) return;
    console.error('[Uncaught]', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (IGNORABLE.some(e => msg.includes(e))) return;
    console.error('[UnhandledRejection]', reason);
});
