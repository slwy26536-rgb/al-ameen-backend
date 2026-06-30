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
    const { name, phone, phone2, city, area, qty, notes, withUpsell, totalPrice, eventSourceUrl, fbp, fbc } = req.body;

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
        const eventData = {
          data: [
            {
              event_name: 'Purchase',
              event_time: Math.floor(Date.now() / 1000),
              event_source_url: eventSourceUrl || 'https://al-ameen-iq.com',
              action_source: 'website',
              user_data: {
                ph: [sha256(phone)],
                fn: [sha256(name.split(' ')[0] || name)],
                client_ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
                client_user_agent: req.headers['user-agent'],
                fbp: fbp || undefined,
                fbc: fbc || undefined,
              },
              custom_data: {
                currency: 'IQD',
                value: Number(totalPrice) || 0,
                content_name: 'بكج حسين التعليمي',
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
    const { totalPrice, eventSourceUrl, fbp, fbc } = req.body;

    if (ACCESS_TOKEN) {
      const eventData = {
        data: [
          {
            event_name: 'InitiateCheckout',
            event_time: Math.floor(Date.now() / 1000),
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر شغال على المنفذ ${PORT}`);
});
