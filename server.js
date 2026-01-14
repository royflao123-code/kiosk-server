require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

let connectedClients = 0;

io.on('connection', (socket) => {
  connectedClients++;
  console.log(`✅ אפליקציה התחברה! סה"כ מחוברים: ${connectedClients}`);

  socket.on('disconnect', () => {
    connectedClients--;
    console.log(`❌ אפליקציה התנתקה. סה"כ מחוברים: ${connectedClients}`);
  });
});

function notifyAllClients() {
  io.emit('products_updated');
  console.log(`🔔 עדכון נשלח ל-${connectedClients} מכשירים`);
}

// נתיב לקבלת רשימת תמונות זמינות
app.get('/available-images', (req, res) => {
  const imagesDir = path.join(__dirname, 'public', 'images');
  fs.readdir(imagesDir, (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'שגיאה בקריאת תמונות' });
    }
    const imageFiles = files.filter(file =>
      /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
    );
    res.json(imageFiles);
  });
});

// נתיב חדש ליצירת הזמנה במסד הנתונים
app.post('/orders', async (req, res) => {
  const { 
    customer_name, 
    customer_phone, 
    total_amount, 
    delivery_type, 
    shipping_location, 
    is_custom_location, 
    payment_method, 
    items 
  } = req.body;

  try {
    const query = `
      INSERT INTO orders (customer_name, customer_phone, total_amount, delivery_type, shipping_location, is_custom_location, payment_method, items)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;
    const values = [customer_name, customer_phone, total_amount, delivery_type, shipping_location, is_custom_location, payment_method, JSON.stringify(items)];
    
    const result = await pool.query(query, values);
    
    // שליחת עדכון בזמן אמת אם יש ממשק ניהול שמחובר ב-Socket
    io.emit('new_order', result.rows[0]);
    
    res.status(201).json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error('❌ שגיאה בשמירת הזמנה:', err.message);
    res.status(500).json({ error: 'שגיאה בשמירת הזמנה' });
  }
});

// נתיב לשליפת כל ההזמנות
app.get('/orders', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM orders ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ שגיאה בשליפת הזמנות:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// נתיב לעדכון סטטוס הזמנה
app.patch('/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const result = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    // שליחת עדכון בזמן אמת
    io.emit('order_updated', result.rows[0]);

    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error('❌ שגיאה בעדכון הזמנה:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// נתיב למחיקת הזמנה
app.delete('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
    
    // שליחת עדכון בזמן אמת
    io.emit('order_deleted', { id });
    
    res.json({ success: true, message: 'הזמנה נמחקה בהצלחה' });
  } catch (err) {
    console.error('❌ שגיאה במחיקת הזמנה:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ שגיאה בשליפת מוצרים:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/products', async (req, res) => {
  try {
    const { name, price, image_url, category } = req.body;
    const result = await pool.query(
      'INSERT INTO products (name, price, image_url, category) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, price, image_url || '', category || 'כללי']
    );
    notifyAllClients();
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error('❌ שגיאה בהוספת מוצר:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, image_url, category, in_stock } = req.body;
    const result = await pool.query(
      'UPDATE products SET name = $1, price = $2, image_url = $3, category = $4, in_stock = $5 WHERE id = $6 RETURNING *',
      [name, price, image_url, category, in_stock !== undefined ? in_stock : true, id]
    );
    notifyAllClients();
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error('❌ שגיאה בעדכון מוצר:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
    notifyAllClients();
    res.json({ success: true, message: 'מוצר נמחק בהצלחה' });
  } catch (err) {
    console.error('❌ שגיאה במחיקת מוצר:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// נתיב לשינוי סטטוס מלאי
app.patch('/products/:id/stock', async (req, res) => {
  try {
    const { id } = req.params;
    const { in_stock } = req.body;

    const result = await pool.query(
      'UPDATE products SET in_stock = $1 WHERE id = $2 RETURNING *',
      [in_stock, id]
    );

    notifyAllClients();
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error('❌ שגיאה בעדכון מלאי:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/notify-update', (req, res) => {
  notifyAllClients();
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body {
            font-family: Arial;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .success {
            background: rgba(255,255,255,0.2);
            padding: 30px;
            border-radius: 15px;
            display: inline-block;
            margin-top: 50px;
          }
          h1 { font-size: 48px; margin-bottom: 20px; }
          p { font-size: 24px; }
        </style>
      </head>
      <body>
        <div class="success">
          <h1>✅ עדכון נשלח!</h1>
          <p>כל המכשירים המחוברים (${connectedClients}) קיבלו עדכון</p>
          <p style="margin-top: 30px;">
            <a href="/admin" style="color: white;">← חזרה לממשק ניהול</a>
          </p>
        </div>
      </body>
    </html>
  `);
});

// --- כאן השינוי היחיד: נתיב הניהול המעודכן עם חיפוש וסינון ---
// החלף את כל הנתיב app.get('/admin', ...) בזה:

app.get('/admin', (req, res) => {
  const html = `<!DOCTYPE html>
<html dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title> all in one admin </title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    header {
      background: white;
      padding: 25px;
      border-radius: 15px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.3);
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 15px;
    }
    h1 { color: #171717; font-size: 28px; }
    .status {
      display: flex;
      align-items: center;
      gap: 10px;
      background: #f0f0f0;
      padding: 8px 15px;
      border-radius: 25px;
      font-size: 14px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #4caf50;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .tabs {
      display: flex;
      gap: 10px;
      background: white;
      padding: 15px;
      border-radius: 15px;
      margin-bottom: 20px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.2);
    }
    .tab-btn {
      flex: 1;
      padding: 15px;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.3s;
      background: #f0f0f0;
      color: #555;
    }
    .tab-btn:hover { background: #e0e0e0; }
    .tab-btn.active {
      background: linear-gradient(135deg, #171717 0%, #2e2e2e 100%);
      color: white;
      box-shadow: 0 4px 15px rgba(23, 23, 23, 0.4);
    }
    .tab-btn .badge {
      display: inline-block;
      background: red;
      color: white;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 12px;
      margin-right: 8px;
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .btn {
      padding: 12px 25px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.3s;
      font-weight: bold;
    }
    .btn-primary { background: #171717; color: white; }
    .btn-primary:hover { background: #2e2e2e; }
    .btn-success { background: #4caf50; color: white; }
    .btn-success:hover { background: #45a049; }
    .btn-danger { background: #f44336; color: white; }
    .btn-danger:hover { background: #da190b; }
    .btn-info { background: #2196F3; color: white; }
    .btn-info:hover { background: #0b7dda; }
    .orders-list {
      display: flex;
      flex-direction: column;
      gap: 15px;
      margin-top: 20px;
    }
    .order-card {
      background: white;
      border-radius: 15px;
      padding: 20px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.2);
      transition: transform 0.3s;
    }
    .order-card:hover { transform: translateY(-3px); }
    .order-card.pending { border-right: 5px solid #171717; }
    .order-card.completed { border-right: 5px solid #4caf50; }
    .order-card.cancelled { border-right: 5px solid #f44336; }
    .order-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 15px;
      flex-wrap: wrap;
      gap: 10px;
    }
    .order-info h3 { color: #333; margin-bottom: 5px; }
    .order-info p { color: #666; font-size: 14px; margin: 3px 0; }
    .order-amount {
      font-size: 24px;
      font-weight: bold;
      color: #4caf50;
    }
    .order-status {
      display: inline-block;
      padding: 5px 15px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: bold;
      text-transform: uppercase;
    }
    .status-pending { background: #fff3e0; color: #171717; }
    .status-completed { background: #e8f5e9; color: #2e7d32; }
    .status-cancelled { background: #ffebee; color: #c62828; }
    .order-details {
      background: #f8f8f8;
      padding: 15px;
      border-radius: 10px;
      margin: 15px 0;
    }
    .order-details p { margin: 5px 0; color: #555; }
    .order-items {
      margin: 10px 0;
      padding: 10px;
      background: white;
      border-radius: 8px;
    }
    .order-items h4 { margin-bottom: 10px; color: #333; }
    .order-item {
      display: flex;
      justify-content: space-between;
      padding: 5px 0;
      border-bottom: 1px solid #eee;
    }
    .order-item:last-child { border-bottom: none; }
    .order-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .order-actions button { flex: 1; min-width: 120px; }
    .filter-section {
      background: rgba(255, 255, 255, 0.9);
      padding: 15px;
      border-radius: 15px;
      margin-bottom: 20px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.1);
    }
    .filter-buttons {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .filter-btn {
      padding: 10px 20px;
      background: #f0f0f0;
      border: none;
      border-radius: 20px;
      cursor: pointer;
      font-weight: bold;
      color: #555;
      transition: all 0.2s;
    }
    .filter-btn:hover { background: #e0e0e0; }
    .filter-btn.active {
      background: #171717;
      color: white;
    }
    .notification {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #4caf50;
      color: white;
      padding: 15px 30px;
      border-radius: 10px;
      box-shadow: 0 5px 20px rgba(0,0,0,0.3);
      z-index: 2000;
      display: none;
      animation: slideDown 0.3s;
    }
    .notification.show { display: block; }
    @keyframes slideDown {
      from { transform: translate(-50%, -100%); }
      to { transform: translate(-50%, 0); }
    }
    .controls-area {
      background: rgba(255, 255, 255, 0.9);
      padding: 15px;
      border-radius: 15px;
      margin-bottom: 20px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.1);
    }
    .search-box {
      width: 100%;
      padding: 12px 20px;
      border: 2px solid #ddd;
      border-radius: 25px;
      font-size: 16px;
      margin-bottom: 15px;
      transition: all 0.3s;
      outline: none;
    }
    .search-box:focus {
      border-color: #171717;
      box-shadow: 0 0 10px rgba(23, 23, 23, 0.2);
    }
    .products-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }
    .product-card {
      background: white;
      border-radius: 15px;
      padding: 20px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.2);
      transition: transform 0.3s;
      position: relative;
    }
    .product-card:hover { transform: translateY(-5px); }
    .product-image {
      width: 100%;
      height: 150px;
      object-fit: contain;
      background: #f8f8f8;
      border-radius: 10px;
      margin-bottom: 15px;
    }
    .product-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 15px;
    }
    .product-name {
      font-size: 18px;
      font-weight: bold;
      color: #333;
    }
    .product-price {
      font-size: 22px;
      color: #4caf50;
      font-weight: bold;
    }
    .product-category {
      display: inline-block;
      background: #e3f2fd;
      color: #1976d2;
      padding: 5px 12px;
      border-radius: 15px;
      font-size: 12px;
      margin: 10px 0;
    }
    .product-actions {
      display: flex;
      gap: 10px;
      margin-top: 15px;
    }
    .product-actions button { flex: 1; font-size: 14px; padding: 10px; }
    .out-of-stock-badge {
      position: absolute;
      top: 10px;
      right: 10px;
      background: red;
      color: white;
      padding: 5px 10px;
      border-radius: 5px;
      font-weight: bold;
      font-size: 12px;
      z-index: 10;
    }
    .edit-icon {
      position: absolute;
      top: 15px;
      left: 15px;
      background: #2196F3;
      color: white;
      width: 35px;
      height: 35px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      z-index: 5;
      border: none;
      font-size: 16px;
    }
    .fab-btn {
      position: fixed;
      bottom: 30px;
      left: 30px;
      width: 65px;
      height: 65px;
      background: #171717;
      color: white;
      border-radius: 50%;
      border: none;
      font-size: 35px;
      box-shadow: 0 4px 15px rgba(0,0,0,0.3);
      cursor: pointer;
      z-index: 999;
      display: flex;
      justify-content: center;
      align-items: center;
      transition: transform 0.3s;
    }
    .fab-btn:hover { transform: scale(1.1) rotate(90deg); background: #171717; }
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.6);
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }
    .modal.show { display: flex; }
    .modal-content {
      background: white;
      padding: 25px;
      border-radius: 20px;
      width: 90%;
      max-width: 450px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.4);
      position: relative;
    }
    .form-group { margin-bottom: 15px; text-align: right; }
    .form-control {
      width: 100%;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 10px;
      font-size: 16px;
      margin-top: 5px;
    }
    .close-btn {
      position: absolute;
      top: 15px;
      left: 15px;
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🏪 all in one admin </h1>
      <div class="status">
        <div class="status-dot"></div>
        <span>מחוברים: <strong id="connectedCount">${connectedClients}</strong></span>
      </div>
    </header>

    <div class="tabs">
      <button class="tab-btn" id="productsTabBtn">📦 ניהול מוצרים</button>
      <button class="tab-btn active" id="ordersTabBtn">
        <span class="badge" id="pendingBadge" style="display:none;">0</span>
        🛒 הזמנות
      </button>
      <button class="tab-btn" id="reportsTabBtn">📊 דוחות</button>
    </div>

    <div class="tab-content active" id="ordersTab">
      <div class="filter-section">
        <div class="filter-buttons" id="orderFilters">
          <button class="filter-btn active" data-filter="all">הכל</button>
          <button class="filter-btn" data-filter="pending">ממתינות</button>
          <button class="filter-btn" data-filter="completed">הושלמו</button>
          <button class="filter-btn" data-filter="cancelled">בוטלו</button>
        </div>
      </div>
      <div class="orders-list" id="ordersList">
        <p style="text-align: center; color: white;">טוען הזמנות...</p>
      </div>
    </div>

    <div class="tab-content" id="productsTab">
      <div class="controls-area">
        <input type="text" id="searchInput" class="search-box" placeholder="🔍 חפש מוצר...">
        <div class="filter-buttons" id="categoryFilters"></div>
      </div>
      <div class="products-grid" id="productsGrid">
        <p style="color: white; text-align: center;">טוען מוצרים...</p>
      </div>
    </div>

    <div class="tab-content" id="reportsTab">
      <div style="text-align: center; padding: 50px;">
        <a href="/send-daily-whatsapp" class="btn btn-success" target="_blank" style="display: inline-block; text-decoration: none; font-size: 20px; padding: 20px 40px;">
          📊 הוצא דוח יומי לווטסאפ
        </a>
      </div>
    </div>
  </div>

  <button class="fab-btn" id="addProductBtn">+</button>

  <div id="productModal" class="modal">
    <div class="modal-content">
      <button class="close-btn" id="closeModalBtn">✕</button>
      <h2 id="modalTitle" style="text-align: center; margin-bottom: 20px; color: #333;">מוצר חדש</h2>
      <input type="hidden" id="editId">
      <div class="form-group">
        <label>שם המוצר</label>
        <input type="text" id="prodName" class="form-control" placeholder="למשל: קולה זירו">
      </div>
      <div class="form-group">
        <label>מחיר (₪)</label>
        <input type="number" id="prodPrice" class="form-control" step="0.1">
      </div>
      <div class="form-group">
        <label>קטגוריה</label>
        <select id="prodCategory" class="form-control">
          <option value="כללי">כללי</option>
          <option value="שתייה">שתייה</option>
          <option value="אלכוהול">אלכוהול</option>
          <option value="טבק וסיגריות">טבק וסיגריות</option>
          <option value="גומי">גומי</option>
          <option value="חטיפים">חטיפים</option>
          <option value="גלונית">גלונית</option>
          <option value="שוקולד">שוקולד</option>
          <option value="ממתקים">ממתקים</option>
          <option value="מזון מהיר">מזון מהיר</option>
          <option value="מוצרי קפה">מוצרי קפה</option>
        </select>
      </div>
      <div class="form-group">
        <label>בחר תמונה (מהמאגר בשרת)</label>
        <select id="prodImage" class="form-control">
          <option value="">-- בחר תמונה --</option>
        </select>
        <div style="text-align: center; margin-top: 10px;">
          <img id="imgPreview" src="" style="max-height: 100px; display: none; border-radius: 10px; border: 1px solid #ddd;">
        </div>
      </div>
      <button class="btn btn-success" id="saveProductBtn" style="width: 100%; padding: 15px; margin-top: 10px; font-size: 18px;">
        💾 שמור מוצר
      </button>
    </div>
  </div>

  <div class="notification" id="notification"></div>

  <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
  <script>
    // משתנים גלובליים
    var orders = [];
    var products = [];
    var availableImages = [];
    var currentFilter = 'all';
    var currentCategory = 'הכל';

    // אתחול Socket.io
    var socket = io();

    socket.on('new_order', function(order) {
      showNotification('🔔 הזמנה חדשה!');
      loadOrders();
    });

    socket.on('order_updated', function(order) {
      loadOrders();
    });

    // Event Listeners לטאבים
    document.getElementById('productsTabBtn').addEventListener('click', function() {
      switchTab('products');
    });

    document.getElementById('ordersTabBtn').addEventListener('click', function() {
      switchTab('orders');
    });

    document.getElementById('reportsTabBtn').addEventListener('click', function() {
      switchTab('reports');
    });

    // Event Listeners לסינון הזמנות
    document.getElementById('orderFilters').addEventListener('click', function(e) {
      if (e.target.classList.contains('filter-btn')) {
        var filter = e.target.getAttribute('data-filter');
        filterOrders(filter, e.target);
      }
    });

    // Event Listener לחיפוש מוצרים
    document.getElementById('searchInput').addEventListener('input', function() {
      filterProducts();
    });

    // Event Listeners למודל
    document.getElementById('addProductBtn').addEventListener('click', function() {
      openProductModal();
    });

    document.getElementById('closeModalBtn').addEventListener('click', function() {
      closeModal();
    });

    document.getElementById('saveProductBtn').addEventListener('click', function() {
      saveProduct();
    });

    document.getElementById('prodImage').addEventListener('change', function() {
      previewImage();
    });

    // פונקציות
    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.classList.remove('active');
      });
      document.querySelectorAll('.tab-content').forEach(function(content) {
        content.classList.remove('active');
      });

      document.getElementById(tab + 'TabBtn').classList.add('active');
      document.getElementById(tab + 'Tab').classList.add('active');

      if (tab === 'products') loadProducts();
      if (tab === 'orders') loadOrders();
    }

    function loadOrders() {
      fetch('/orders')
        .then(function(response) { return response.json(); })
        .then(function(data) {
          orders = data;
          renderOrders();
          updatePendingBadge();
        })
        .catch(function(error) {
          console.error('שגיאה:', error);
        });
    }

    function renderOrders() {
      var list = document.getElementById('ordersList');
      var filtered = currentFilter === 'all' ? orders : orders.filter(function(o) {
        return o.status === currentFilter;
      });

      if (filtered.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: white; padding: 50px;">אין הזמנות</p>';
        return;
      }

      list.innerHTML = '';
      filtered.forEach(function(order) {
        var items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
        var statusClass = order.status || 'pending';
        var statusText = statusClass === 'pending' ? 'ממתינה' : (statusClass === 'completed' ? 'הושלמה' : 'בוטלה');

        var card = document.createElement('div');
        card.className = 'order-card ' + statusClass;

        var itemsHtml = items.map(function(item) {
          return '<div class="order-item"><span>' + item.name + ' x' + item.quantity + '</span><span>' + (item.price * item.quantity).toFixed(2) + ' ₪</span></div>';
        }).join('');

        card.innerHTML = '<div class="order-header">' +
          '<div class="order-info">' +
          '<h3>' + order.customer_name + '</h3>' +
          '<p>📱 ' + order.customer_phone + '</p>' +
          '<p>📅 ' + new Date(order.created_at).toLocaleString('he-IL') + '</p>' +
          '<span class="order-status status-' + statusClass + '">' + statusText + '</span>' +
          '</div>' +
          '<div class="order-amount">' + parseFloat(order.total_amount).toFixed(2) + ' ₪</div>' +
          '</div>' +
          '<div class="order-details">' +
          '<p><strong>סוג משלוח:</strong> ' + order.delivery_type + '</p>' +
          '<p><strong>כתובת:</strong> ' + order.shipping_location + '</p>' +
          '<p><strong>תשלום:</strong> ' + order.payment_method + '</p>' +
          '</div>' +
          '<div class="order-items"><h4>פריטים:</h4>' + itemsHtml + '</div>' +
          '<div class="order-actions"></div>';

        var actionsDiv = card.querySelector('.order-actions');

        var whatsappBtn = document.createElement('button');
        whatsappBtn.className = 'btn btn-info';
        whatsappBtn.textContent = '📱 WhatsApp';
        whatsappBtn.addEventListener('click', function() {
          window.open('https://wa.me/' + order.customer_phone, '_blank');
        });
        actionsDiv.appendChild(whatsappBtn);

        var completeBtn = document.createElement('button');
        completeBtn.className = 'btn btn-success';
        completeBtn.textContent = '✅ הושלמה';
        completeBtn.addEventListener('click', function() {
          updateOrderStatus(order.id, 'completed');
        });
        actionsDiv.appendChild(completeBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-danger';
        cancelBtn.textContent = '❌ בטל';
        cancelBtn.addEventListener('click', function() {
          updateOrderStatus(order.id, 'cancelled');
        });
        actionsDiv.appendChild(cancelBtn);

        list.appendChild(card);
      });
    }

    function filterOrders(status, btn) {
      currentFilter = status;
      document.querySelectorAll('#orderFilters .filter-btn').forEach(function(b) {
        b.classList.remove('active');
      });
      btn.classList.add('active');
      renderOrders();
    }

    function updateOrderStatus(orderId, status) {
      if (!confirm('האם אתה בטוח?')) return;

      fetch('/orders/' + orderId + '/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status })
      })
        .then(function(response) {
          if (response.ok) {
            showNotification('✅ עודכן בהצלחה!');
            loadOrders();
          }
        })
        .catch(function(error) {
          showNotification('❌ שגיאה', true);
        });
    }

    function updatePendingBadge() {
      var pending = orders.filter(function(o) {
        return o.status === 'pending' || !o.status;
      }).length;
      var badge = document.getElementById('pendingBadge');
      badge.textContent = pending;
      badge.style.display = pending > 0 ? 'inline-block' : 'none';
    }

    function loadProducts() {
      fetch('/products')
        .then(function(response) { return response.json(); })
        .then(function(data) {
          products = data;
          renderCategoryFilters();
          filterProducts();
        })
        .catch(function(error) {
          console.error('שגיאה:', error);
        });
    }

    function renderCategoryFilters() {
      var categories = ['הכל', 'שתייה', 'אלכוהול', 'טבק וסיגריות', 'גומי', 'חטיפים', 'גלונית', 'שוקולד', 'ממתקים', 'מזון מהיר', 'מוצרי קפה'];
      var container = document.getElementById('categoryFilters');
      container.innerHTML = '';

      categories.forEach(function(cat) {
        var btn = document.createElement('button');
        btn.className = 'filter-btn' + (cat === currentCategory ? ' active' : '');
        btn.textContent = cat;
        btn.addEventListener('click', function() {
          setCategory(cat);
        });
        container.appendChild(btn);
      });
    }

    function setCategory(category) {
      currentCategory = category;
      renderCategoryFilters();
      filterProducts();
    }

    function filterProducts() {
      var searchTerm = document.getElementById('searchInput').value.toLowerCase();
      var filtered = products.filter(function(p) {
        var categoryMatch = currentCategory === 'הכל' || (p.category && p.category.indexOf(currentCategory) !== -1);
        var searchMatch = p.name.toLowerCase().indexOf(searchTerm) !== -1;
        return categoryMatch && searchMatch;
      });
      renderProducts(filtered);
    }

    function renderProducts(list) {
      var grid = document.getElementById('productsGrid');
      grid.innerHTML = '';

      if (list.length === 0) {
        grid.innerHTML = '<p style="color: white; text-align: center; grid-column: 1/-1;">אין מוצרים</p>';
        return;
      }

      list.forEach(function(p) {
        var outOfStock = !p.in_stock;

        var card = document.createElement('div');
        card.className = 'product-card';
        if (outOfStock) card.style.opacity = '0.6';

        if (outOfStock) {
          var badge = document.createElement('div');
          badge.className = 'out-of-stock-badge';
          badge.textContent = 'אזל';
          card.appendChild(badge);
        }

        var editBtn = document.createElement('button');
        editBtn.className = 'edit-icon';
        editBtn.textContent = '✏️';
        editBtn.addEventListener('click', function() {
          editProduct(p.id);
        });
        card.appendChild(editBtn);

        if (p.image_url) {
          var img = document.createElement('img');
          img.src = p.image_url;
          img.className = 'product-image';
          img.alt = p.name;
          card.appendChild(img);
        }

        var header = document.createElement('div');
        header.className = 'product-header';
        header.innerHTML = '<div><div class="product-name">' + p.name + '</div><span class="product-category">' + (p.category || 'כללי') + '</span></div><div class="product-price">' + p.price + ' ₪</div>';
        card.appendChild(header);

        var actions = document.createElement('div');
        actions.className = 'product-actions';

        var stockBtn = document.createElement('button');
        stockBtn.className = 'btn ' + (outOfStock ? 'btn-success' : 'btn-danger');
        stockBtn.textContent = outOfStock ? '✅ החזר' : '📦 הוצא';
        stockBtn.addEventListener('click', function() {
          toggleStock(p.id, outOfStock);
        });
        actions.appendChild(stockBtn);

        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-danger';
        deleteBtn.textContent = '🗑️';
        deleteBtn.addEventListener('click', function() {
          deleteProduct(p.id, p.name);
        });
        actions.appendChild(deleteBtn);

        card.appendChild(actions);
        grid.appendChild(card);
      });
    }

    function toggleStock(productId, newStatus) {
      fetch('/products/' + productId + '/stock', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ in_stock: newStatus })
      })
        .then(function(response) {
          if (response.ok) {
            showNotification(newStatus ? '✅ חזר למלאי!' : '📦 הוצא מהמלאי!');
            var prod = products.find(function(p) { return p.id === productId; });
            if (prod) prod.in_stock = newStatus;
            filterProducts();
          }
        })
        .catch(function(error) {
          showNotification('❌ שגיאה', true);
        });
    }

    function deleteProduct(productId, name) {
      if (!confirm('בטוח למחוק "' + name + '"?')) return;

      fetch('/products/' + productId, { method: 'DELETE' })
        .then(function(response) {
          if (response.ok) {
            showNotification('🗑️ נמחק!');
            loadProducts();
          }
        })
        .catch(function(error) {
          showNotification('❌ שגיאה', true);
        });
    }

    function loadAvailableImages() {
      fetch('/available-images')
        .then(function(response) { return response.json(); })
        .then(function(images) {
          availableImages = images;
          var select = document.getElementById('prodImage');
          select.innerHTML = '<option value="">-- בחר תמונה --</option>';
          images.forEach(function(img) {
            var option = document.createElement('option');
            option.value = '/images/' + img;
            option.textContent = img;
            select.appendChild(option);
          });
        })
        .catch(function(error) {
          console.error('שגיאה בטעינת תמונות:', error);
        });
    }

    function openProductModal() {
      loadAvailableImages();
      document.getElementById('modalTitle').textContent = 'מוצר חדש';
      document.getElementById('editId').value = '';
      document.getElementById('prodName').value = '';
      document.getElementById('prodPrice').value = '';
      document.getElementById('prodCategory').value = 'כללי';
      document.getElementById('prodImage').value = '';
      document.getElementById('imgPreview').style.display = 'none';
      document.getElementById('productModal').classList.add('show');
    }

    function editProduct(productId) {
      var product = products.find(function(p) { return p.id === productId; });
      if (!product) return;

      loadAvailableImages();
      document.getElementById('modalTitle').textContent = 'ערוך מוצר';
      document.getElementById('editId').value = product.id;
      document.getElementById('prodName').value = product.name;
      document.getElementById('prodPrice').value = product.price;
      document.getElementById('prodCategory').value = product.category || 'כללי';

      setTimeout(function() {
        document.getElementById('prodImage').value = product.image_url || '';
        if (product.image_url) {
          document.getElementById('imgPreview').src = product.image_url;
          document.getElementById('imgPreview').style.display = 'block';
        }
      }, 200);

      document.getElementById('productModal').classList.add('show');
    }

    function closeModal() {
      document.getElementById('productModal').classList.remove('show');
    }

    function previewImage() {
      var select = document.getElementById('prodImage');
      var preview = document.getElementById('imgPreview');
      if (select.value) {
        preview.src = select.value;
        preview.style.display = 'block';
      } else {
        preview.style.display = 'none';
      }
    }

    function saveProduct() {
      var id = document.getElementById('editId').value;
      var name = document.getElementById('prodName').value;
      var price = document.getElementById('prodPrice').value;
      var category = document.getElementById('prodCategory').value;
      var image_url = document.getElementById('prodImage').value;

      if (!name || !price) {
        showNotification('❌ נא למלא שם ומחיר', true);
        return;
      }

      var url = id ? '/products/' + id : '/products';
      var method = id ? 'PUT' : 'POST';

      fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, price: price, image_url: image_url, category: category, in_stock: true })
      })
        .then(function(response) {
          if (response.ok) {
            showNotification(id ? '✅ מוצר עודכן!' : '✅ מוצר נוסף!');
            closeModal();
            loadProducts();
          }
        })
        .catch(function(error) {
          showNotification('❌ שגיאה', true);
        });
    }

    function showNotification(message, isError) {
      var notif = document.getElementById('notification');
      notif.textContent = message;
      notif.style.background = isError ? '#f44336' : '#4caf50';
      notif.classList.add('show');
      setTimeout(function() {
        notif.classList.remove('show');
      }, 3000);
    }

    // טעינה ראשונית
    loadOrders();
    setInterval(loadOrders, 30000);
  </script>
</body>
</html>`;

  res.send(html);
});


app.post('/record-order', async (req, res) => {
  try {
    const { orderId, items, total } = req.body;

    for (const item of items) {
      await pool.query(
        'INSERT INTO sales (order_id, product_name, quantity, price, total) VALUES ($1, $2, $3, $4, $5)',
        [orderId, item.name, item.quantity, item.price, item.price * item.quantity]
      );
    }

    console.log(`✅ מכירה חדשה נרשמה: הזמנה ${orderId}`);
    res.json({ success: true });

  } catch (err) {
    console.error('❌ שגיאה בשמירת מכירה:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// נתיב לשליחת דוח לווטסאפ - גרסה מתוקנת ✅
app.get('/send-daily-whatsapp', async (req, res) => {
  try {
    const topProductsQuery = `
      SELECT 
        product_name,
        SUM(quantity) as total_quantity,
        SUM(total) as total_sales
      FROM sales
      WHERE DATE(created_at) = CURRENT_DATE
      GROUP BY product_name
      ORDER BY total_quantity DESC
      LIMIT 3
    `;

    const topProducts = await pool.query(topProductsQuery);

    const totalRevenueQuery = `
      SELECT 
        COALESCE(SUM(total), 0) as daily_revenue,
        COUNT(DISTINCT order_id) as total_orders
      FROM sales
      WHERE DATE(created_at) = CURRENT_DATE
    `;

    const revenue = await pool.query(totalRevenueQuery);

    const reportData = {
      topProducts: topProducts.rows,
      dailyRevenue: revenue.rows[0].daily_revenue,
      totalOrders: revenue.rows[0].total_orders,
      reportDate: new Date().toLocaleDateString('he-IL')
    };

    let message = `📊 *דוח יומי - ${reportData.reportDate}*\n\n`;
    message += `💰 *סך הכנסות:* ${parseFloat(reportData.dailyRevenue).toFixed(2)} ₪\n`;
    message += `🛒 *מספר הזמנות:* ${reportData.totalOrders}\n\n`;
    message += `🏆 *3 המוצרים הנמכרים ביותר:*\n\n`;

    if (reportData.topProducts.length === 0) {
      message += `אין מכירות היום 😔`;
    } else {
      reportData.topProducts.forEach((product, index) => {
        message += `${index + 1}. *${product.product_name}*\n`;
        message += `   כמות: ${product.total_quantity} יחידות\n`;
        message += `   הכנסה: ${parseFloat(product.total_sales).toFixed(2)} ₪\n\n`;
      });
    }

    const phoneNumber = '972556659494';
    const whatsappUrl = `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;

    res.send(`
      <!DOCTYPE html>
      <html dir="rtl">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>דוח יומי - ווטסאפ</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 600px;
            width: 100%;
          }
          h1 {
            color: #25D366;
            font-size: 32px;
            margin-bottom: 20px;
            text-align: center;
          }
          .report-preview {
            background: #f8f8f8;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
            white-space: pre-wrap;
            font-family: monospace;
            direction: rtl;
            text-align: right;
          }
          .btn {
            display: block;
            width: 100%;
            padding: 15px;
            background: #25D366;
            color: white;
            text-decoration: none;
            border-radius: 10px;
            text-align: center;
            font-size: 18px;
            font-weight: bold;
            margin-top: 20px;
            transition: all 0.3s;
          }
          .btn:hover {
            background: #20BA5A;
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(37, 211, 102, 0.4);
          }
          .back-link {
            display: block;
            text-align: center;
            margin-top: 20px;
            color: #666;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📱 דוח יומי - ווטסאפ</h1>
          <div class="report-preview">${message}</div>
          <a href="${whatsappUrl}" class="btn" target="_blank">
            📲 שלח דוח לווטסאפ
          </a>
          <a href="/admin" class="back-link">← חזרה לממשק ניהול</a>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    console.error('❌ שגיאה בשליחת דוח:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/test-daily-report', async (req, res) => {
  const message = await generateDailyReport();

  if (message) {
    res.send(`
      <html dir="rtl">
        <head><meta charset="utf-8"></head>
        <body style="padding: 20px; font-family: Arial;">
          <h1>✅ דוח נוצר בהצלחה!</h1>
          <pre style="background: #f0f0f0; padding: 20px; border-radius: 10px;">${message}</pre>
          <p><a href="/admin">← חזרה לממשק ניהול</a></p>
        </body>
      </html>
    `);
  } else {
    res.send('❌ שגיאה ביצירת הדוח');
  }
});

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body {
            font-family: Arial;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .container {
            background: white;
            padding: 50px;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          }
          h1 { color: #161515; font-size: 42px; margin-bottom: 30px; }
          .button {
            display: inline-block;
            padding: 20px 40px;
            margin: 15px;
            background: #2a2828;
            color: white;
            text-decoration: none;
            border-radius: 12px;
            font-size: 20px;
            font-weight: bold;
            transition: all 0.3s;
            box-shadow: 0 5px 15px rgba(23,23,23,0.3);
          }
          .button:hover { 
            background: #191918;
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(23,23,23,0.4);
          }
          .info {
            margin-top: 40px;
            padding: 25px;
            background: #f8f8f8;
            border-radius: 12px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🍺 all in one</h1>
          <h2 style="color: #666; margin-bottom: 40px;">מערכת ניהול מוצרים</h2>
          <div>
            <a href="/admin" class="button">🎛️ ממשק ניהול</a>
            <a href="/products" class="button">📦 צפה במוצרים</a>
          </div>
          <div class="info">
            <p><strong>מכשירים מחוברים כרגע:</strong> ${connectedClients}</p>
            <p style="color: #666; margin-top: 15px; font-size: 14px;">
              💡 השתמש בממשק הניהול לעדכון מוצרים<br>
              כל שינוי יעודכן אוטומטית בכל המכשירים!
            </p>
          </div>
        </div>
      </body>
    </html>
  `);
});

async function generateDailyReport() {
  try {
    const topProductsQuery = `
      SELECT 
        product_name,
        SUM(quantity) as total_quantity,
        SUM(total) as total_sales
      FROM sales
      WHERE DATE(created_at) = CURRENT_DATE
      GROUP BY product_name
      ORDER BY total_quantity DESC
      LIMIT 3
    `;

    const topProducts = await pool.query(topProductsQuery);

    const totalRevenueQuery = `
      SELECT 
        COALESCE(SUM(total), 0) as daily_revenue,
        COUNT(DISTINCT order_id) as total_orders
      FROM sales
      WHERE DATE(created_at) = CURRENT_DATE
    `;

    const revenue = await pool.query(totalRevenueQuery);

    const reportData = {
      topProducts: topProducts.rows,
      dailyRevenue: revenue.rows[0].daily_revenue,
      totalOrders: revenue.rows[0].total_orders,
      reportDate: new Date().toLocaleDateString('he-IL')
    };

    let message = `📊 *דוח יומי - ${reportData.reportDate}*\n\n`;
    message += `💰 *סך הכנסות:* ${parseFloat(reportData.dailyRevenue).toFixed(2)} ₪\n`;
    message += `🛒 *מספר הזמנות:* ${reportData.totalOrders}\n\n`;
    message += `🏆 *3 המוצרים הנמכרים ביותר:*\n\n`;

    if (reportData.topProducts.length === 0) {
      message += `אין מכירות היום 😔`;
    } else {
      reportData.topProducts.forEach((product, index) => {
        message += `${index + 1}. *${product.product_name}*\n`;
        message += `   כמות: ${product.total_quantity} יחידות\n`;
        message += `   הכנסה: ${parseFloat(product.total_sales).toFixed(2)} ₪\n\n`;
      });
    }

    return message;
  } catch (err) {
    console.error('❌ שגיאה בהפקת דוח:', err.message);
    return null;
  }
}

cron.schedule('30 19 * * *', async () => {
  console.log('⏰ מפיק דוח יומי אוטומטי...');

  const message = await generateDailyReport();

  if (message) {
    const phoneNumber = '972500000000';
    const whatsappUrl = `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;

    console.log('📊 ════════════════════════════════════');
    console.log('✅ דוח יומי נוצר בהצלחה!');
    console.log('📅 תאריך:', new Date().toLocaleString('he-IL'));
    console.log('📱 קישור לשליחה:', whatsappUrl);
    console.log('════════════════════════════════════');

    await notifyDailyReport();
  }
}, {
  timezone: "Asia/Jerusalem"
});

async function notifyDailyReport() {
  const message = await generateDailyReport();
  if (message && connectedClients > 0) {
    io.emit('daily_report_ready', {
      message: 'הדוח היומי מוכן!',
      url: '/send-daily-whatsapp'
    });
    console.log(`📢 התראה נשלחה ל-${connectedClients} מכשירים מחוברים`);
  }
}

server.listen(5001, () => {
  console.log('🚀 שרת רץ על http://localhost:5001');
  console.log('🎛️ ממשק ניהול: http://localhost:5001/admin');
  console.log('📸 תמונות מוגשות מ: public/images/');
});
