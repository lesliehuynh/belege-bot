require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');
const axios = require('axios');

// ===== Setup =====
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DATABASE_ID;

// State maps
const pendingReceipts = new Map();   // chatId -> { data, fileLink, statusMsgId }
const conversations = new Map();      // chatId -> { step, data } cho flow /new

// ===== Helpers =====
function categoryKeyboard() {
  return {
    inline_keyboard: [[
      { text: '🏠 Haus', callback_data: 'cat:Haus' },
      { text: '📦 Sonstiges', callback_data: 'cat:Sonstiges' },
      { text: '❌ Cancel', callback_data: 'cat:cancel' }
    ]]
  };
}

function formatSummary(data, prefix = '📋 Tóm tắt') {
  return `${prefix}:\n` +
    `🏪 ${data.haendler}\n` +
    `💶 ${data.betrag}€` + (data.mwst ? ` (MwSt: ${data.mwst}€)` : '') + `\n` +
    `📅 ${data.datum}\n` +
    `📝 ${data.notiz || ''}\n\n` +
    `Loại nào?`;
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// ===== /start =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `Hallo! 📸 Quản lý chi tiêu của bạn:\n\n` +
    `📷 Gửi ảnh hoá đơn → tự động extract\n` +
    `⚡ /add <số> <händler> [notiz] → nhập nhanh\n` +
    `📝 /new → nhập từng bước (cho ngày tuỳ chỉnh)\n` +
    `❌ /cancel → huỷ flow đang dở`
  );
});

// ===== /cancel =====
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  const had = conversations.delete(chatId) || pendingReceipts.delete(chatId);
  bot.sendMessage(chatId, had ? '❌ Đã huỷ' : 'Không có gì để huỷ');
});

// ===== Xử lý ảnh hoá đơn =====
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const statusMsg = await bot.sendMessage(chatId, '🔍 Đang đọc hoá đơn...');

  try {
    // 1. Lấy ảnh chất lượng cao nhất
    const photo = msg.photo[msg.photo.length - 1];
    const fileLink = await bot.getFileLink(photo.file_id);

    // 2. Download ảnh thành base64
    const imgResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const base64Image = Buffer.from(imgResponse.data).toString('base64');

    // 3. Gọi Claude Vision
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image }
          },
          {
            type: 'text',
            text: `Đây là một hoá đơn của Đức. Hãy extract thông tin sau và TRẢ VỀ DUY NHẤT một JSON object, không có text khác, không có markdown fence:

{
  "haendler": "tên cửa hàng",
  "betrag": số tiền tổng (number, dùng dấu chấm thập phân),
  "mwst": tổng VAT (number, null nếu không có),
  "datum": "YYYY-MM-DD",
  "notiz": "mô tả ngắn các sản phẩm chính, tối đa 100 ký tự"
}

Nếu không đọc được field nào, dùng null.`
          }
        ]
      }]
    });

    // 4. Parse JSON
    const text = result.content[0].text.trim();
    const cleanText = text.replace(/```json\n?|```/g, '').trim();
    const data = JSON.parse(cleanText);

    // 5. Lưu pending, hỏi Kategorie
    pendingReceipts.set(chatId, { data, fileLink, statusMsgId: statusMsg.message_id });

    await bot.editMessageText(
      `✅ Đọc xong:\n\n` +
      `🏪 ${data.haendler}\n` +
      `💶 ${data.betrag}€ (MwSt: ${data.mwst || 'N/A'}€)\n` +
      `📅 ${data.datum}\n` +
      `📝 ${data.notiz || ''}\n\n` +
      `Loại nào?`,
      {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        reply_markup: categoryKeyboard()
      }
    );
  } catch (err) {
    console.error('Photo error:', err);
    bot.editMessageText(`❌ Lỗi: ${err.message}`, {
      chat_id: chatId,
      message_id: statusMsg.message_id
    });
  }
});

// ===== /add — nhập nhanh một dòng =====
bot.onText(/\/add (\S+)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const betrag = parseFloat(match[1].replace(',', '.'));
  const rest = match[2].trim();

  if (isNaN(betrag)) {
    return bot.sendMessage(chatId, '❌ Số tiền không hợp lệ. VD: /add 12.50 Rewe');
  }

  // Tách händler và notiz
  // Nếu có dấu | thì split theo |
  // Nếu không, từ đầu là händler, phần còn lại là notiz
  let haendler, notiz;
  if (rest.includes('|')) {
    [haendler, notiz] = rest.split('|').map(s => s.trim());
  } else {
    const parts = rest.split(' ');
    haendler = parts[0];
    notiz = parts.slice(1).join(' ') || null;
  }

  const data = {
    haendler,
    betrag,
    mwst: null,
    datum: todayISO(),
    notiz
  };

  const statusMsg = await bot.sendMessage(
    chatId,
    formatSummary(data, '📝 Manuell'),
    { reply_markup: categoryKeyboard() }
  );

  pendingReceipts.set(chatId, {
    data,
    fileLink: null,
    statusMsgId: statusMsg.message_id
  });
});

// ===== /new — flow từng bước =====
bot.onText(/\/new/, (msg) => {
  const chatId = msg.chat.id;
  conversations.set(chatId, { step: 'betrag', data: {} });
  bot.sendMessage(chatId, '💶 Số tiền? (vd: 23.50)\nGõ /cancel để huỷ');
});

// ===== Handler text chung cho flow /new =====
// QUAN TRỌNG: đặt SAU tất cả bot.onText khác
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Bỏ qua nếu không phải text hoặc là command
  if (!text || text.startsWith('/')) return;

  const conv = conversations.get(chatId);
  if (!conv) return;

  // Step: betrag
  if (conv.step === 'betrag') {
    const betrag = parseFloat(text.replace(',', '.'));
    if (isNaN(betrag)) {
      return bot.sendMessage(chatId, '❌ Số không hợp lệ, thử lại');
    }
    conv.data.betrag = betrag;
    conv.step = 'haendler';
    return bot.sendMessage(chatId, '🏪 Händler?');
  }

  // Step: haendler
  if (conv.step === 'haendler') {
    conv.data.haendler = text;
    conv.step = 'datum';
    return bot.sendMessage(chatId, '📅 Ngày? (YYYY-MM-DD, hoặc "today", "yesterday")');
  }

  // Step: datum
  if (conv.step === 'datum') {
    let datum;
    const lower = text.toLowerCase();
    const d = new Date();
    if (lower === 'today') {
      datum = todayISO();
    } else if (lower === 'yesterday') {
      d.setDate(d.getDate() - 1);
      datum = d.toISOString().split('T')[0];
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      datum = text;
    } else {
      return bot.sendMessage(chatId, '❌ Format không đúng. VD: 2026-04-15, today, yesterday');
    }
    conv.data.datum = datum;
    conv.step = 'notiz';
    return bot.sendMessage(chatId, '📝 Ghi chú? (gõ "-" để bỏ qua)');
  }

  // Step: notiz → hoàn tất, chuyển sang chọn Kategorie
  if (conv.step === 'notiz') {
    conv.data.notiz = text === '-' ? null : text;
    conv.data.mwst = null;

    const statusMsg = await bot.sendMessage(
      chatId,
      formatSummary(conv.data),
      { reply_markup: categoryKeyboard() }
    );

    pendingReceipts.set(chatId, {
      data: conv.data,
      fileLink: null,
      statusMsgId: statusMsg.message_id
    });
    conversations.delete(chatId);
  }
});

// ===== Xử lý chọn Kategorie (chung cho cả 3 flow) =====
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const [action, value] = query.data.split(':');

  if (action !== 'cat') return;

  const pending = pendingReceipts.get(chatId);
  if (!pending) {
    return bot.answerCallbackQuery(query.id, { text: 'Đã hết hạn' });
  }

  // Cancel
  if (value === 'cancel') {
    pendingReceipts.delete(chatId);
    bot.answerCallbackQuery(query.id);
    return bot.editMessageText('❌ Đã huỷ', {
      chat_id: chatId,
      message_id: pending.statusMsgId
    });
  }

  // Save vào Notion
  try {
    const { data, fileLink } = pending;

    const properties = {
      'Händler': { title: [{ text: { content: data.haendler || 'Unbekannt' } }] },
      'Betrag': { number: data.betrag },
      'MwSt': { number: data.mwst },
      'Datum': data.datum ? { date: { start: data.datum } } : { date: null },
      'Kategorie': { select: { name: value } },
      'Notiz': { rich_text: [{ text: { content: data.notiz || '' } }] }
    };

    if (fileLink) {
      properties['Beleg'] = {
        files: [{
          name: `beleg-${Date.now()}.jpg`,
          external: { url: fileLink }
        }]
      };
    }

    await notion.pages.create({
      parent: { database_id: DB_ID },
      properties
    });

    pendingReceipts.delete(chatId);
    bot.answerCallbackQuery(query.id, { text: '✅ Saved!' });
    bot.editMessageText(
      `✅ Đã lưu vào Notion!\n${data.betrag}€ - ${data.haendler} [${value}]`,
      { chat_id: chatId, message_id: pending.statusMsgId }
    );
  } catch (err) {
    console.error('Notion error:', err);
    bot.answerCallbackQuery(query.id, { text: '❌ Lỗi' });
    bot.editMessageText(`❌ Lỗi lưu Notion: ${err.message}`, {
      chat_id: chatId,
      message_id: pending.statusMsgId
    });
  }
});

// ===== Error handlers =====
bot.on('polling_error', (err) => console.error('Polling error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

console.log('🤖 Bot is running...');