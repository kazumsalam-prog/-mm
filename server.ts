import express from 'express';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';

const STATE_FILE = path.resolve(process.cwd(), 'station_live_state.json');

export interface NativeAppOrderLog {
  id: number;
  direction: 'incoming' | 'outgoing'; // incoming = استلام طلب من C#/C++, outgoing = إرسال طلب إلى C#/C++
  appType: 'C#' | 'C++' | 'API';
  subscriberName: string;
  tankNumber: string;
  phone: string;
  area: string;
  driverName: string;
  price: number;
  timestamp: string;
  status: string;
}

interface SharedStationState {
  subscribers: any[];
  waitingOrders: any[];
  dailyFillings: any[];
  transactions: any[];
  driverPhones: Record<string, string>;
  driverEvents: Array<{
    id: number;
    timestamp: string;
    type: 'location_pinned' | 'filling_completed' | 'csharp_cpp_order_received' | 'csharp_cpp_order_sent';
    driverName: string;
    subscriberName: string;
    tankNumber: string;
    amount?: number;
    locationUrl?: string;
    sourceApp?: string;
  }>;
  outgoingOrdersForNativeApp: any[];
  csharpCppLogs: NativeAppOrderLog[];
  version: number;
}

let sharedState: SharedStationState = {
  subscribers: [],
  waitingOrders: [],
  dailyFillings: [],
  transactions: [],
  driverPhones: {},
  driverEvents: [],
  outgoingOrdersForNativeApp: [],
  csharpCppLogs: [],
  version: 100,
};

// Load saved state from disk if available
try {
  if (fs.existsSync(STATE_FILE)) {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      sharedState = {
        ...sharedState,
        ...parsed,
        outgoingOrdersForNativeApp: Array.isArray(parsed.outgoingOrdersForNativeApp)
          ? parsed.outgoingOrdersForNativeApp
          : [],
        csharpCppLogs: Array.isArray(parsed.csharpCppLogs)
          ? parsed.csharpCppLogs
          : [],
      };
    }
  }
} catch {
  // ignore initial read errors
}

function saveStateToDisk() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(sharedState, null, 2), 'utf-8');
  } catch {
    // ignore write errors
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Enable CORS so C# (HttpClient/WebClient) and C++ (WinHTTP/WinSock) apps can connect from any machine
  app.use('/api', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Source-App');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // 1. GET /api/sync — Computer, Driver's Phone, and C#/C++ apps poll this to stay 100% synchronized
  app.get('/api/sync', (_req, res) => {
    res.json(sharedState);
  });

  // 2. POST /api/sync — Computer pushes its state (supports empty arrays when zeroed out)
  app.post('/api/sync', (req, res) => {
    const {
      subscribers,
      waitingOrders,
      dailyFillings,
      transactions,
      driverPhones,
    } = req.body || {};

    if (Array.isArray(subscribers)) {
      const serverLocMap = new Map<string, any>();
      sharedState.subscribers.forEach((s) => {
        if (s.locationUrl || (s.latitude && s.longitude)) {
          serverLocMap.set(`${s.id}_${s.fullName}`, {
            locationUrl: s.locationUrl,
            latitude: s.latitude,
            longitude: s.longitude,
            locationPinnedAt: s.locationPinnedAt,
          });
        }
      });

      sharedState.subscribers = subscribers.map((sub: any) => {
        const savedLoc = serverLocMap.get(`${sub.id}_${sub.fullName}`);
        if (savedLoc && !sub.locationUrl) {
          return { ...sub, ...savedLoc };
        }
        return sub;
      });
    }

    if (Array.isArray(waitingOrders)) {
      sharedState.waitingOrders = waitingOrders;
    }
    if (Array.isArray(dailyFillings)) {
      sharedState.dailyFillings = dailyFillings;
    }
    if (Array.isArray(transactions)) {
      sharedState.transactions = transactions;
    }
    if (driverPhones && typeof driverPhones === 'object') {
      sharedState.driverPhones = driverPhones;
    }

    sharedState.version += 1;
    saveStateToDisk();
    res.json({ ok: true, state: sharedState });
  });

  // 3. POST /api/reset-all — Zero out all system data completely (تصفير كافة البيانات)
  app.post('/api/reset-all', (_req, res) => {
    sharedState = {
      subscribers: [],
      waitingOrders: [],
      dailyFillings: [],
      transactions: [],
      driverPhones: {},
      driverEvents: [],
      outgoingOrdersForNativeApp: [],
      csharpCppLogs: [],
      version: sharedState.version + 1,
    };
    saveStateToDisk();
    res.json({ ok: true, message: 'تم تصفير كافة البيانات بنجاح', state: sharedState });
  });

  // 4. POST /api/csharp-cpp/receive-order — System ACCEPTS an order from a C# or C++ application (يتقبل طلبات)
  app.post('/api/csharp-cpp/receive-order', (req, res) => {
    const body = req.body || {};
    const subscriberName = String(body.subscriberName || body.fullName || body.name || '').trim();
    const tankNumber = String(body.tankNumber || body.serial || '0').trim();
    const phone = String(body.phone || '').trim();
    const area = String(body.area || 'عام').trim();
    const landmark = String(body.landmark || '').trim();
    const driverName = String(body.driverName || 'سائق عام').trim();
    const price = Number(body.price || body.amount) || 10000;
    const appType: 'C#' | 'C++' | 'API' =
      body.appType === 'C++' ? 'C++' : body.appType === 'C#' ? 'C#' : 'C#';

    if (!subscriberName) {
      return res.status(400).json({
        ok: false,
        error: 'يرجى إرسال اسم المشترك (subscriberName)',
      });
    }

    const now = new Date();
    const dateStr =
      body.requestDate ||
      `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const timeStr = body.requestTime || now.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });

    // Check if subscriber exists; if not, create them automatically so everything stays linked
    let matchedSub = sharedState.subscribers.find(
      (s: any) =>
        (s.fullName && s.fullName.trim() === subscriberName) ||
        (tankNumber && tankNumber !== '0' && String(s.tankNumber).trim() === tankNumber)
    );

    if (!matchedSub) {
      const nextSubId =
        sharedState.subscribers.length > 0
          ? Math.max(...sharedState.subscribers.map((s: any) => Number(s.id) || 0)) + 1
          : 1;
      matchedSub = {
        id: nextSubId,
        fullName: subscriberName,
        phone,
        date: dateStr,
        area,
        direction: 'الوسط',
        size: String(body.size || '500'),
        tankNumber: tankNumber || String(nextSubId),
        serial: Number(tankNumber) || nextSubId,
        note: `تمت إضافته عبر تطبيق ${appType}`,
        landmark,
        lastDriverName: driverName,
      };
      sharedState.subscribers.push(matchedSub);
    }

    const nextWaitId =
      sharedState.waitingOrders.length > 0
        ? Math.max(...sharedState.waitingOrders.map((w: any) => Number(w.id) || 0)) + 1
        : 1;

    const newWaitingOrder = {
      id: nextWaitId,
      selected: false,
      subscriberId: matchedSub.id,
      subscriberName,
      phone: phone || matchedSub.phone || '',
      landmark: landmark || matchedSub.landmark || '',
      area: area || matchedSub.area || '',
      direction: matchedSub.direction || 'الوسط',
      size: matchedSub.size || '500',
      note: `طلب وارد من تطبيق ${appType}`,
      requestDate: dateStr,
      requestTime: timeStr,
      lastFillingDate: matchedSub.lastFillingDate || dateStr,
      tankNumber: tankNumber || matchedSub.tankNumber || String(nextWaitId),
      driverName,
      sentToDriver: false,
      price,
    };

    sharedState.waitingOrders = [newWaitingOrder, ...sharedState.waitingOrders];

    const logItem: NativeAppOrderLog = {
      id: Date.now(),
      direction: 'incoming',
      appType,
      subscriberName,
      tankNumber: newWaitingOrder.tankNumber,
      phone: newWaitingOrder.phone,
      area: newWaitingOrder.area,
      driverName,
      price,
      timestamp: `${dateStr} - ${timeStr}`,
      status: `تم استلام الطلب من تطبيق ${appType} وإدراجه في قائمة المنتظرين`,
    };
    sharedState.csharpCppLogs = [logItem, ...sharedState.csharpCppLogs.slice(0, 99)];

    sharedState.driverEvents = [
      {
        id: Date.now(),
        timestamp: timeStr,
        type: 'csharp_cpp_order_received',
        driverName,
        subscriberName,
        tankNumber: newWaitingOrder.tankNumber,
        amount: price,
        sourceApp: appType,
      },
      ...sharedState.driverEvents.slice(0, 19),
    ];

    sharedState.version += 1;
    saveStateToDisk();

    return res.json({
      ok: true,
      message: `تم استلام الطلب من تطبيق ${appType} بنجاح وإضافته إلى قائمة المنتظرين`,
      order: newWaitingOrder,
      log: logItem,
      state: sharedState,
    });
  });

  // 5. POST /api/csharp-cpp/send-order — System SENDS an order to a C# or C++ application (يدز طلبات)
  app.post('/api/csharp-cpp/send-order', async (req, res) => {
    const body = req.body || {};
    const subscriberName = String(body.subscriberName || '').trim();
    const tankNumber = String(body.tankNumber || '0').trim();
    const phone = String(body.phone || '').trim();
    const area = String(body.area || '').trim();
    const landmark = String(body.landmark || '').trim();
    const driverName = String(body.driverName || '').trim();
    const price = Number(body.price) || 10000;
    const appType: 'C#' | 'C++' | 'API' =
      body.appType === 'C++' ? 'C++' : body.appType === 'C#' ? 'C#' : 'C#';
    const targetEndpoint = String(body.targetEndpoint || '').trim();

    if (!subscriberName) {
      return res.status(400).json({
        ok: false,
        error: 'يرجى تحديد اسم المشترك لإرسال الطلب',
      });
    }

    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const timeStr = now.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });

    const outgoingOrder = {
      id: Date.now(),
      subscriberName,
      tankNumber,
      phone,
      area,
      landmark,
      driverName,
      price,
      targetApp: appType,
      sentAt: `${dateStr} ${timeStr}`,
      deliveredToNativeApp: false,
    };

    sharedState.outgoingOrdersForNativeApp = [
      outgoingOrder,
      ...sharedState.outgoingOrdersForNativeApp.slice(0, 99),
    ];

    let webhookStatus = `جاهز للسحب الفوري في تطبيق ${appType} عبر البوابة`;

    // If user specified a direct local/network C# or C++ listener endpoint (e.g., http://127.0.0.1:5050/order)
    if (targetEndpoint && (targetEndpoint.startsWith('http://') || targetEndpoint.startsWith('https://'))) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const webhookRes = await fetch(targetEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(outgoingOrder),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (webhookRes.ok) {
          outgoingOrder.deliveredToNativeApp = true;
          webhookStatus = `تم الإرسال المباشر إلى خادم ${appType} (${targetEndpoint}) بنجاح ✔`;
        } else {
          webhookStatus = `تم الحفظ في طابور الإرسال لتطبيق ${appType} (كود الاستجابة: ${webhookRes.status})`;
        }
      } catch {
        webhookStatus = `تم الحفظ في طابور الإرسال الفوري لتطبيق ${appType} (سيتم استلامه فور اتصال التطبيق)`;
      }
    }

    const logItem: NativeAppOrderLog = {
      id: Date.now() + 1,
      direction: 'outgoing',
      appType,
      subscriberName,
      tankNumber,
      phone,
      area,
      driverName,
      price,
      timestamp: `${dateStr} - ${timeStr}`,
      status: webhookStatus,
    };

    sharedState.csharpCppLogs = [logItem, ...sharedState.csharpCppLogs.slice(0, 99)];

    sharedState.driverEvents = [
      {
        id: Date.now() + 2,
        timestamp: timeStr,
        type: 'csharp_cpp_order_sent',
        driverName,
        subscriberName,
        tankNumber,
        amount: price,
        sourceApp: appType,
      },
      ...sharedState.driverEvents.slice(0, 19),
    ];

    sharedState.version += 1;
    saveStateToDisk();

    return res.json({
      ok: true,
      message: webhookStatus,
      order: outgoingOrder,
      log: logItem,
      state: sharedState,
    });
  });

  // 6. GET /api/csharp-cpp/pending-orders — C# and C++ apps call this to fetch outgoing orders & current waiting queue
  app.get('/api/csharp-cpp/pending-orders', (_req, res) => {
    res.json({
      ok: true,
      outgoingOrders: sharedState.outgoingOrdersForNativeApp,
      waitingOrders: sharedState.waitingOrders,
      subscribersCount: sharedState.subscribers.length,
      dailyFillingsCount: sharedState.dailyFillings.length,
      logs: sharedState.csharpCppLogs,
      version: sharedState.version,
    });
  });

  // 7. POST /api/csharp-cpp/clear-logs — Clear order logs
  app.post('/api/csharp-cpp/clear-logs', (_req, res) => {
    sharedState.csharpCppLogs = [];
    sharedState.outgoingOrdersForNativeApp = [];
    sharedState.version += 1;
    saveStateToDisk();
    res.json({ ok: true, state: sharedState });
  });

  // 8. POST /api/driver-action — Driver's Phone pins location or completes filling
  app.post('/api/driver-action', (req, res) => {
    const {
      action,
      order,
      latitude,
      longitude,
      locationUrl,
      price,
      dateStr,
      timeStr,
    } = req.body || {};

    if (action === 'PIN_LOCATION' && order) {
      const pinnedDate = dateStr || new Date().toLocaleDateString('en-GB');

      sharedState.subscribers = sharedState.subscribers.map((s: any) => {
        const isMatch =
          (order.subscriberId && s.id === order.subscriberId) ||
          (s.fullName &&
            order.subscriberName &&
            s.fullName.trim() === order.subscriberName.trim()) ||
          (order.tankNumber &&
            s.tankNumber &&
            String(s.tankNumber).trim() === String(order.tankNumber).trim());
        if (!isMatch) return s;
        return {
          ...s,
          latitude,
          longitude,
          locationUrl,
          locationPinnedAt: pinnedDate,
        };
      });

      sharedState.waitingOrders = sharedState.waitingOrders.map((w: any) => {
        const isSame =
          w.id === order.id ||
          (order.subscriberName &&
            w.subscriberName &&
            w.subscriberName.trim() === order.subscriberName.trim());
        if (!isSame) return w;
        return {
          ...w,
          latitude,
          longitude,
          locationUrl,
        };
      });

      sharedState.driverEvents = [
        {
          id: Date.now(),
          timestamp: timeStr || new Date().toLocaleTimeString('ar-IQ'),
          type: 'location_pinned' as const,
          driverName: order.driverName || 'السائق',
          subscriberName: order.subscriberName,
          tankNumber: order.tankNumber || '0',
          locationUrl,
        },
        ...sharedState.driverEvents.slice(0, 19),
      ];

      sharedState.version += 1;
      saveStateToDisk();
      return res.json({ ok: true, state: sharedState });
    }

    if (action === 'COMPLETE_FILLING' && order) {
      const finalAmount = Number(price) || 10000;
      const fillDate = order.requestDate || dateStr || '01/10/2026';

      const nextDailyId =
        sharedState.dailyFillings.length > 0
          ? Math.max(...sharedState.dailyFillings.map((d: any) => Number(d.id) || 0)) + 1
          : 1;

      const newDailyRow = {
        id: nextDailyId,
        serial: parseInt(order.tankNumber, 10) || 1000 + nextDailyId,
        customerName: order.subscriberName,
        date: fillDate,
        driverName: order.driverName || '',
        amount: finalAmount,
      };
      sharedState.dailyFillings = [newDailyRow, ...sharedState.dailyFillings];

      const nextTxId =
        sharedState.transactions.length > 0
          ? Math.max(...sharedState.transactions.map((t: any) => Number(t.id) || 0), 1) + 1
          : 1;

      sharedState.transactions = [
        ...sharedState.transactions,
        {
          id: nextTxId,
          type: 'قبض',
          amount: finalAmount,
          date: fillDate,
          party: 'تعبئة',
          description: `تعبئة (${order.driverName}) - خزان ${order.tankNumber}`,
          time: timeStr || '',
          username: order.driverName || '',
        },
      ];

      sharedState.subscribers = sharedState.subscribers.map((s: any) => {
        const isMatch =
          (order.subscriberId && s.id === order.subscriberId) ||
          (s.fullName &&
            order.subscriberName &&
            s.fullName.trim() === order.subscriberName.trim());
        if (!isMatch) return s;
        return {
          ...s,
          lastFillingDate: fillDate,
          lastDriverName: order.driverName || s.lastDriverName,
          locationUrl: order.locationUrl || s.locationUrl,
          latitude: order.latitude ?? s.latitude,
          longitude: order.longitude ?? s.longitude,
        };
      });

      sharedState.waitingOrders = sharedState.waitingOrders.filter(
        (w: any) => w.id !== order.id
      );

      sharedState.driverEvents = [
        {
          id: Date.now(),
          timestamp: timeStr || new Date().toLocaleTimeString('ar-IQ'),
          type: 'filling_completed' as const,
          driverName: order.driverName || 'السائق',
          subscriberName: order.subscriberName,
          tankNumber: order.tankNumber || '0',
          amount: finalAmount,
          locationUrl: order.locationUrl,
        },
        ...sharedState.driverEvents.slice(0, 19),
      ];

      sharedState.version += 1;
      saveStateToDisk();
      return res.json({ ok: true, state: sharedState });
    }

    return res.status(400).json({ ok: false, error: 'Invalid driver action' });
  });

  // Mount Vite in dev or static dist in production
  const distPath = path.resolve(process.cwd(), 'dist');
  if (process.env.NODE_ENV === 'production' && fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
