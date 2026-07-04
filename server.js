// ===== Backend للمستورد الأمين =====
// يستقبل بيانات الطلب من الفورم، يرسل حدث Purchase/Lead لفيسبوك عبر Conversions API
// (يعمل من السيرفر مباشرة، فما يتأثر بأدوات منع الإعلانات على المتصفح)
// ثم يرجع رابط واتساب جاهز للفرونت إند يفتحه عند الزبون

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ===== إعدادات من متغيرات البيئة (تضاف في Render، مو هنا بالكود) =====
const PIXEL_ID = process.env.META_PIXEL_ID || '27284272977899217';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || ''; // لازم تضاف من Render لاحقاً
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '9647812182182';
const GRAPH_API_VERSION = 'v21.0';

// ===== إعدادات جديدة خاصة بالماسنجر (تضاف بمتغيرات البيئة على Render) =====
const MESSENGER_VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || ''; // كلمة تختارها أنت
const PAGE_ID = process.env.PAGE_ID || ''; // آيدي صفحة المستورد الأمين
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // كلمة سر بسيطة لصفحة الإدارة

// ===== مخزن مؤقت بالذاكرة: يحفظ لكل زبون راسل عبر إعلان، رقم محادثته (PSID) =====
// ملاحظة: هذا يفرغ لو السيرفر أعاد التشغيل (نادر الحدوث على Render). لاحقاً ممكن يتحول لقاعدة بيانات حقيقية.
const messengerContacts = {}; // { psid: { referral, firstSeen } }

// ===== سجل آخر Webhooks للتشخيص =====
const webhookDebug = [];

// ===== دالة هاش SHA256 (فيسبوك يطلب البيانات الشخصية مشفرة) =====
function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

// ===== توليد رقم طلب فريد =====
let orderCounter = 1001;
function generateOrderNumber() {
  return orderCounter++;
}

// ===== Health check (للتأكد إن السيرفر شغال) =====
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'المستورد الأمين - Backend شغال ✅' });
});

// ===== Endpoint الرئيسي: استقبال الطلب =====
app.post('/api/order', async (req, res) => {
  try {
    const { name, phone, phone2, city, area, qty, notes, withUpsell, totalPrice, eventSourceUrl, fbp, fbc, eventId } = req.body;

    // تحقق أساسي من البيانات
    if (!name || !phone || !city || !area) {
      return res.status(400).json({ error: 'البيانات ناقصة' });
    }

    const orderNum = generateOrderNumber();

    // ===== بناء رسالة واتساب (نفس منطق الفرونت إند القديم) =====
    const upsellText = withUpsell ? '\n➕ إضافة: سبورة ناطقة تفاعلية - 3,000 دينار' : '';
    const phone2Line = phone2 ? `\n📞 هاتف ثاني: ${phone2}` : '';
    const notesLine = notes ? `\n📝 ملاحظة التوصيل: ${notes}` : '';
    const msg = `🧾 طلب رقم: #${orderNum}
━━━━━━━━━━━━━━━━━━
مرحباً، أريد حجز بكج حسين التعليمي 📚

👤 الاسم: ${name}
📞 الهاتف: ${phone}${phone2Line}
📍 المحافظة: ${city}
📌 المنطقة: ${area}
📦 الكمية: ${qty} بكج${upsellText}
💰 المجموع: ${Number(totalPrice).toLocaleString()} دينار${notesLine}

⏰ طلب خلال عرض الـ 72 ساعة ✅`;

    const whatsappUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;

    // ===== إرسال حدث Purchase لفيسبوك عبر Conversions API (Server-Side) =====
    let fbResult = null;
    if (ACCESS_TOKEN) {
      try {
        const nameParts = name.trim().split(/\s+/);
        const firstName = nameParts[0] || name;
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;

        const eventData = {
          data: [
            {
              event_name: 'Purchase',
              event_time: Math.floor(Date.now() / 1000),
              event_id: eventId || undefined, // لمنع تكرار احتساب نفس الحدث مع نسخة المتصفح (Pixel)
              event_source_url: eventSourceUrl || 'https://al-ameen-iq.com',
              action_source: 'website',
              user_data: {
                ph: [sha256(phone)],
                fn: [sha256(firstName)],
                ln: lastName ? [sha256(lastName)] : undefined,
                ct: area ? [sha256(area)] : undefined, // المنطقة/الحي - تحسين دقة المطابقة
                st: city ? [sha256(city)] : undefined, // المحافظة - تحسين دقة المطابقة
                country: [sha256('iq')],
                client_ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
                client_user_agent: req.headers['user-agent'],
                fbp: fbp || undefined,
                fbc: fbc || undefined,
              },
              custom_data: {
                currency: 'IQD',
                value: Number(totalPrice) || 0,
                content_name: 'بكج حسين التعليمي',
                content_type: 'product',
                content_ids: ['baqij-hussein'],
                contents: [{ id: 'baqij-hussein', quantity: Number(qty) || 1 }],
                num_items: Number(qty) || 1,
              },
            },
          ],
        };

        const fbResponse = await fetch(
          `https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(eventData),
          }
        );
        fbResult = await fbResponse.json();
        console.log('Facebook CAPI response:', fbResult);
      } catch (fbError) {
        console.error('خطأ في إرسال الحدث لفيسبوك:', fbError.message);
        // ما نوقف الطلب حتى لو فشل إرسال فيسبوك - الزبون أهم
      }
    } else {
      console.log('⚠️ META_ACCESS_TOKEN غير مضاف بعد - تخطي إرسال فيسبوك');
    }

    // ===== الرد للفرونت إند =====
    res.json({
      success: true,
      orderNumber: orderNum,
      whatsappUrl: whatsappUrl,
      fbTracked: !!ACCESS_TOKEN,
      fbResult: fbResult,
    });
  } catch (error) {
    console.error('خطأ في معالجة الطلب:', error);
    res.status(500).json({ error: 'حدث خطأ في الخادم، حاول مرة أخرى' });
  }
});

// ===== Endpoint لتتبع InitiateCheckout (لما يضغط الزبون "احجز الآن") =====
app.post('/api/track-checkout', async (req, res) => {
  try {
    const { totalPrice, eventSourceUrl, fbp, fbc, eventId } = req.body;

    if (ACCESS_TOKEN) {
      const eventData = {
        data: [
          {
            event_name: 'InitiateCheckout',
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId || undefined,
            event_source_url: eventSourceUrl || 'https://al-ameen-iq.com',
            action_source: 'website',
            user_data: {
              client_ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
              client_user_agent: req.headers['user-agent'],
              fbp: fbp || undefined,
              fbc: fbc || undefined,
            },
            custom_data: {
              currency: 'IQD',
              value: Number(totalPrice) || 0,
              content_type: 'product',
              content_ids: ['baqij-hussein'],
            },
          },
        ],
      };

      const fbResponse = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventData),
        }
      );
      const result = await fbResponse.json();
      return res.json({ success: true, fbResult: result });
    }

    res.json({ success: true, fbTracked: false });
  } catch (error) {
    console.error('خطأ في تتبع checkout:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// ===== Endpoint لتتبع نقرات أزرار التواصل المباشر (واتساب/ماسنجر) =====
// هذا حدث مخصص (Custom Event) يفيد ببناء جمهور "أظهر نية تواصل" لإعادة الاستهداف
app.post('/api/track-contact', async (req, res) => {
  try {
    const { type, eventSourceUrl, fbp, fbc, eventId } = req.body;
    const eventName = type === 'whatsapp' ? 'ContactWhatsApp'
      : type === 'messenger' ? 'ContactMessenger'
      : 'BookingIntent'; // type === 'website'

    if (ACCESS_TOKEN) {
      const eventData = {
        data: [
          {
            event_name: eventName,
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId || undefined,
            event_source_url: eventSourceUrl || 'https://al-ameen-iq.com',
            action_source: 'website',
            user_data: {
              client_ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
              client_user_agent: req.headers['user-agent'],
              fbp: fbp || undefined,
              fbc: fbc || undefined,
            },
            custom_data: {
              content_name: 'بكج حسين التعليمي',
            },
          },
        ],
      };

      const fbResponse = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventData),
        }
      );
      const result = await fbResponse.json();
      return res.json({ success: true, fbResult: result });
    }

    res.json({ success: true, fbTracked: false });
  } catch (error) {
    console.error('خطأ في تتبع نقرة التواصل:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// ===== Endpoint لتتبع ViewContent (لما الزائر يفتح الصفحة) =====
app.post('/api/track-view', async (req, res) => {
  try {
    const { eventSourceUrl, fbp, fbc, eventId } = req.body;

    if (ACCESS_TOKEN) {
      const eventData = {
        data: [
          {
            event_name: 'ViewContent',
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId || undefined,
            event_source_url: eventSourceUrl || 'https://al-ameen-iq.com',
            action_source: 'website',
            user_data: {
              client_ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
              client_user_agent: req.headers['user-agent'],
              fbp: fbp || undefined,
              fbc: fbc || undefined,
            },
            custom_data: {
              currency: 'IQD',
              value: 15000,
              content_name: 'بكج حسين التعليمي',
              content_type: 'product',
              content_ids: ['baqij-hussein'],
            },
          },
        ],
      };

      const fbResponse = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventData),
        }
      );
      const result = await fbResponse.json();
      return res.json({ success: true, fbResult: result });
    }

    res.json({ success: true, fbTracked: false });
  } catch (error) {
    console.error('خطأ في تتبع ViewContent:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// ============================================================
// ===== قسم الماسنجر: Webhook + صفحة الإدارة =====
// ============================================================

// ===== 1) تحقق فيسبوك من الرابط (يستدعى مرة وحدة لما تحفظ الإعدادات بـ Developers) =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === MESSENGER_VERIFY_TOKEN) {
    console.log('✅ تم التحقق من Webhook الماسنجر بنجاح');
    return res.status(200).send(challenge);
  }
  console.log('❌ فشل التحقق من Webhook - تأكد من تطابق Verify Token');
  res.sendStatus(403);
});

// ===== 2) استقبال رسائل الماسنجر الفعلية =====
app.post('/webhook', (req, res) => {
  webhookDebug.unshift({
    time: new Date().toISOString(),
    headers: req.headers,
    body: req.body
  });

  if (webhookDebug.length > 20) {
    webhookDebug.pop();
  }

  // سطر تشخيصي: يطبع أي طلب يوصل هنا بدون أي شرط، حتى نتأكد إن الطلب وصل فعلاً
  console.log('🔔 وصل طلب POST لـ /webhook:', JSON.stringify(req.body));

  const body = req.body || {};

  if (body.object === 'page') {
    body.entry?.forEach((entry) => {
      entry.messaging?.forEach((event) => {
        const psid = event.sender?.id;
        if (!psid) return;

        // لو الرسالة جاية من إعلان "Click to Messenger"، فيسبوك يرسل referral فيها معلومات الإعلان
        const referral = event.referral || event.postback?.referral || null;

        if (!messengerContacts[psid]) {
          messengerContacts[psid] = { referral: null, firstSeen: Date.now() };
        }
        if (referral) {
          messengerContacts[psid].referral = referral;
          console.log(`📩 زبون جديد من إعلان! PSID: ${psid}`, referral);
        } else {
          console.log(`📩 رسالة من PSID: ${psid} (بدون بيانات إعلان)`);
        }
      });
    });
    return res.status(200).send('EVENT_RECEIVED');
  }
  res.sendStatus(404);
});

// ===== 3) صفحة إدارة بسيطة (تفتحها من موبايلك لتسجيل طلبات الماسنجر) =====
app.get('/admin', (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) {
    return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:50px">🔒 الرابط يحتاج كلمة سر صحيحة (?pass=...)</h2>');
  }

  const contactsList = Object.keys(messengerContacts)
    .sort((a, b) => messengerContacts[b].firstSeen - messengerContacts[a].firstSeen)
    .slice(0, 30)
    .map((psid) => {
      const c = messengerContacts[psid];
      const hasAd = c.referral ? '✅ من إعلان' : '⚪ بدون إعلان';
      return `<option value="${psid}">${psid.slice(-6)} - ${hasAd} - ${new Date(c.firstSeen).toLocaleString('ar-IQ')}</option>`;
    })
    .join('');

  res.send(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>تسجيل طلب ماسنجر</title>
      <style>
        body { font-family: sans-serif; max-width: 480px; margin: 20px auto; padding: 16px; background:#f5f5f5; }
        h2 { text-align:center; color:#2E7D32; }
        label { display:block; margin-top:14px; font-weight:bold; }
        select, input { width:100%; padding:10px; margin-top:6px; border-radius:8px; border:1px solid #ccc; box-sizing:border-box; font-size:16px; }
        button { width:100%; padding:14px; margin-top:20px; background:#2E7D32; color:white; border:none; border-radius:8px; font-size:18px; font-weight:bold; }
        #result { margin-top:16px; padding:12px; border-radius:8px; text-align:center; font-weight:bold; }
      </style>
    </head>
    <body>
      <h2>📩 تسجيل طلب ماسنجر</h2>
      <form id="orderForm">
        <label>اختار الزبون (آخر 30 محادثة):</label>
        <select id="psid" required>
          <option value="">-- اختر --</option>
          ${contactsList}
        </select>

        <label>اسم الزبون:</label>
        <input type="text" id="name" required>

        <label>رقم الهاتف:</label>
        <input type="tel" id="phone" required>

        <label>مبلغ الطلب (دينار):</label>
        <input type="number" id="amount" value="15000" required>

        <label>الكمية:</label>
        <input type="number" id="qty" value="1" required>

        <button type="submit">✅ تسجيل الطلب وإرسال Purchase</button>
      </form>
      <div id="result"></div>

      <script>
        document.getElementById('orderForm').addEventListener('submit', async function(e) {
          e.preventDefault();
          const resultDiv = document.getElementById('result');
          resultDiv.style.background = '#eee';
          resultDiv.textContent = 'جاري الإرسال...';

          const res = await fetch('/api/messenger-order?pass=${encodeURIComponent(ADMIN_PASSWORD)}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              psid: document.getElementById('psid').value,
              name: document.getElementById('name').value,
              phone: document.getElementById('phone').value,
              amount: document.getElementById('amount').value,
              qty: document.getElementById('qty').value,
            }),
          });
          const data = await res.json();
          if (data.success) {
            resultDiv.style.background = '#c8e6c9';
            resultDiv.textContent = '✅ تم تسجيل الطلب وإرسال البيانات لفيسبوك بنجاح';
            document.getElementById('orderForm').reset();
          } else {
            resultDiv.style.background = '#ffcdd2';
            resultDiv.textContent = '❌ صار خطأ: ' + (data.error || 'غير معروف');
          }
        });
      </script>
    </body>
    </html>
  `);
});

// ===== 4) استقبال تسجيل طلب الماسنجر وإرسال Purchase دقيق لفيسبوك =====
app.post('/api/messenger-order', async (req, res) => {
  try {
    if (req.query.pass !== ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, error: 'غير مصرح' });
    }

    const { psid, name, phone, amount, qty } = req.body;
    if (!psid || !name || !phone || !amount) {
      return res.status(400).json({ success: false, error: 'البيانات ناقصة' });
    }

    let fbResult = null;
    if (ACCESS_TOKEN && PAGE_ID) {
      const eventData = {
        data: [
          {
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'business_messaging',
            messaging_channel: 'messenger',
            user_data: {
              page_id: PAGE_ID,
              page_scoped_user_id: psid, // هذا يربط الشراء بمحادثة الزبون بدقة، بدون حاجة لهاش
            },
            custom_data: {
              currency: 'IQD',
              value: Number(amount) || 0,
              content_name: 'بكج حسين التعليمي',
              content_type: 'product',
              content_ids: ['baqij-hussein'],
              num_items: Number(qty) || 1,
            },
          },
        ],
      };

      const fbResponse = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventData),
        }
      );
      fbResult = await fbResponse.json();
      console.log('Facebook Messenger CAPI response:', fbResult);
    }

    res.json({ success: true, fbResult });
  } catch (error) {
    console.error('خطأ بتسجيل طلب الماسنجر:', error);
    res.status(500).json({ success: false, error: 'حدث خطأ بالسيرفر' });
  }
});

// ===== صفحة تشخيص آخر Webhooks =====
app.get('/debug-webhook', (req, res) => {
  res.json({
    count: webhookDebug.length,
    events: webhookDebug
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر شغال على المنفذ ${PORT}`);
});
