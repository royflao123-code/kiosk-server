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

app.get('/admin', (req, res) => {
  const html = `<!DOCTYPE html>
<html dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ממשק ניהול - צרכניית אלוני</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
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
    h1 { color: #ff6b35; font-size: 28px; } /* קצת הקטנתי שייכנס יפה בנייד */
    
    /* --- תוספות חדשות לחיפוש וסינון --- */
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
      border-color: #ff6b35;
      box-shadow: 0 0 10px rgba(255, 107, 53, 0.2);
    }
    .filter-buttons {
      display: flex;
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 5px;
      scrollbar-width: none; /* Firefox */
    }
    .filter-buttons::-webkit-scrollbar { display: none; } /* Chrome/Safari */
    
    .filter-btn {
      padding: 8px 16px;
      background: #f0f0f0;
      border: none;
      border-radius: 20px;
      cursor: pointer;
      white-space: nowrap;
      font-weight: bold;
      color: #555;
      transition: all 0.2s;
    }
    .filter-btn:hover { background: #e0e0e0; }
    .filter-btn.active {
      background: #ff6b35;
      color: white;
      box-shadow: 0 2px 8px rgba(255, 107, 53, 0.4);
    }
    /* ---------------------------------- */

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
    .btn {
      padding: 12px 25px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.3s;
      font-weight: bold;
    }
    .btn-primary { background: #ff6b35; color: white; }
    .btn-primary:hover { background: #e85a2a; }
    .btn-success { background: #4caf50; color: white; }
    .btn-success:hover { background: #45a049; }
    .btn-danger { background: #f44336; color: white; }
    .btn-danger:hover { background: #da190b; }
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
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }
    .modal.active { display: flex; }
    .modal-content {
      background: white;
      padding: 30px;
      border-radius: 15px;
      max-width: 500px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
    }
    .form-group { margin-bottom: 20px; }
    .form-group label {
      display: block;
      margin-bottom: 8px;
      font-weight: bold;
      color: #333;
    }
    .form-group input,
    .form-group select {
      width: 100%;
      padding: 12px;
      border: 2px solid #ddd;
      border-radius: 8px;
      font-size: 16px;
    }
    .form-group input:focus,
    .form-group select:focus {
      outline: none;
      border-color: #ff6b35;
    }
    .image-selector {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
      gap: 10px;
      max-height: 300px;
      overflow-y: auto;
      padding: 10px;
      background: #f8f8f8;
      border-radius: 8px;
    }
    .image-option {
      cursor: pointer;
      border: 3px solid transparent;
      border-radius: 8px;
      padding: 5px;
      transition: all 0.3s;
    }
    .image-option:hover {
      border-color: #ff6b35;
    }
    .image-option.selected {
      border-color: #4caf50;
      background: #e8f5e9;
    }
    .image-option img {
      width: 100%;
      height: 70px;
      object-fit: contain;
      border-radius: 5px;
    }
    .image-option-name {
      font-size: 10px;
      text-align: center;
      margin-top: 5px;
      color: #666;
    }
    .modal-actions {
      display: flex;
      gap: 10px;
      margin-top: 25px;
    }
    .modal-actions button { flex: 1; }
    .add-product-btn {
      position: fixed;
      bottom: 30px;
      left: 30px;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: #ff6b35;
      color: white;
      border: none;
      font-size: 30px;
      cursor: pointer;
      box-shadow: 0 5px 20px rgba(0,0,0,0.3);
      transition: all 0.3s;
      z-index: 999;
    }
    .add-product-btn:hover {
      transform: scale(1.1);
      background: #e85a2a;
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
    }
    .notification.show { display: block; animation: slideDown 0.3s; }
    @keyframes slideDown {
      from { transform: translate(-50%, -100%); }
      to { transform: translate(-50%, 0); }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🍺 ממשק ניהול</h1>
      <div class="status">
        <div class="status-dot"></div>
        <span>מחוברים: <strong id="connectedCount">${connectedClients}</strong></span>
      </div>
    </header>

    <div style="text-align: center; margin-bottom: 20px;">
      <a href="/send-daily-whatsapp" class="btn btn-success" target="_blank" style="display: inline-block; text-decoration: none;">
        📊 דוח יומי לווטסאפ
      </a>
    </div>

    <div class="controls-area">
      <input type="text" id="searchInput" class="search-box" placeholder="🔍 חפש מוצר לפי שם..." oninput="filterProducts()">
      
      <div class="filter-buttons" id="categoryFilters">
        <button class="filter-btn active" onclick="setCategory('הכל')">הכל</button>
        <button class="filter-btn" onclick="setCategory('שתייה')">שתייה</button>
        <button class="filter-btn" onclick="setCategory('אלכוהול')">אלכוהול</button>
        <button class="filter-btn" onclick="setCategory('טבק וסיגריות')">טבק</button>
        <button class="filter-btn" onclick="setCategory('גומי')">גומי</button>
        <button class="filter-btn" onclick="setCategory('חטיפים')">חטיפים</button>
        <button class="filter-btn" onclick="setCategory('גלונים')">גלונים</button>
        <button class="filter-btn" onclick="setCategory('שוקולד')">שוקולד</button>
      </div>
    </div>

    <div class="products-grid" id="productsGrid">
      <p style="color: white; text-align: center;">טוען מוצרים...</p>
    </div>
  </div>

  <button class="add-product-btn" onclick="openAddModal()">+</button>

  <div class="modal" id="productModal">
    <div class="modal-content">
      <h2 id="modalTitle">הוספת מוצר חדש</h2>
      <form id="productForm" onsubmit="saveProduct(event)">
        <input type="hidden" id="productId">
        <div class="form-group">
          <label>שם המוצר *</label>
          <input type="text" id="productName" required>
        </div>
        <div class="form-group">
          <label>מחיר (₪) *</label>
          <input type="number" step="0.01" id="productPrice" required>
        </div>
        <div class="form-group">
          <label>קטגוריה</label>
          <select id="productCategory">
            <option value="כללי">כללי</option>
            <option value="שתייה">שתייה</option>
            <option value="אלכוהול">אלכוהול</option>
            <option value="טבק וסיגריות">טבק וסיגריות</option>
            <option value="גומי">גומי</option>
            <option value="חטיפים">חטיפים</option>
            <option value="גלונים">גלונים</option>
            <option value="שוקולד">שוקולד</option>
          </select>
        </div>
        <div class="form-group">
          <label>בחר תמונה מהמחשב</label>
          <div class="image-selector" id="imageSelector">
            <p style="text-align: center; color: #666;">טוען תמונות...</p>
          </div>
          <input type="hidden" id="productImage">
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-danger" onclick="closeModal()">ביטול</button>
          <button type="submit" class="btn btn-success">שמור</button>
        </div>
      </form>
    </div>
  </div>
  <div class="notification" id="notification"></div>
  
  <script>
    let products = [];
    let availableImages = [];
    let currentCategory = 'הכל'; // משתנה לשמירת הקטגוריה הנוכחית

    // פונקציית סינון ראשית - משלבת חיפוש וקטגוריה
    function filterProducts() {
      const searchTerm = document.getElementById('searchInput').value.toLowerCase();
      
      const filtered = products.filter(p => {
        // בדיקת קטגוריה
        const categoryMatch = currentCategory === 'הכל' || (p.category && p.category.includes(currentCategory)) || (currentCategory === 'כללי' && !p.category);
        
        // בדיקת חיפוש
        const searchMatch = p.name.toLowerCase().includes(searchTerm);
        
        return categoryMatch && searchMatch;
      });

      renderProducts(filtered);
    }

    function setCategory(category) {
      currentCategory = category;
      
      // עדכון ויזואלי של הכפתורים
      document.querySelectorAll('.filter-btn').forEach(btn => {
        if(btn.innerText.includes(category) || (category === 'הכל' && btn.innerText === 'הכל')) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      filterProducts(); // הפעלת הסינון
    }

    async function loadImages() {
      try {
        const response = await fetch('/available-images');
        availableImages = await response.json();
        renderImageSelector();
      } catch (error) {
        console.error('שגיאה בטעינת תמונות:', error);
      }
    }

    function renderImageSelector() {
      const selector = document.getElementById('imageSelector');
      if (availableImages.length === 0) {
        selector.innerHTML = '<p style="text-align: center; color: #666;">אין תמונות זמינות</p>';
        return;
      }
      selector.innerHTML = availableImages.map(img => 
        '<div class="image-option" onclick="selectImage(\\'' + img + '\\')">' +
          '<img src="/images/' + img + '" alt="' + img + '">' +
          '<div class="image-option-name">' + img + '</div>' +
        '</div>'
      ).join('');
    }

    function selectImage(imageName) {
      document.querySelectorAll('.image-option').forEach(el => el.classList.remove('selected'));
      event.currentTarget.classList.add('selected');
      document.getElementById('productImage').value = '/images/' + imageName;
    }

    async function loadProducts() {
      try {
        const response = await fetch('/products');
        products = await response.json();
        filterProducts(); // שימוש בסינון במקום רינדור ישיר
      } catch (error) {
        console.error('שגיאה בטעינת מוצרים:', error);
      }
    }

    // הפונקציה מקבלת כרגע רשימה לרינדור
    function renderProducts(listToRender) {
      const grid = document.getElementById('productsGrid');
      // שימוש ברשימה המסוננת, או בכל המוצרים אם לא הועברה רשימה
      const list = listToRender || products;

      if (list.length === 0) {
        grid.innerHTML = '<p style="color: white; text-align: center; grid-column: 1/-1;">לא נמצאו מוצרים התואמים לחיפוש.</p>';
        return;
      }
      
      grid.innerHTML = list.map(p => {
        const outOfStock = !p.in_stock;
        const badge = outOfStock ? '<div style="position: absolute; top: 10px; right: 10px; background: red; color: white; padding: 5px 10px; border-radius: 5px; font-weight: bold; font-size: 12px; z-index: 10;">אזל מהמלאי</div>' : '';
        const opacity = outOfStock ? ' style="opacity: 0.6; position: relative;"' : '';
        const btnClass = outOfStock ? 'btn-success' : 'btn-danger';
        
        return '<div class="product-card"' + opacity + '>' +
          badge +
          (p.image_url ? '<img src="' + p.image_url + '" class="product-image" alt="' + p.name + '">' : '') +
          '<div class="product-header">' +
            '<div>' +
              '<div class="product-name">' + p.name + '</div>' +
              '<span class="product-category">' + (p.category || 'כללי') + '</span>' +
            '</div>' +
            '<div class="product-price">' + p.price + ' ₪</div>' +
          '</div>' +
          '<div class="product-actions">' +
            '<button class="btn ' + btnClass + '" onclick="toggleStock(' + p.id + ', ' + outOfStock + ')">' + (outOfStock ? '✅ החזר' : '📦 הוצא') + '</button>' +
            '<button class="btn btn-primary" onclick="editProduct(' + p.id + ')">✏️</button>' +
            '<button class="btn btn-danger" onclick="deleteProduct(' + p.id + ', \\'' + p.name.replace(/'/g, "\\\\'") + '\\')">🗑️</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    async function toggleStock(productId, newStatus) {
      try {
        const response = await fetch('/products/' + productId + '/stock', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ in_stock: newStatus })
        });
        if (response.ok) {
          showNotification(newStatus ? '✅ המוצר חזר למלאי!' : '📦 המוצר הוצא מהמלאי!');
          
          // עדכון לוקאלי של הרשימה כדי שלא נצטרך לרענן הכל
          const prod = products.find(p => p.id === productId);
          if(prod) prod.in_stock = newStatus;
          
          filterProducts(); // רינדור מחדש עם הסינון הנוכחי
        }
      } catch (error) {
        showNotification('שגיאה: ' + error.message, true);
      }
    }

    function openAddModal() {
      document.getElementById('modalTitle').textContent = 'הוספת מוצר חדש';
      document.getElementById('productForm').reset();
      document.getElementById('productId').value = '';
      document.querySelectorAll('.image-option').forEach(el => el.classList.remove('selected'));
      document.getElementById('productModal').classList.add('active');
    }

    function editProduct(productId) {
      const product = products.find(p => p.id === productId);
      if (!product) return;
      document.getElementById('modalTitle').textContent = 'עריכת מוצר';
      document.getElementById('productId').value = product.id;
      document.getElementById('productName').value = product.name;
      document.getElementById('productPrice').value = product.price;
      document.getElementById('productCategory').value = product.category || 'כללי';
      document.getElementById('productImage').value = product.image_url || '';
      if (product.image_url) {
        const imageName = product.image_url.split('/').pop();
        document.querySelectorAll('.image-option').forEach(el => {
          if (el.querySelector('img').src.includes(imageName)) {
            el.classList.add('selected');
          }
        });
      }
      document.getElementById('productModal').classList.add('active');
    }

    function closeModal() {
      document.getElementById('productModal').classList.remove('active');
    }

    async function saveProduct(event) {
      event.preventDefault();
      const productId = document.getElementById('productId').value;
      const data = {
        name: document.getElementById('productName').value,
        price: parseFloat(document.getElementById('productPrice').value),
        category: document.getElementById('productCategory').value,
        image_url: document.getElementById('productImage').value
      };
      try {
        const url = productId ? '/products/' + productId : '/products';
        const method = productId ? 'PUT' : 'POST';
        const response = await fetch(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (response.ok) {
          showNotification(productId ? 'מוצר עודכן בהצלחה! ✅' : 'מוצר נוסף בהצלחה! ✅');
          closeModal();
          loadProducts(); // טוען הכל מחדש ומפעיל את הסינון
        }
      } catch (error) {
        showNotification('שגיאה: ' + error.message, true);
      }
    }

    async function deleteProduct(productId, name) {
      if (!confirm('בטוח למחוק את "' + name + '"?')) return;
      try {
        const response = await fetch('/products/' + productId, { method: 'DELETE' });
        if (response.ok) {
          showNotification('מוצר נמחק בהצלחה! 🗑️');
          loadProducts();
        }
      } catch (error) {
        showNotification('שגיאה: ' + error.message, true);
      }
    }

    function showNotification(message, isError) {
      const notif = document.getElementById('notification');
      notif.textContent = message;
      notif.style.background = isError ? '#f44336' : '#4caf50';
      notif.classList.add('show');
      setTimeout(() => notif.classList.remove('show'), 3000);
    }

    loadImages();
    loadProducts();
  </script>
</body>
</html>`;

  res.send(html);
});

    

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
    // שליפה ישירה מהדאטאבייס (ללא fetch)

    // שליפת 3 המוצרים הכי נמכרים של היום
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

    // שליפת סך ההכנסות של היום
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

    // בניית ההודעה
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

    // יצירת קישור לווטסאפ
    const phoneNumber = '972556659494'; // 🔴 כאן תשנה למספר שלך!
    const whatsappUrl = `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;

    // החזרת דף HTML עם כפתור לשליחה
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

// נתיב לבדיקת הדוח (ללא שליחה)
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
          h1 { color: #ff6b35; font-size: 42px; margin-bottom: 30px; }
          .button {
            display: inline-block;
            padding: 20px 40px;
            margin: 15px;
            background: #ff6b35;
            color: white;
            text-decoration: none;
            border-radius: 12px;
            font-size: 20px;
            font-weight: bold;
            transition: all 0.3s;
            box-shadow: 0 5px 15px rgba(255,107,53,0.3);
          }
          .button:hover { 
            background: #e85a2a;
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(255,107,53,0.4);
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
          <h1>🍺 קיוסק החברים</h1>
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

// פונקציה ליצירת דוח יומי
async function generateDailyReport() {
  try {
    // שליפת 3 המוצרים הכי נמכרים של היום
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

    // שליפת סך ההכנסות של היום
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

    // בניית ההודעה
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

// תזמון שליחה אוטומטית כל יום ב-19:30
cron.schedule('30 19 * * *', async () => {
  console.log('⏰ מפיק דוח יומי אוטומטי...');

  const message = await generateDailyReport();

  if (message) {
    const phoneNumber = '972500000000'; // 🔴 שנה למספר שלך!
    const whatsappUrl = `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;

    console.log('📊 ════════════════════════════════════');
    console.log('✅ דוח יומי נוצר בהצלחה!');
    console.log('📅 תאריך:', new Date().toLocaleString('he-IL'));
    console.log('');
    console.log('📱 לשליחה לווטסאפ, לחץ על הקישור:');
    console.log(whatsappUrl);
    console.log('');
    console.log('🌐 או היכנס לדפדפן:');
    console.log('http://localhost:5001/send-daily-whatsapp');
    console.log('════════════════════════════════════');
  }
}, {
  timezone: "Asia/Jerusalem"
});

// שליחת התראה לכל הלקוחות המחוברים
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

// תזמון עם התראה
cron.schedule('30 19 * * *', async () => {
  console.log('⏰ מפיק דוח יומי אוטומטי...');
  const message = await generateDailyReport();

  if (message) {
    const phoneNumber = '972507559099'; // 🔴 שנה למספר שלך!
    const whatsappUrl = `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;

    console.log('📊 ════════════════════════════════════');
    console.log('✅ דוח יומי נוצר בהצלחה!');
    console.log('📅 תאריך:', new Date().toLocaleString('he-IL'));
    console.log('📱 קישור לשליחה:', whatsappUrl);
    console.log('════════════════════════════════════');

    // שליחת התראה
    await notifyDailyReport();
  }
}, {
  timezone: "Asia/Jerusalem"
});

server.listen(5001, () => {
  console.log('🚀 שרת רץ על http://localhost:5001');
  console.log('🎛️ ממשק ניהול: http://localhost:5001/admin');
  console.log('📸 תמונות מוגשות מ: public/images/');
});
